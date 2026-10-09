// Headless inbox peer: joins the vault room as one more device, watches
// `inbox/*.md` for request notes whose frontmatter names an ensemble, runs the
// ensemble on llm-orc, and creates `results/<name>.md` in the CRDT. It never
// edits or deletes an existing note; "done" is the result note existing.
//
// Environment: OG_HOST, OG_VAULT_ID, OG_TOKEN (the plugin's settings),
// OG_DEVICE (name shown in file metadata), LLM_ORC_URL (default loopback serve),
// INBOX_DIR / RESULTS_DIR (default inbox/ and results/).
// Optional nightly request: GARDEN_HOUR (0-23, local time), GARDEN_ENSEMBLE
// (default vault-gardener).
import * as Y from "yjs";
import YProvider from "y-partyserver/provider";
import { createInbox } from "./lib/inbox.mjs";
import { runEnsemble } from "./lib/llmOrc.mjs";
import { shutdown } from "./lib/shutdown.mjs";
import { gardenIfDue } from "./lib/gardener.mjs";
import { liveFiles } from "./lib/vault.mjs";

const cfg = {
	host: process.env.OG_HOST,
	vaultId: process.env.OG_VAULT_ID,
	token: process.env.OG_TOKEN,
	device: process.env.OG_DEVICE ?? "headless-inbox",
	llmOrcUrl: (process.env.LLM_ORC_URL ?? "http://127.0.0.1:8765").replace(/\/$/, ""),
	inboxDir: (process.env.INBOX_DIR ?? "inbox").replace(/\/$/, "") + "/",
	resultsDir: (process.env.RESULTS_DIR ?? "results").replace(/\/$/, "") + "/",
	runTimeoutMs: Number(process.env.RUN_TIMEOUT_MS ?? 1_800_000),
	gardenHour: process.env.GARDEN_HOUR === undefined ? null : Number(process.env.GARDEN_HOUR),
	gardenEnsemble: process.env.GARDEN_ENSEMBLE ?? "vault-gardener",
};
if (!cfg.host || !cfg.vaultId || !cfg.token) {
	console.error("need OG_HOST, OG_VAULT_ID, OG_TOKEN");
	process.exit(2);
}

if (cfg.gardenHour !== null && !(Number.isInteger(cfg.gardenHour) && cfg.gardenHour >= 0 && cfg.gardenHour <= 23)) {
	console.error("GARDEN_HOUR must be an integer from 0 to 23");
	process.exit(2);
}

const SCHEMA_VERSION = 3; // src/sync/schema.ts
const log = (...a) => console.log(new Date().toISOString(), ...a);

const ydoc = new Y.Doc();
const meta = ydoc.getMap("meta");
const idToText = ydoc.getMap("idToText");

const inbox = createInbox({
	ydoc,
	cfg,
	log,
	run: (ensemble, input) =>
		runEnsemble({ url: cfg.llmOrcUrl, name: ensemble, input, timeoutMs: cfg.runTimeoutMs }),
});

let scanTimer = null;
function scheduleScan() {
	clearTimeout(scanTimer);
	scanTimer = setTimeout(() => void inbox.scan(), 2000); // let a note settle before reading it
}

const provider = new YProvider(cfg.host, cfg.vaultId, ydoc, {
	prefix: `/vault/sync/${encodeURIComponent(cfg.vaultId)}`,
	params: async () => ({ schemaVersion: String(SCHEMA_VERSION), device: cfg.device, token: cfg.token }),
	connect: false,
});
provider.on("status", (e) => log("provider", e.status));
provider.on("connection-error", (e) => log("connection-error", e?.message ?? e));
let synced = false;
provider.on("synced", () => {
	synced = true;
	log(`synced: ${liveFiles(ydoc).size} live files`);
	scheduleScan();
});

// The garden request is an ordinary inbox note; the loop above picks it up.
// Only tick once synced, so a note made by another peer is seen first.
let gardenTimer = null;
if (cfg.gardenHour !== null) {
	gardenTimer = setInterval(() => {
		if (!synced) return;
		try {
			const path = gardenIfDue({
				ydoc,
				now: new Date(),
				hour: cfg.gardenHour,
				cfg: { ...cfg, ensemble: cfg.gardenEnsemble },
			});
			if (path) log(`garden request ${path}`);
		} catch (err) {
			log(`could not create garden request: ${err.message}`);
		}
	}, 60_000);
}
meta.observeDeep(scheduleScan);
idToText.observeDeep(scheduleScan);

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		if (stopping) return;
		stopping = true;
		clearInterval(gardenTimer);
		log(`${sig}: waiting up to 10 s for in-flight results`);
		void shutdown({
			inbox,
			log,
			timeoutMs: 10_000,
			disconnect: () => {
				provider.disconnect();
				provider.destroy();
				process.exit(0);
			},
		});
	});
}

log(`inbox peer ${cfg.device}: ${cfg.inboxDir} -> ${cfg.resultsDir} via ${cfg.llmOrcUrl}`);
provider.connect();
