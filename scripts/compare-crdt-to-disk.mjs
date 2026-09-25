// Read-only: compare CRDT text against disk content for specific vault paths.
// Usage: node scripts/compare-crdt-to-disk.mjs <path> [<path>...]
import { join } from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

/** Vault to read. Override for another vault on the same machine. */
const VAULT = process.env.OG_CLOUD_VAULT ?? `${process.env.HOME}/Vaults/Svalbard`;

const require = createRequire(import.meta.url);
const Y = require("yjs");
const { default: YSyncProvider } = await import("y-partyserver/provider");
const WebSocket = require("ws");

const settings = JSON.parse(readFileSync(`${VAULT}/.obsidian/plugins/og-cloud/data.json`, "utf8"));
const { host, token, vaultId } = settings;
const wanted = process.argv.slice(2);

async function getTicket() {
	try {
		const res = await fetch(`${host}/vault/${encodeURIComponent(vaultId)}/auth/ticket`, {
			method: "POST", headers: { Authorization: `Bearer ${token}` },
		});
		if (!res.ok) return null;
		return (await res.json()).ticket ?? null;
	} catch { return null; }
}

const ticket = await getTicket();
const ydoc = new Y.Doc();
const provider = new YSyncProvider(host, vaultId, ydoc, {
	prefix: `/vault/sync/${encodeURIComponent(vaultId)}`,
	params: { schemaVersion: "3", device: "diag-readonly", ...(ticket ? { ticket } : { token }) },
	WebSocketPolyfill: WebSocket,
	connect: true,
});
await new Promise((res, rej) => {
	const t = setTimeout(() => rej(new Error("sync timeout")), 30_000);
	provider.on("synced", () => { clearTimeout(t); res(); });
	provider.on("sync", (s) => { if (s) { clearTimeout(t); res(); } });
}).catch((e) => { console.error(String(e)); provider.destroy(); process.exit(1); });
await new Promise((r) => setTimeout(r, 1500));

const meta = ydoc.getMap("meta");
const idToText = ydoc.getMap("idToText");
const byPath = new Map();
for (const [id, value] of meta.entries()) {
	const get = (k) => (value && typeof value.get === "function" ? value.get(k) : value?.[k]);
	const p = get("path");
	if (typeof p !== "string" || get("deleted") || get("deletedAt")) continue;
	byPath.set(p, id);
}

let mismatch = 0;
for (const path of wanted) {
	const id = byPath.get(path);
	if (!id) { console.log(`MISSING IN CRDT  ${path}`); mismatch++; continue; }
	const crdt = idToText.get(id)?.toString() ?? null;
	let disk = null;
	try { disk = readFileSync(join(VAULT, path), "utf8"); } catch { /* absent */ }
	if (disk === null) { console.log(`MISSING ON DISK  ${path}`); mismatch++; continue; }
	const same = crdt === disk;
	if (!same) mismatch++;
	console.log(`${same ? "match        " : "DIFFERS      "}  crdt=${crdt?.length ?? "-"} disk=${disk.length}  ${path}`);
}
console.log(`\n${wanted.length - mismatch}/${wanted.length} in agreement`);

provider.destroy();
ydoc.destroy();
process.exit(0);
