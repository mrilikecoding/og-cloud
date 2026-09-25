// Read-only scan of the og-cloud vault CRDT: duplicate-path entries, per-device
// counts, active entries missing their Y.Text, and conflict artifacts that
// leaked into the CRDT. Connects like the plugin, never writes, never prints
// the token. Run from the og-cloud checkout so its node_modules resolve.

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
const SCHEMA_VERSION = 3;

async function getTicket() {
	try {
		const res = await fetch(`${host}/vault/${encodeURIComponent(vaultId)}/auth/ticket`, {
			method: "POST", headers: { Authorization: `Bearer ${token}` },
		});
		if (!res.ok) return null;
		const body = await res.json();
		return typeof body.ticket === "string" ? body.ticket : null;
	} catch { return null; }
}

const ticket = await getTicket();
const ydoc = new Y.Doc();
const provider = new YSyncProvider(host, vaultId, ydoc, {
	prefix: `/vault/sync/${encodeURIComponent(vaultId)}`,
	params: { schemaVersion: String(SCHEMA_VERSION), device: "diag-readonly", ...(ticket ? { ticket } : { token }) },
	WebSocketPolyfill: WebSocket,
	connect: true,
});

await new Promise((resolve, reject) => {
	const t = setTimeout(() => reject(new Error("sync timeout (30s)")), 30_000);
	provider.on("synced", () => { clearTimeout(t); resolve(); });
	provider.on("sync", (s) => { if (s) { clearTimeout(t); resolve(); } });
	provider.on("connection-error", (e) => { clearTimeout(t); reject(new Error("connection-error: " + (e?.message ?? String(e)))); });
}).catch((e) => { console.error(String(e)); provider.destroy(); process.exit(1); });
await new Promise((r) => setTimeout(r, 1500));

const meta = ydoc.getMap("meta");
const idToText = ydoc.getMap("idToText");
const iso = (ms) => (typeof ms === "number" ? new Date(ms).toISOString() : String(ms));

const byPath = new Map();
const byDevice = new Map();
let active = 0, deleted = 0, missingText = 0;
for (const [id, value] of meta.entries()) {
	const get = (k) => (value && typeof value.get === "function" ? value.get(k) : (value && typeof value === "object" ? value[k] : undefined));
	const path = get("path");
	if (typeof path !== "string") continue;
	if (get("deleted") || get("deletedAt")) { deleted++; continue; }
	active++;
	const dev = get("device") ?? "(none)";
	byDevice.set(dev, (byDevice.get(dev) ?? 0) + 1);
	const text = idToText.get(id);
	if (!text) missingText++;
	if (!byPath.has(path)) byPath.set(path, []);
	byPath.get(path).push({ id, device: dev, mtime: iso(get("mtime")), textChars: text && typeof text.length === "number" ? text.length : "MISSING" });
}

console.log(`meta entries=${meta.size} active=${active} tombstoned=${deleted} activeWithoutText=${missingText}`);
console.log("active entries by device:", JSON.stringify(Object.fromEntries(byDevice)));
const dupes = [...byPath.entries()].filter(([, v]) => v.length > 1);
console.log(`paths with >1 active entry: ${dupes.length}`);
for (const [path, v] of dupes.slice(0, 30)) {
	console.log("DUP", path);
	for (const e of v) console.log("   ", JSON.stringify(e));
}
const conflictPaths = [...byPath.keys()].filter((p) => p.includes("YAOS conflict"));
console.log(`active conflict-artifact paths in CRDT: ${conflictPaths.length}`);
for (const p of conflictPaths) console.log("   ", p);

provider.destroy();
ydoc.destroy();
process.exit(0);
