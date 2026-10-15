// Regression (2026-10-15, SYNC-06): a bound editor that stops receiving CRDT
// updates must be detected and rebound, and the repairs that put it in that
// state must not run inside a CodeMirror update.
//
// Field case: Pierre Pattat.md, open in one Mac tab for two days. The CRDT
// kept receiving the editor's changes, but the editor never received the
// CRDT's. Every timestamp stamp then reached disk, Obsidian reloaded the
// editor from disk, and y-codemirror pushed the reloaded value back into the
// CRDT as a user edit, which stamped again: 1,680 rewrites at one every 3.5 s.
// The health audit called the binding healthy throughout because it checks
// the facet, not whether the editor follows the Y.Text.
//
// The binding broke on 2026-10-13 during a live-update repair: the rebind
// dispatched a reconfigure from inside CodeMirror's own update ("Calls to
// EditorView.update are not allowed while an update is in progress"), the
// unbind half of it failed silently, and a retry reported success.
//
// Three rules now.
//   1. A health check raised by a live editor update runs after the update,
//      never inside it.
//   2. A repair that keeps the EditorView detaches yCollab before attaching
//      the new one. CodeMirror keeps a ViewPlugin instance across a
//      reconfigure when the same spec is present on both sides, and
//      y-codemirror's ySync is one module-level spec whose instance captured
//      its Y.Text at construction.
//   3. After a non-editor transaction on a bound Y.Text, the editor must show
//      the same text; if it does not, the binding is unhealthy and is rebound.

import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import type { EditorView } from "@codemirror/view";
import { YSyncConfig } from "y-codemirror.next";
import { EditorBindingManager } from "../../src/sync/editorBinding";
import type { VaultSync } from "../../src/sync/vaultSync";
import { ORIGIN_TIMESTAMP } from "../../src/sync/origins";
import { suite } from "../harness.ts";

const s = suite("binding-crdt-to-editor-health");

// ---------------------------------------------------------------------------
// Fake clock standing in for window.setTimeout / clearTimeout (see
// unbound-edits-and-rename-binding.ts for why only the alias is replaced).
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

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Dispatched {
	/** Extension handed to compartment.reconfigure: [] for a detach. */
	extension: unknown;
}

function fixture() {
	const doc = new Y.Doc();
	const texts = new Map<string, Y.Text>();
	let editorText = "";
	let facetText: Y.Text | null = null;

	const vaultSync = {
		getTextForPath: (path: string): Y.Text | null => texts.get(path) ?? null,
		getFileId: (path: string): string | undefined =>
			texts.has(path) ? `id:${path}` : undefined,
		getFileIdForText: (): string | undefined => undefined,
		isMarkdownTombstoned: (): boolean => false,
		isPendingRenameTarget: (): boolean => false,
		provider: { awareness: { setLocalStateField: (): void => {} } },
	};

	const dispatched: Dispatched[] = [];
	const cm = {
		// Mirror what CodeMirror does with the reconfigure: an empty extension
		// drops the facet, a yCollab extension installs its Y.Text.
		dispatch: (tr: { effects?: { value?: { extension?: unknown } } }): void => {
			const extension = tr.effects?.value?.extension;
			dispatched.push({ extension });
			if (Array.isArray(extension) && extension.length === 0) {
				facetText = null;
				return;
			}
			const conf = findSyncConfig(extension);
			facetText = conf?.ytext ?? null;
		},
		dom: { isConnected: true },
		state: {
			facet: (): { ytext: Y.Text } | undefined =>
				facetText ? { ytext: facetText } : undefined,
			doc: { length: 0 },
		},
	};

	const traces: Array<{ event: string; data?: Record<string, unknown> }> = [];
	const manager = new EditorBindingManager(
		vaultSync as unknown as VaultSync,
		{ getActiveViewOfType: (): null => null } as never,
		false,
		(_source, event, data) => { traces.push({ event, data }); },
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

	const seed = (path: string, content: string, name = path): Y.Text => {
		const text = doc.getText(name);
		text.insert(0, content);
		texts.set(path, text);
		editorText = content;
		return text;
	};

	const editorUpdate = (next: string): void => {
		editorText = next;
		(manager as unknown as { handleLiveEditorUpdate: (u: unknown) => void })
			.handleLiveEditorUpdate({
				view: cm,
				docChanged: true,
				transactions: [{ docChanged: true, isUserEvent: (e: string): boolean => e === "input" }],
			});
	};

	const detaches = () =>
		dispatched.filter((d) => Array.isArray(d.extension) && d.extension.length === 0).length;

	return {
		manager, texts, dispatched, traces, makeView, seed, editorUpdate, detaches,
		setEditorText: (t: string) => { editorText = t; },
		awareness: vaultSync.provider.awareness,
	};
}

/** Walk a yCollab extension array for its YSyncConfig facet value. */
function findSyncConfig(extension: unknown): { ytext: Y.Text } | null {
	if (Array.isArray(extension)) {
		for (const item of extension) {
			const found = findSyncConfig(item);
			if (found) return found;
		}
		return null;
	}
	if (extension && typeof extension === "object" && "value" in extension) {
		const value = (extension as { value: unknown }).value;
		if (value instanceof YSyncConfig) return value;
	}
	return null;
}

const NOTE = "Notes/Genealogy/Pierre Pattat.md";
const OTHER = "Notes/Genealogy/Alice Holloway.md";
const DEVICE = "device-test";

// ---------------------------------------------------------------------------
// Rule 1: live-update health work runs after the CodeMirror update
// ---------------------------------------------------------------------------

s.section("Test 1: a repair raised by a live editor update is deferred out of the update");
{
	const f = fixture();
	f.seed(NOTE, "pierre");
	const view = f.makeView(NOTE);
	f.manager.bind(view, DEVICE);
	s.check(f.dispatched.length === 1, "bound once");

	// The leaf now shows another note: a fresh TFile under the same leaf, the
	// old path gone from the map, so followRename cannot adopt it.
	f.texts.delete(NOTE);
	f.seed(OTHER, "alice");
	const other = f.makeView(OTHER);
	(view as { file: TFile }).file = other.file!;

	const before = f.dispatched.length;
	f.editorUpdate("alice");
	s.check(f.dispatched.length === before, "no reconfigure dispatched inside the editor update");

	advance(0);
	s.check(f.dispatched.length > before, "the repair ran once the update had finished");
	s.check(f.manager.isBound(OTHER), "the leaf is bound to the note it shows");
}

// ---------------------------------------------------------------------------
// Rule 2: a repair that keeps the EditorView detaches before attaching
// ---------------------------------------------------------------------------

s.section("Test 2: repairing to a new Y.Text detaches yCollab first so ySync is rebuilt");
{
	const f = fixture();
	const first = f.seed(NOTE, "pierre");
	const view = f.makeView(NOTE);
	f.manager.bind(view, DEVICE);
	s.check(f.dispatched.length === 1 && f.detaches() === 0, "bind attaches in one dispatch");

	// The path now resolves to a different Y.Text (ytext-mismatch).
	const second = f.seed(NOTE, "pierre", `${NOTE}#2`);
	s.check(first !== second, "fixture: the path's Y.Text was replaced");

	const repaired = f.manager.repair(view, DEVICE, "test:ytext-mismatch");
	s.check(repaired, "repair reports success");
	s.check(f.dispatched.length === 3, "repair dispatched twice");
	s.check(
		Array.isArray(f.dispatched[1]!.extension) && f.dispatched[1]!.extension.length === 0,
		"the first dispatch detaches yCollab",
	);
	s.check(findSyncConfig(f.dispatched[2]?.extension)?.ytext === second, "the second attaches the new Y.Text");
}

// ---------------------------------------------------------------------------
// Rule 3: an editor that does not follow the CRDT is unhealthy
// ---------------------------------------------------------------------------

s.section("Test 3: a stamp the editor does not show marks the binding unhealthy and rebinds it");
{
	const f = fixture();
	const text = f.seed(NOTE, "body");
	const view = f.makeView(NOTE);
	f.manager.bind(view, DEVICE);
	const before = f.dispatched.length;

	// Dead observer: the Y.Text changes, the editor does not.
	text.doc!.transact(() => text.insert(0, "---\nmodified: now\n---\n"), ORIGIN_TIMESTAMP);
	const missed = f.traces.find((t) => t.event === "binding-editor-missed-update");
	s.check(missed !== undefined, "the miss is traced");
	s.check(missed?.data?.path === NOTE && missed?.data?.origin === ORIGIN_TIMESTAMP, "trace names the path and origin");
	s.check(f.dispatched.length === before, "nothing dispatched from inside the Y.js observer");

	advance(0);
	s.check(f.dispatched.length === before + 2, "the binding was detached and reattached");
	s.check(f.detaches() === 1, "exactly one detach");
	const failed = f.traces.find((t) => t.event === "binding-health-failed");
	s.check(
		Array.isArray(failed?.data?.issues) && (failed!.data!.issues as string[]).includes("editor-missed-update"),
		"health failure names the issue",
	);
}

s.section("Test 4: a transaction the editor does follow is healthy");
{
	const f = fixture();
	const text = f.seed(NOTE, "body");
	// Live observer: y-codemirror's is registered when its plugin is built
	// during bind's dispatch, so it runs before the manager's own.
	text.observe(() => { f.setEditorText(text.toString()); });
	const view = f.makeView(NOTE);
	f.manager.bind(view, DEVICE);
	const before = f.dispatched.length;

	text.doc!.transact(() => text.insert(0, "---\nmodified: now\n---\n"), ORIGIN_TIMESTAMP);
	advance(0);
	s.check(f.traces.every((t) => t.event !== "binding-editor-missed-update"), "no miss traced");
	s.check(f.dispatched.length === before, "no rebind");
}

s.section("Test 5: the editor's own transactions and a suspended binding are not inspected");
{
	const f = fixture();
	const text = f.seed(NOTE, "body");
	const view = f.makeView(NOTE);
	f.manager.bind(view, DEVICE);
	const before = f.dispatched.length;

	// Editor origin: the editor is ahead of the Y.Text by construction while
	// y-codemirror pushes a keystroke, so the comparison would be meaningless.
	const conf = new YSyncConfig(text, f.awareness as never);
	text.doc!.transact(() => text.insert(text.length, "!"), conf);
	s.check(f.traces.every((t) => t.event !== "binding-editor-missed-update"), "editor-origin transaction not inspected");

	// Suspended: recovery detaches yCollab on purpose before diffing the Y.Text.
	s.check(f.manager.suspendCollab(view, "test"), "suspended");
	text.doc!.transact(() => text.insert(text.length, "?"), "disk-sync");
	s.check(f.traces.every((t) => t.event !== "binding-editor-missed-update"), "suspended binding not inspected");
	advance(0);
	s.check(f.dispatched.length === before + 1, "only the suspend's own detach was dispatched");
}

s.section("Test 6: unbind stops watching the Y.Text");
{
	const f = fixture();
	const text = f.seed(NOTE, "body");
	const view = f.makeView(NOTE);
	f.manager.bind(view, DEVICE);
	f.manager.unbind(view);
	text.doc!.transact(() => text.insert(0, "x"), ORIGIN_TIMESTAMP);
	advance(0);
	s.check(f.traces.every((t) => t.event !== "binding-editor-missed-update"), "no trace after unbind");
}

await s.done();
