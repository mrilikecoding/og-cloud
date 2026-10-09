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
import { createInbox } from "./lib/inbox.mjs";
import { runEnsemble } from "./lib/llmOrc.mjs";
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
};
if (!cfg.host || !cfg.vaultId || !cfg.token) {
	console.error("need OG_HOST, OG_VAULT_ID, OG_TOKEN");
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
provider.on("synced", () => {
	log(`synced: ${liveFiles(ydoc).size} live files`);
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
