import yaml from "js-yaml";
import { parseNote, tagList } from "./frontmatter.mjs";
import { createFile, liveFiles, metaField, textOf } from "./vault.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const SNIPPET_CHARS = 1500;

function localDate(now) {
	const pad = (n) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Build the nightly request: every live markdown note edited in the last 24 h
 * (path, then the first 1500 chars), skipping the inbox, results and agent
 * output. Returns `{ path, text }`, or null when nothing changed.
 * cfg: { inboxDir, resultsDir, ensemble }
 */
export function composeGardenRequest({ ydoc, now, cfg }) {
	const meta = ydoc.getMap("meta");
	const since = now.getTime() - DAY_MS;
	const entries = [];
	for (const [path, fileId] of liveFiles(ydoc)) {
		if (!path.endsWith(".md")) continue;
		if (path.startsWith(cfg.inboxDir) || path.startsWith(cfg.resultsDir)) continue;
		const mtime = metaField(meta.get(fileId), "mtime");
		if (typeof mtime !== "number" || mtime < since) continue;
		const text = textOf(ydoc, fileId) ?? "";
		if (tagList(parseNote(text).frontmatter.tags).includes("agent")) continue;
		entries.push({ path, text: text.slice(0, SNIPPET_CHARS) });
	}
	if (entries.length === 0) return null;
	entries.sort((a, b) => a.path.localeCompare(b.path));
	const frontmatter = yaml.dump({ agent: cfg.ensemble }, { lineWidth: -1 }).trimEnd();
	const body = entries.map((e) => `${e.path}\n${e.text}`).join("\n---\n");
	return {
		path: `${cfg.inboxDir}garden-${localDate(now)}.md`,
		text: `---\n${frontmatter}\n---\n${body}\n`,
	};
}

/**
 * Once a day, at local hour `hour`, put the garden request in the inbox.
 * The note's existence is the "already done today" record. Returns the new
 * path, or null if nothing was created. Call only after the first sync, or a
 * note made by another peer will not be seen.
 */
export function gardenIfDue({ ydoc, now, hour, cfg }) {
	if (now.getHours() !== hour) return null;
	const request = composeGardenRequest({ ydoc, now, cfg });
	if (request === null) return null;
	if (liveFiles(ydoc).has(request.path)) return null;
	createFile(ydoc, request.path, request.text, cfg.device);
	return request.path;
}
