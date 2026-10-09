// Headless inbox peer: joins the vault room as one more device, watches
// `inbox/*.md` for request notes whose frontmatter names an ensemble, runs the
// ensemble on llm-orc, and creates `results/<name>.md` in the CRDT. It never
// edits or deletes an existing note; "done" is the result note existing.
//
// Environment: OG_HOST, OG_VAULT_ID, OG_TOKEN (the plugin's settings),
// OG_DEVICE (name shown in file metadata), LLM_ORC_URL (default loopback serve),
// INBOX_DIR / RESULTS_DIR (default inbox/ and results/).
import * as Y from "yjs";
import YProvider from "y-partyserver/provider";
import yaml from "js-yaml";

const cfg = {
	host: process.env.OG_HOST,
	vaultId: process.env.OG_VAULT_ID,
	token: process.env.OG_TOKEN,
	device: process.env.OG_DEVICE ?? "headless-inbox",
	llmOrcUrl: (process.env.LLM_ORC_URL ?? "http://127.0.0.1:8765").replace(/\/$/, ""),
	inboxDir: (process.env.INBOX_DIR ?? "inbox").replace(/\/$/, "") + "/",
	resultsDir: (process.env.RESULTS_DIR ?? "results").replace(/\/$/, "") + "/",
	runTimeoutMs: Number(process.env.RUN_TIMEOUT_MS ?? 1_800_000),
};
if (!cfg.host || !cfg.vaultId || !cfg.token) {
	console.error("need OG_HOST, OG_VAULT_ID, OG_TOKEN");
	process.exit(2);
}

const SCHEMA_VERSION = 3; // src/sync/schema.ts
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function randomId(length) {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let out = "";
	for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] & 63];
	return out;
}
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- vault model (schema v3: meta.path is authoritative, pathToId is legacy) ----
const ydoc = new Y.Doc();
const meta = ydoc.getMap("meta");
const idToText = ydoc.getMap("idToText");

function metaField(entry, key) {
	return entry instanceof Y.Map ? entry.get(key) : entry?.[key];
}
/** path -> fileId for live (non-tombstoned) files. */
function liveFiles() {
	const out = new Map();
	for (const [id, entry] of meta) {
		const path = metaField(entry, "path");
		if (typeof path !== "string" || metaField(entry, "deletedAt")) continue;
		out.set(path, id);
	}
	return out;
}
function textOf(fileId) {
	const t = idToText.get(fileId);
	return t instanceof Y.Text ? t.toString() : null;
}
/** Create a new markdown file the way VaultSync.ensureFile does. Refuses an existing path. */
function createFile(path, body) {
	for (const [, entry] of meta) {
		if (metaField(entry, "path") === path) throw new Error(`${path} already exists in the vault`);
	}
	const fileId = randomId(16);
	const ytext = new Y.Text();
	ydoc.transact(() => {
		ytext.insert(0, body);
		idToText.set(fileId, ytext);
		const entry = new Y.Map();
		entry.set("path", path);
		entry.set("mtime", Date.now());
		entry.set("device", cfg.device);
		meta.set(fileId, entry);
	}, "headless-inbox");
	return fileId;
}

// ---- request notes ----
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
function parseNote(text) {
	const m = text.match(FRONTMATTER);
	if (!m) return { frontmatter: {}, body: text };
	let frontmatter = {};
	try {
		const parsed = yaml.load(m[1]);
		if (parsed && typeof parsed === "object") frontmatter = parsed;
	} catch (err) {
		return { frontmatter: {}, body: text, error: `frontmatter: ${err.message}` };
	}
	return { frontmatter, body: text.slice(m[0].length) };
}
function requestName(path) {
	return path.slice(cfg.inboxDir.length).replace(/\.md$/, "");
}
function resultPath(name) {
	return `${cfg.resultsDir}${name}.md`;
}

// ---- llm-orc ----
async function runEnsemble(name, input) {
	const res = await fetch(`${cfg.llmOrcUrl}/api/ensembles/${encodeURIComponent(name)}/execute`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ input }),
		signal: AbortSignal.timeout(cfg.runTimeoutMs),
	});
	const text = await res.text();
	let envelope;
	try {
		envelope = JSON.parse(text);
	} catch {
		throw new Error(`llm-orc ${res.status}: ${text.slice(0, 300)}`);
	}
	if (!res.ok) throw new Error(`llm-orc ${res.status}: ${JSON.stringify(envelope).slice(0, 300)}`);
	return envelope;
}

// ---- result notes ----
function resultNote({ name, requestPath, ensemble, envelope, error, startedAt, finishedAt }) {
	const status = error ? "error" : envelope?.status ?? "unknown";
	const fm = {
		type: "log",
		tags: ["agent", "ai-tools"],
		created: finishedAt.toISOString().slice(0, 10),
		request: `[[${requestPath.replace(/\.md$/, "")}]]`,
		ensemble,
		status,
		duration_s: Math.round((finishedAt - startedAt) / 1000),
		runner: cfg.device,
	};
	const lines = ["---", yaml.dump(fm, { lineWidth: -1, flowLevel: 1 }).trimEnd(), "---", "", `# ${name}`, ""];
	if (error) {
		lines.push("## Error", "", "```", String(error), "```", "");
	} else {
		const deliverable = envelope.deliverable;
		const out = typeof deliverable === "string" ? deliverable : "```json\n" + JSON.stringify(deliverable, null, 2) + "\n```";
		lines.push(out.trimEnd(), "");
		const agents = envelope.results ?? {};
		const rows = Object.entries(agents).map(([agent, r]) => `| ${agent} | ${r?.status ?? ""} |`);
		if (rows.length) lines.push("## Agents", "", "| agent | status |", "| --- | --- |", ...rows, "");
	}
	return lines.join("\n");
}

// ---- the loop ----
const inFlight = new Set();
let scanTimer = null;

async function handleRequest(path, fileId) {
	const name = requestName(path);
	const text = textOf(fileId);
	if (text === null) return;
	const { frontmatter, body, error: fmError } = parseNote(text);
	const ensemble = typeof frontmatter.agent === "string" ? frontmatter.agent.trim() : null;
	if (!ensemble && !fmError) return; // not a request (or not finished being typed)

	inFlight.add(path);
	const startedAt = new Date();
	log(`request ${path} -> ensemble ${ensemble ?? "?"}`);
	let envelope = null;
	let error = fmError ?? null;
	if (!error) {
		try {
			envelope = await runEnsemble(ensemble, body.trim());
		} catch (err) {
			error = err.message;
		}
	}
	const finishedAt = new Date();
	try {
		const target = resultPath(name);
		if (liveFiles().has(target)) {
			log(`result ${target} appeared meanwhile; not overwriting`);
		} else {
			createFile(target, resultNote({ name, requestPath: path, ensemble: ensemble ?? "", envelope, error, startedAt, finishedAt }));
			log(`result ${target} (${error ? "error" : envelope?.status}, ${Math.round((finishedAt - startedAt) / 1000)} s)`);
		}
	} catch (err) {
		log(`could not write result for ${path}: ${err.message}`);
	} finally {
		inFlight.delete(path);
	}
}

function scan() {
	const files = liveFiles();
	for (const [path, fileId] of files) {
		if (!path.startsWith(cfg.inboxDir) || !path.endsWith(".md")) continue;
		if (inFlight.has(path)) continue;
		if (files.has(resultPath(requestName(path)))) continue; // done
		void handleRequest(path, fileId);
	}
}
function scheduleScan() {
	clearTimeout(scanTimer);
	scanTimer = setTimeout(scan, 2000); // let a note settle before reading it
}

const provider = new YProvider(cfg.host, cfg.vaultId, ydoc, {
	prefix: `/vault/sync/${encodeURIComponent(cfg.vaultId)}`,
	params: async () => ({ schemaVersion: String(SCHEMA_VERSION), device: cfg.device, token: cfg.token }),
	connect: false,
});
provider.on("status", (e) => log("provider", e.status));
provider.on("connection-error", (e) => log("connection-error", e?.message ?? e));
provider.on("synced", () => {
	log(`synced: ${liveFiles().size} live files`);
	scheduleScan();
});
meta.observeDeep(scheduleScan);
idToText.observeDeep(scheduleScan);

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		log(`${sig}: disconnecting`);
		provider.disconnect();
		provider.destroy();
		process.exit(0);
	});
}

log(`inbox peer ${cfg.device}: ${cfg.inboxDir} -> ${cfg.resultsDir} via ${cfg.llmOrcUrl}`);
provider.connect();
