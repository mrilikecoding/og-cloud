// Step-2 probe: create one markdown file in the vault CRDT from Node, the way
// VaultSync.ensureFile does (idToText + nested meta), and leave it to the other
// devices to materialize. Usage: node create-probe.mjs <path> < body. Throwaway.
import * as Y from "yjs";
import YProvider from "y-partyserver/provider";
import { readFileSync } from "node:fs";

const host = process.env.OG_HOST;
const vaultId = process.env.OG_VAULT_ID;
const token = process.env.OG_TOKEN;
const device = process.env.OG_DEVICE ?? "headless-probe";
const path = process.argv[2];
if (!host || !vaultId || !token || !path) {
	console.error("need OG_HOST, OG_VAULT_ID, OG_TOKEN and a path argument; body on stdin");
	process.exit(2);
}
const body = readFileSync(0, "utf8");

const SCHEMA_VERSION = 3; // src/sync/schema.ts
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function randomId(length) {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let out = "";
	for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] & 63];
	return out;
}

const ydoc = new Y.Doc();
const provider = new YProvider(host, vaultId, ydoc, {
	prefix: `/vault/sync/${encodeURIComponent(vaultId)}`,
	params: async () => ({ schemaVersion: String(SCHEMA_VERSION), device, token }),
	connect: false,
});
provider.on("status", (e) => console.log("status:", e.status));
provider.on("connection-error", (e) => console.log("connection-error:", e?.message ?? e));

const synced = new Promise((resolve) => provider.on("synced", resolve));
const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error("sync timeout 30s")), 30_000));

provider.connect();
try {
	await Promise.race([synced, deadline]);
	const meta = ydoc.getMap("meta");
	const idToText = ydoc.getMap("idToText");

	// Refuse when the path is live or tombstoned: the peer creates, it never revives or overwrites.
	for (const [id, m] of meta) {
		const p = m instanceof Y.Map ? m.get("path") : m?.path;
		if (p !== path) continue;
		const deleted = m instanceof Y.Map ? m.get("deletedAt") : m?.deletedAt;
		throw new Error(`${path} already exists (id ${id}, ${deleted ? "tombstoned" : "live"})`);
	}

	const fileId = randomId(16);
	const ytext = new Y.Text();
	ydoc.transact(() => {
		ytext.insert(0, body);
		idToText.set(fileId, ytext);
		const entry = new Y.Map();
		entry.set("path", path);
		entry.set("mtime", Date.now());
		entry.set("device", device);
		meta.set(fileId, entry);
	}, "headless-probe");
	console.log(`created ${path} (id ${fileId}, ${body.length} chars)`);

	// Give the provider time to flush the update and receive the server echo.
	await new Promise((r) => setTimeout(r, 3000));
} catch (err) {
	console.error("FAILED:", err.message);
	process.exitCode = 1;
} finally {
	provider.disconnect();
	provider.destroy();
	ydoc.destroy();
	setTimeout(() => process.exit(), 200);
}
