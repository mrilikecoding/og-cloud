// Regression (2026-09-21): binding an editor must never seed the CRDT from
// the editor's current text.
//
// On Cmd+N in an occupied leaf, Obsidian fires active-leaf-change with
// view.file already pointing at the new note while the CodeMirror doc still
// holds the previous note. bind() found no Y.Text for the new path and
// called ensureFile(path, view.editor.getValue()), so the new note's CRDT
// entry was born holding a full copy of whatever note was open before it.
// Obsidian then loaded the real (empty) doc, the facet was dropped and
// re-applied, and every later keystroke or paste landed on top of the ghost
// copy. Every "(YAOS conflict - crdt ...)" artifact in the Svalbard vault
// between 09-17 and 09-19 has that shape: CRDT = previous note + typing.
//
// The rule now: only the vault create/modify handler seeds the CRDT, and it
// seeds from disk. When bind() finds no Y.Text it waits for one on a bounded
// retry instead of inventing one.

import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import type { EditorView } from "@codemirror/view";
import { EditorBindingManager } from "../../src/sync/editorBinding";
import type { VaultSync } from "../../src/sync/vaultSync";
import { suite } from "../harness.ts";

const s = suite("bind-never-seeds");

// ---------------------------------------------------------------------------
// Fake clock standing in for window.setTimeout / clearTimeout, which the
// binding manager uses for its retry timers. The harness aliases `window` to
// globalThis (configurable, so it can be redefined here); replacing only the
// alias keeps Node's real timers intact for the harness itself.
// ---------------------------------------------------------------------------

interface FakeTimer {
	id: number;
	at: number;
	fn: () => void;
	cleared: boolean;
}

const timers: FakeTimer[] = [];
let now = 0;
let nextTimerId = 1;

Object.defineProperty(globalThis, "window", {
	configurable: true,
	value: {
		setTimeout: (fn: () => void, ms: number): number => {
			const timer: FakeTimer = { id: nextTimerId++, at: now + ms, fn, cleared: false };
			timers.push(timer);
			return timer.id;
		},
		clearTimeout: (id: number): void => {
			const timer = timers.find((t) => t.id === id);
			if (timer) timer.cleared = true;
		},
	},
});

function advance(ms: number): void {
	const until = now + ms;
	for (;;) {
		const due = timers
			.filter((t) => !t.cleared && t.at <= until)
			.sort((a, b) => a.at - b.at)[0];
		if (!due) break;
		now = due.at;
		due.cleared = true;
		due.fn();
	}
	now = until;
}

function pendingTimers(): number {
	return timers.filter((t) => !t.cleared).length;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeView(path: string, editorText: string): MarkdownView {
	const file = new TFile();
	file.path = path;
	file.stat = { ctime: 1, mtime: 1, size: 0 };
	return Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
		file,
		leaf: { id: "leaf-1" },
		editor: { getValue: (): string => editorText },
		containerEl: { contains: (): boolean => true },
	});
}

function fixture(editorText: string) {
	const doc = new Y.Doc();
	const texts = new Map<string, Y.Text>();
	const ensureFileCalls: Array<{ path: string; content: string }> = [];

	const vaultSync = {
		getTextForPath: (path: string): Y.Text | null => texts.get(path) ?? null,
		ensureFile: (path: string, content: string): Y.Text => {
			ensureFileCalls.push({ path, content });
			const text = doc.getText(path);
			text.insert(0, content);
			texts.set(path, text);
			return text;
		},
		getFileId: (path: string): string | undefined =>
			texts.has(path) ? `id-${path}` : undefined,
		getFileIdForText: (): string | undefined => undefined,
		isMarkdownTombstoned: (): boolean => false,
		isPendingRenameTarget: (): boolean => false,
		provider: { awareness: { setLocalStateField: (): void => {} } },
	};

	const dispatched: unknown[] = [];
	const cm = {
		dispatch: (tr: { effects?: unknown }): void => { dispatched.push(tr.effects); },
		dom: { isConnected: true },
		state: { facet: (): undefined => undefined, doc: { length: 0 } },
	};

	const workspace = { getActiveViewOfType: (): null => null };
	const manager = new EditorBindingManager(
		vaultSync as unknown as VaultSync,
		workspace as never,
		false,
	);
	// bind() resolves its CodeMirror view through the live DOM; pin it to the
	// fake so the test exercises target resolution, not view lookup.
	(manager as unknown as { getCmView: () => EditorView }).getCmView =
		() => cm as unknown as EditorView;

	/** What the vault create handler does: seed the path's Y.Text from disk. */
	const seedFromDisk = (path: string, content: string): void => {
		const text = doc.getText(path);
		text.insert(0, content);
		texts.set(path, text);
	};

	return { manager, vaultSync, ensureFileCalls, dispatched, seedFromDisk, texts };
}

const NEW_NOTE = "Notes/Untitled.md";
const STALE_EDITOR_TEXT = "--- previous note, still in the editor ---";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

s.section("Test 1: bind never seeds the CRDT from the editor");
{
	const f = fixture(STALE_EDITOR_TEXT);
	f.manager.bind(makeView(NEW_NOTE, STALE_EDITOR_TEXT), "device-test");

	s.check(f.ensureFileCalls.length === 0, "ensureFile was not called from bind");
	s.check(!f.texts.has(NEW_NOTE), "no Y.Text was created for the new note");
	s.check(!f.manager.isBound(NEW_NOTE), "the note is not bound while its Y.Text is missing");
	s.check(f.dispatched.length === 0, "no collab extension was applied to the editor");
}

s.section("Test 2: bind retries and binds once the Y.Text exists");
{
	const f = fixture("");
	f.manager.bind(makeView(NEW_NOTE, ""), "device-test");
	s.check(!f.manager.isBound(NEW_NOTE), "not bound before the seed lands");

	f.seedFromDisk(NEW_NOTE, "");
	// Enough for the bind retry, short of the post-bind health check (850ms),
	// which would inspect the fake editor's collab state and start repairing.
	advance(500);

	s.check(f.manager.isBound(NEW_NOTE), "bound within 500ms of the disk seed appearing");
	s.check(f.dispatched.length === 1, "collab extension applied exactly once");
	s.check(f.ensureFileCalls.length === 0, "ensureFile still never called from the editor");
	s.check(f.texts.get(NEW_NOTE)?.toString() === "", "the bound Y.Text is the disk-seeded one, untouched");
}

s.section("Test 3: bind gives up after the retry cap without inventing a Y.Text");
{
	const f = fixture(STALE_EDITOR_TEXT);
	f.manager.bind(makeView(NEW_NOTE, STALE_EDITOR_TEXT), "device-test");

	advance(60_000);

	s.check(!f.manager.isBound(NEW_NOTE), "still not bound when no seed ever arrives");
	s.check(f.ensureFileCalls.length === 0, "ensureFile never called even after giving up");
	s.check(!f.texts.has(NEW_NOTE), "no Y.Text invented after giving up");
	s.check(pendingTimers() === 0, "no retry timer left running");
}

s.section("Test 4: unbindAll cancels a pending retry so nothing binds after unload");
{
	const f = fixture("");
	f.manager.bind(makeView(NEW_NOTE, ""), "device-test");
	s.check(pendingTimers() === 1, "a retry is pending before unload");

	f.manager.unbindAll();
	s.check(pendingTimers() === 0, "unbindAll cleared the pending retry");

	f.seedFromDisk(NEW_NOTE, "");
	advance(60_000);
	s.check(!f.manager.isBound(NEW_NOTE), "nothing bound after unload even though a seed arrived");
	s.check(f.dispatched.length === 0, "no collab extension applied after unload");
}

void s.done();
