// Co-writer probe (sub-project 3, step 1): while the owner types in a note on
// another device, insert one named footnote reference after a phrase and
// upsert its footnote in an agent-owned region at the bottom. No model, no
// disk. Inserts only; nothing of the owner's text is deleted. Throwaway.
//
//   OG_HOST=... OG_VAULT_ID=... OG_TOKEN=... node cowriter-probe.mjs \
//     "Notes/Scratch/cowriter.md" "phrase to anchor on" test "The footnote text."
//
// Prints the owner's cursor from awareness when a device has the note open.
import * as Y from "yjs";
import YProvider from "y-partyserver/provider";

const [path, phrase, refId, footnote] = process.argv.slice(2);
const { OG_HOST: host, OG_VAULT_ID: vaultId, OG_TOKEN: token } = process.env;
if (!host || !vaultId || !token || !path || !phrase || !refId || !footnote) {
	console.error("usage: cowriter-probe.mjs <note path> <anchor phrase> <ref id> <footnote text>; env OG_HOST OG_VAULT_ID OG_TOKEN");
	process.exit(2);
}
const device = process.env.OG_DEVICE ?? "cowriter-probe";
const REGION_OPEN = "<!-- footnotes: agent -->";
const REGION_CLOSE = "<!-- /footnotes -->";

const ydoc = new Y.Doc();
const provider = new YProvider(host, vaultId, ydoc, {
	prefix: `/vault/sync/${encodeURIComponent(vaultId)}`,
	params: async () => ({ schemaVersion: "3", device, token }),
	connect: false,
});
const meta = ydoc.getMap("meta");
const idToText = ydoc.getMap("idToText");

function fileIdFor(p) {
	for (const [id, m] of meta) if (m instanceof Y.Map && m.get("path") === p && !m.get("deletedAt")) return id;
	return null;
}
function describeCursors(ytext) {
	for (const [client, state] of provider.awareness.getStates()) {
		if (client === ydoc.clientID || !state?.cursor) continue;
		const anchor = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.cursor.anchor), ydoc);
		const inThisNote = anchor?.type === ytext;
		console.log(`cursor: ${state.user?.name ?? client} at offset ${anchor?.index ?? "?"} ${inThisNote ? "in this note" : "in another note"}`);
	}
}

provider.on("synced", () => {
	try {
		const fileId = fileIdFor(path);
		if (!fileId) throw new Error(`${path} is not a live note`);
		const ytext = idToText.get(fileId);
		const text = ytext.toString();
		describeCursors(ytext);

		const marker = `[^${refId}]`;
		const at = text.indexOf(phrase);
		if (at < 0) throw new Error(`phrase not found in ${path}`);
		const refAt = at + phrase.length;
		const alreadyRef = text.slice(refAt, refAt + marker.length) === marker;

		// Region upsert: replace only the one footnote line inside the region, or append a region.
		const line = `${marker}: ${footnote}`;
		const open = text.indexOf(REGION_OPEN);
		const close = open >= 0 ? text.indexOf(REGION_CLOSE, open) : -1;
		ydoc.transact(() => {
			if (!alreadyRef) ytext.insert(refAt, marker);
			const shifted = alreadyRef ? 0 : marker.length; // region sits after the anchor
			if (open >= 0 && close > open) {
				const regionStart = open + shifted, regionEnd = close + shifted;
				const region = ytext.toString().slice(regionStart, regionEnd);
				const existing = region.indexOf(`${marker}: `);
				if (existing >= 0) {
					const lineStart = regionStart + existing;
					const lineEnd = ytext.toString().indexOf("\n", lineStart);
					ytext.delete(lineStart, (lineEnd < 0 ? regionEnd : lineEnd) - lineStart);
					ytext.insert(lineStart, line);
				} else {
					ytext.insert(regionEnd, `${line}\n`);
				}
			} else {
				const end = ytext.length;
				const sep = ytext.toString().endsWith("\n") ? "\n" : "\n\n";
				ytext.insert(end, `${sep}${REGION_OPEN}\n${line}\n${REGION_CLOSE}\n`);
			}
		}, "cowriter-probe");
		console.log(`${alreadyRef ? "ref already present" : "inserted " + marker} after "${phrase}"; footnote upserted`);
		console.log(`structs in doc: ${ydoc.store.clients.size} clients`);
	} catch (err) {
		console.error("FAILED:", err.message);
		process.exitCode = 1;
	}
	setTimeout(() => { provider.disconnect(); provider.destroy(); process.exit(); }, 3000);
});
provider.connect();
