// Regression (2026-10-03, SYNC-03): edits made while the editor has no collab
// binding must not be lost to the CRDT, and a rename must not open such a gap.
//
// Both conflict-artifact incidents (Snakes 09-30, Freewrite 10-03) were notes
// created as Untitled and renamed. In each, the disk artifact begins with a
// newline byte the CRDT artifact lacks. Obsidian updates view.file.path before
// the rename batch updates the path map, so the health audit saw path-changed
// plus ytext-mismatch and forced an unbind and rebind, although the file id
// and Y.Text were unchanged. The rebind then waited about 180 ms for the path
// map, and what was typed in that window reached the editor and the disk but
// never the CRDT. The same gap exists after Cmd+N while bind waits for the
// disk seed (about 600 ms in the field).
//
// Two rules now. A rename of the bound file keeps its binding. And a user
// edit made while bind is waiting for a Y.Text is diffed into that Y.Text
// before yCollab attaches.

import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import type { EditorView } from "@codemirror/view";
import { EditorBindingManager } from "../../src/sync/editorBinding";
import type { VaultSync } from "../../src/sync/vaultSync";
import { suite } from "../harness.ts";

const s = suite("unbound-edits-and-rename-binding");

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

function fixture() {
	const doc = new Y.Doc();
	const texts = new Map<string, Y.Text>();
	let editorText = "";

	const vaultSync = {
		getTextForPath: (path: string): Y.Text | null => texts.get(path) ?? null,
		getFileId: (path: string): string | undefined =>
			texts.has(path) ? "file-1" : undefined,
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

	const manager = new EditorBindingManager(
		vaultSync as unknown as VaultSync,
		{ getActiveViewOfType: (): null => null } as never,
		false,
	);
	(manager as unknown as { getCmView: () => EditorView }).getCmView =
		() => cm as unknown as EditorView;

	const makeView = (path: string): MarkdownView => {
		const file = new TFile();
		file.path = path;
		file.stat = { ctime: 1, mtime: 1, size: 0 };
		return Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
			file,
			leaf: { id: "leaf-1" },
			editor: { getValue: (): string => editorText },
			containerEl: { contains: (): boolean => true },
		});
	};

	/** Seed a path's Y.Text the way the vault create handler does. */
	const seed = (path: string, content: string): Y.Text => {
		const text = doc.getText(path);
		text.insert(0, content);
		texts.set(path, text);
		return text;
	};

	/** Feed the manager's live-update listener one editor update. */
	const editorUpdate = (next: string, userEvent: string | null): void => {
		editorText = next;
		(manager as unknown as { handleLiveEditorUpdate: (u: unknown) => void })
			.handleLiveEditorUpdate({
				view: cm,
				docChanged: true,
				transactions: [{
					docChanged: true,
					isUserEvent: (e: string): boolean =>
						userEvent !== null && (userEvent === e || userEvent.startsWith(`${e}.`)),
				}],
			});
	};

	return {
		manager, texts, dispatched, makeView, seed, editorUpdate,
		setEditorText: (t: string) => { editorText = t; },
	};
}

const OLD = "Notes/Untitled.md";
const NEW = "Notes/Freewrite.md";
const OTHER = "Notes/Other.md";
const REASON = "layout-change:path-changed,ytext-mismatch";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

s.section("Test 1: a rename of the bound file keeps the binding attached");
{
	const f = fixture();
	const ytext = f.seed(OLD, "");
	const view = f.makeView(OLD);
	f.manager.bind(view, "device-test");
	s.check(f.manager.isBound(OLD) && f.dispatched.length === 1, "bound once before the rename");

	// Obsidian renames the TFile in place; the path map has not caught up.
	view.file!.path = NEW;
	const handled = f.manager.repair(view, "device-test", REASON);

	s.check(handled, "repair reports the binding handled");
	s.check(f.dispatched.length === 1, "yCollab was not detached or reattached");
	s.check(f.manager.getBindingDebugInfoForView(view) !== null, "the binding survives the audit");

	// Rename batch flushes: same Y.Text, new path.
	f.texts.delete(OLD);
	f.texts.set(NEW, ytext);
	f.manager.updatePathsAfterRename(new Map([[OLD, NEW]]));

	s.check(f.manager.isBound(NEW) && !f.manager.isBound(OLD), "binding follows the rename");
	s.check(f.dispatched.length === 1, "still no rebind after the batch flushes");
}

s.section("Test 2: bind during a rename in flight also keeps the binding");
{
	const f = fixture();
	f.seed(OLD, "");
	const view = f.makeView(OLD);
	f.manager.bind(view, "device-test");

	view.file!.path = NEW;
	f.manager.bind(view, "device-test");

	s.check(f.dispatched.length === 1, "bind did not unbind the renamed note");
	s.check(f.manager.getBindingDebugInfoForView(view) !== null, "the binding is still tracked");
}

s.section("Test 3: a different file in the same leaf is still rebound");
{
	const f = fixture();
	f.seed(OLD, "");
	f.seed(OTHER, "other note");
	const view = f.makeView(OLD);
	f.manager.bind(view, "device-test");

	const otherFile = new TFile();
	otherFile.path = OTHER;
	otherFile.stat = { ctime: 1, mtime: 1, size: 0 };
	(view as unknown as { file: TFile }).file = otherFile;
	f.manager.repair(view, "device-test", REASON);

	s.check(f.manager.isBound(OTHER) && !f.manager.isBound(OLD), "leaf is bound to the other note");
	s.check(f.dispatched.length === 3, "old binding detached and new one attached");
}

s.section("Test 4: a user edit made while bind waits for the seed reaches the CRDT");
{
	const f = fixture();
	const view = f.makeView(OLD);
	f.manager.bind(view, "device-test");
	s.check(!f.manager.isBound(OLD), "not bound while the Y.Text is missing");

	f.editorUpdate("\nWOuld", "input.type");
	const ytext = f.seed(OLD, "");
	advance(500);

	s.check(f.manager.isBound(OLD), "bound once the seed landed");
	s.check(ytext.toString() === "\nWOuld", "the unbound typing was diffed into the Y.Text");
}

s.section("Test 5: a document load while unbound is never pushed over the CRDT");
{
	const f = fixture();
	const view = f.makeView(OLD);
	f.manager.bind(view, "device-test");

	// Obsidian loading stale disk text into the editor is not a user event.
	f.editorUpdate("stale disk text", null);
	const ytext = f.seed(OLD, "newer remote text");
	advance(500);

	s.check(f.manager.isBound(OLD), "bound once the seed landed");
	s.check(ytext.toString() === "newer remote text", "the CRDT text is untouched");
}

s.section("Test 6: a user edit followed by a document load is not pushed either");
{
	const f = fixture();
	const view = f.makeView(OLD);
	f.manager.bind(view, "device-test");

	f.editorUpdate("typed into the previous document", "input.type");
	f.editorUpdate("", null);
	const ytext = f.seed(OLD, "remote text");
	advance(500);

	s.check(ytext.toString() === "remote text", "the load cleared the pending edit");
}

s.section("Test 7: an ordinary bind with differing editor text leaves the CRDT alone");
{
	const f = fixture();
	const ytext = f.seed(OLD, "crdt text");
	f.setEditorText("disk text");
	f.manager.bind(f.makeView(OLD), "device-test");

	s.check(f.manager.isBound(OLD), "bound immediately");
	s.check(ytext.toString() === "crdt text", "no diff applied without an unbound user edit");
}

await s.done();
