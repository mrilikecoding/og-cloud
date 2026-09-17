/**
 * Timestamp stamper: OG Cloud maintains `created` / `modified` frontmatter
 * as CRDT edits. See docs/timestamp-stamper.md.
 *
 * This module is Obsidian-free so it can be imported in Node suites.
 */
import * as Y from "yjs";
import { extractFrontmatter } from "./frontmatterGuard";
import { ORIGIN_TIMESTAMP } from "./origins";

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

export const TIMESTAMP_DEBOUNCE_MS = 2000;

export interface TimestampStamperDeps {
	/** True for a transaction made by the user typing (y-codemirror's YSyncConfig). */
	isUserOrigin(origin: unknown): boolean;
	/** Current time already formatted as YYYY-MM-DDTHH:mm:ssZ. */
	now(): string;
	isEnabled(): boolean;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	log?(message: string): void;
	trace?(source: string, event: string, data?: Record<string, unknown>): void;
}

interface WatchEntry {
	path: string;
	refs: number;
	handler: (event: Y.YTextEvent, txn: Y.Transaction) => void;
	timer: unknown;
	bornEmpty: boolean;
	/** Path this entry's born-empty status was read under; used to consume it from bornEmptyPaths even if `path` is later renamed. */
	bornEmptyPath: string;
}

export class TimestampStamper {
	private readonly entries = new Map<Y.Text, WatchEntry>();
	private readonly bornEmptyPaths = new Set<string>();
	private disposed = false;

	constructor(private readonly deps: TimestampStamperDeps) {}

	markBornEmpty(path: string): void {
		this.bornEmptyPaths.add(path);
	}

	watch(ytext: Y.Text, path: string): void {
		if (this.disposed) return;
		const existing = this.entries.get(ytext);
		if (existing) {
			existing.refs += 1;
			existing.path = path;
			return;
		}
		const entry: WatchEntry = {
			path,
			refs: 1,
			handler: (_event, txn) => this.onTransaction(ytext, txn),
			timer: null,
			bornEmpty: this.bornEmptyPaths.has(path),
			bornEmptyPath: path,
		};
		ytext.observe(entry.handler);
		this.entries.set(ytext, entry);
	}

	unwatch(ytext: Y.Text): void {
		const entry = this.entries.get(ytext);
		if (!entry) return;
		entry.refs -= 1;
		if (entry.refs > 0) return;
		ytext.unobserve(entry.handler);
		this.entries.delete(ytext);
		if (entry.timer !== null) {
			this.deps.clearTimeout(entry.timer);
			entry.timer = null;
			if (!this.disposed) this.stamp(ytext, entry, "unwatch-flush");
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const [ytext, entry] of this.entries) {
			if (entry.timer !== null) this.deps.clearTimeout(entry.timer);
			entry.timer = null;
			ytext.unobserve(entry.handler);
		}
		this.entries.clear();
		this.bornEmptyPaths.clear();
	}

	private onTransaction(ytext: Y.Text, txn: Y.Transaction): void {
		if (this.disposed) return;
		if (!this.deps.isEnabled()) return;
		if (!this.deps.isUserOrigin(txn.origin)) return;
		const entry = this.entries.get(ytext);
		if (!entry) return;
		if (entry.timer !== null) this.deps.clearTimeout(entry.timer);
		entry.timer = this.deps.setTimeout(() => {
			entry.timer = null;
			this.stamp(ytext, entry, "debounce");
		}, TIMESTAMP_DEBOUNCE_MS);
	}

	private stamp(ytext: Y.Text, entry: WatchEntry, reason: string): void {
		if (!this.deps.isEnabled()) return;
		const doc = ytext.doc;
		if (!doc) return;
		const withCreated = entry.bornEmpty;
		const edits = computeTimestampEdits(ytext.toJSON(), this.deps.now(), { withCreated });
		if (edits.length === 0) return;
		entry.bornEmpty = false;
		if (withCreated) this.bornEmptyPaths.delete(entry.bornEmptyPath);
		doc.transact(() => {
			for (const edit of edits) {
				if (edit.to > edit.from) ytext.delete(edit.from, edit.to - edit.from);
				ytext.insert(edit.from, edit.insert);
			}
		}, ORIGIN_TIMESTAMP);
		this.deps.log?.(`stamper: stamped "${entry.path}" (${reason}${withCreated ? ", created" : ""})`);
		this.deps.trace?.("timestamp", "timestamp-stamped", {
			path: entry.path,
			reason,
			withCreated,
			editCount: edits.length,
		});
	}
}
