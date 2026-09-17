// Regression (2026-09-17): opening an excluded note must not admit it to the
// CRDT. The path classifier marks conflict artifacts and user-excluded paths
// as "excluded", and the reconciler and vault event handlers honour that,
// but the editor binder called ensureFile for any .md the user opened. So
// clicking a local-only conflict artifact minted a live CRDT entry that the
// next reconcile wrote back to disk and pushed to every device, and deleting
// it only tombstoned that one id — the next click minted another.
//
// The gate lives in EditorWorkspaceOrchestrator.bindView, the single path
// every bind request (active-leaf-change, file-open, layout-change) goes
// through, and reuses the plugin's isMarkdownPathSyncable predicate so the
// binder and the vault handlers agree on what is syncable.

import { MarkdownView, TFile } from "obsidian";
import { EditorWorkspaceOrchestrator } from "../../src/runtime/editorWorkspaceOrchestrator";
import { suite } from "../harness.ts";

const s = suite("bind-excluded-paths");

function makeView(path: string): MarkdownView {
	const file = new TFile();
	file.path = path;
	file.stat = { ctime: 1, mtime: 1, size: 0 };
	return Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
		file,
		editor: { getValue: (): string => "" },
	});
}

function fixture(syncable: (path: string) => boolean) {
	const bound: string[] = [];
	const opened: string[] = [];
	const logs: string[] = [];
	let active: MarkdownView | null = null;
	const app = {
		workspace: {
			getActiveViewOfType: () => active,
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				if (active) cb({ view: active });
			},
		},
	};
	const editorBindings = {
		bind: (view: MarkdownView) => { bound.push(view.file!.path); },
		clearLocalCursor: () => {},
		auditBindings: () => 0,
		unbindByPath: () => {},
		updatePathsAfterRename: () => {},
		pruneOrphanedBindings: () => 0,
		getLiveLeafKeys: () => new Set<string>(),
	};
	const diskMirror = {
		notifyFileOpened: (p: string) => { opened.push(p); },
		notifyFileClosed: () => {},
	};
	const orchestrator = new EditorWorkspaceOrchestrator({
		app: app as never,
		getSettings: () => ({ deviceName: "test" }) as never,
		getEditorBindings: () => editorBindings as never,
		getDiskMirror: () => diskMirror as never,
		maybeImportDeferredClosedOnlyPath: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: (m) => logs.push(m),
		isMarkdownPathSyncable: syncable,
	});
	return { orchestrator, bound, opened, logs, setActive: (v: MarkdownView | null) => { active = v; } };
}

const ARTIFACT = "Notes/Rayna/Labor (YAOS conflict - crdt from device-mu0kz43t 2026-09-17T21-15-08Z).md";
const NOTE = "Notes/Rayna/Labor.md";

s.section("Test 1: a syncable note binds and is tracked as open");
{
	const f = fixture(() => true);
	const v = makeView(NOTE);
	f.setActive(v);
	f.orchestrator.onFileOpen(NOTE);
	s.check(f.bound.length === 1 && f.bound[0] === NOTE, "bind called for the note");
	s.check(f.opened.includes(NOTE), "disk mirror told the note is open");
}

s.section("Test 2: an excluded path is never bound or tracked, via file-open");
{
	const f = fixture((p) => p === NOTE);
	const v = makeView(ARTIFACT);
	f.setActive(v);
	f.orchestrator.onFileOpen(ARTIFACT);
	s.check(f.bound.length === 0, "bind NOT called for the artifact");
	s.check(!f.opened.includes(ARTIFACT), "disk mirror NOT told the artifact is open");
	s.check(f.logs.some((m) => m.includes("excluded") && m.includes("Labor (YAOS conflict")), "refusal is logged with the path");
}

s.section("Test 3: an excluded path is never bound via active-leaf-change either");
{
	const f = fixture((p) => p === NOTE);
	const v = makeView(ARTIFACT);
	f.setActive(v);
	f.orchestrator.onActiveLeafChange({ view: v } as never);
	s.check(f.bound.length === 0, "bind NOT called via active-leaf-change");
}

s.section("Test 4: a non-markdown or filtered path is refused too (same predicate)");
{
	const f = fixture((p) => !p.startsWith("Private/"));
	const v = makeView("Private/secrets.md");
	f.setActive(v);
	f.orchestrator.onFileOpen("Private/secrets.md");
	s.check(f.bound.length === 0, "user-excluded folder is not bound");
}

await s.done();
