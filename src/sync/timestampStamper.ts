/**
 * Timestamp stamper: OG Cloud maintains `created` / `modified` frontmatter
 * as CRDT edits. See docs/timestamp-stamper.md.
 *
 * This module is Obsidian-free so it can be imported in Node suites.
 */
import { extractFrontmatter } from "./frontmatterGuard";

export interface TimestampEdit {
	from: number;
	to: number;
	insert: string;
}

const CREATED_KEY = "created";
const MODIFIED_KEY = "modified";

/**
 * Locate `key:` at the start of a line inside the frontmatter block.
 * Returns the absolute range of the value (after `key:` and any spaces, up
 * to but excluding the line break, CR excluded), or null if the key is absent.
 */
function findValueRange(
	text: string,
	blockStart: number,
	blockEnd: number,
	key: string,
): { from: number; to: number } | null {
	let lineStart = blockStart;
	while (lineStart < blockEnd) {
		let lineEnd = text.indexOf("\n", lineStart);
		if (lineEnd === -1 || lineEnd > blockEnd) lineEnd = blockEnd;
		let contentEnd = lineEnd;
		if (contentEnd > lineStart && text.charCodeAt(contentEnd - 1) === 13) contentEnd -= 1;
		const line = text.slice(lineStart, contentEnd);
		if (line.startsWith(`${key}:`)) {
			let from = lineStart + key.length + 1;
			while (from < contentEnd && text.charCodeAt(from) === 32) from += 1;
			return { from, to: contentEnd };
		}
		lineStart = lineEnd + 1;
	}
	return null;
}

export function computeTimestampEdits(
	text: string,
	now: string,
	options: { withCreated: boolean },
): TimestampEdit[] {
	const block = extractFrontmatter(text);
	if (block.kind === "malformed") return [];

	if (block.kind === "none") {
		const lines = options.withCreated
			? `${CREATED_KEY}: ${now}\n${MODIFIED_KEY}: ${now}\n`
			: `${MODIFIED_KEY}: ${now}\n`;
		return [{ from: 0, to: 0, insert: `---\n${lines}---\n` }];
	}

	const edits: TimestampEdit[] = [];
	const modified = findValueRange(text, block.start, block.end, MODIFIED_KEY);
	const created = options.withCreated
		? findValueRange(text, block.start, block.end, CREATED_KEY)
		: null;

	let append = "";
	if (options.withCreated && created === null) append += `${CREATED_KEY}: ${now}\n`;
	if (modified === null) append += `${MODIFIED_KEY}: ${now}\n`;
	if (append.length > 0) {
		edits.push({ from: block.end, to: block.end, insert: append });
	}
	if (modified !== null && text.slice(modified.from, modified.to) !== now) {
		let insert = now;
		// If range is empty and char before `from` is a colon (no space follows it),
		// prepend a space to avoid bare scalar in YAML (e.g., "modified:2026..." is invalid).
		if (
			modified.from === modified.to
			&& modified.from > 0
			&& text.charCodeAt(modified.from - 1) === 58
		) {
			insert = " " + now;
		}
		edits.push({ from: modified.from, to: modified.to, insert });
	}

	edits.sort((a, b) => b.from - a.from);
	return edits;
}
