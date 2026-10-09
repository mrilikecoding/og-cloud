// Vault model (schema v3: meta.path is authoritative, pathToId is legacy).
import * as Y from "yjs";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function randomId(length) {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let out = "";
	for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] & 63];
	return out;
}

export function metaField(entry, key) {
	return entry instanceof Y.Map ? entry.get(key) : entry?.[key];
}

/** path -> fileId for live (non-tombstoned) files. */
export function liveFiles(ydoc) {
	const out = new Map();
	for (const [id, entry] of ydoc.getMap("meta")) {
		const path = metaField(entry, "path");
		if (typeof path !== "string" || metaField(entry, "deletedAt")) continue;
		out.set(path, id);
	}
	return out;
}

export function textOf(ydoc, fileId) {
	const t = ydoc.getMap("idToText").get(fileId);
	return t instanceof Y.Text ? t.toString() : null;
}

/** Create a new markdown file the way VaultSync.ensureFile does. Refuses an existing (live or tombstoned) path. */
export function createFile(ydoc, path, body, device) {
	const meta = ydoc.getMap("meta");
	const idToText = ydoc.getMap("idToText");
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
		entry.set("device", device);
		meta.set(fileId, entry);
	}, "headless-inbox");
	return fileId;
}
