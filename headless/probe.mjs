// Step-1 probe: can a non-Obsidian client join the vault room and read it?
// Reads OG_HOST, OG_VAULT_ID, OG_TOKEN, OG_DEVICE from the environment.
// Prints the file list and the sys map, then disconnects. Throwaway.
import * as Y from "yjs";
import YProvider from "y-partyserver/provider";

const host = process.env.OG_HOST;
const vaultId = process.env.OG_VAULT_ID;
const token = process.env.OG_TOKEN;
const device = process.env.OG_DEVICE ?? "headless-probe";
if (!host || !vaultId || !token) {
	console.error("need OG_HOST, OG_VAULT_ID, OG_TOKEN");
	process.exit(2);
}

const SCHEMA_VERSION = 3; // src/sync/schema.ts

const ydoc = new Y.Doc();
const provider = new YProvider(host, vaultId, ydoc, {
	prefix: `/vault/sync/${encodeURIComponent(vaultId)}`,
	params: async () => ({ schemaVersion: String(SCHEMA_VERSION), device, token }),
	connect: false,
});

provider.on("status", (e) => console.log("status:", e.status));
provider.on("connection-error", (e) => console.log("connection-error:", e?.message ?? e));
provider.on("connection-close", (e) => console.log("connection-close:", e?.code, e?.reason));
provider.on("custom-message", (m) => console.log("custom-message:", JSON.stringify(m).slice(0, 300)));

const synced = new Promise((resolve) => provider.on("synced", resolve));
const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error("sync timeout 30s")), 30_000));

provider.connect();
try {
	await Promise.race([synced, deadline]);
	const sys = ydoc.getMap("sys");
	const meta = ydoc.getMap("meta");
	const idToText = ydoc.getMap("idToText");
	const pathToId = ydoc.getMap("pathToId");
	console.log("synced. sys:", JSON.stringify(sys.toJSON()));
	console.log(`meta entries: ${meta.size}, idToText: ${idToText.size}, pathToId: ${pathToId.size}`);
	const paths = [];
	for (const [id, m] of meta) {
		const path = m instanceof Y.Map ? m.get("path") : m?.path;
		const deleted = m instanceof Y.Map ? m.get("deletedAt") : m?.deletedAt;
		if (path && !deleted) paths.push(path);
	}
	paths.sort();
	console.log(`live markdown files: ${paths.length}`);
	for (const p of paths.filter((p) => p.startsWith("inbox/") || p.startsWith("results/") || !p.includes("/")).slice(0, 40)) console.log("  ", p);
	const sample = paths.find((p) => p === "README.md");
	if (sample) {
		const id = pathToId.get(sample);
		const text = id ? idToText.get(id) : null;
		console.log(`README.md -> id ${id}, ${text ? text.length : "?"} chars, first line: ${text ? text.toString().split("\n")[0] : ""}`);
	}
} catch (err) {
	console.error("FAILED:", err.message);
	process.exitCode = 1;
} finally {
	provider.disconnect();
	provider.destroy();
	ydoc.destroy();
	setTimeout(() => process.exit(), 200);
}
