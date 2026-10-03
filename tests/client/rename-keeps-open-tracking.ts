// Regression (2026-10-03): renaming the note open in the editor must leave the
// disk mirror believing it is open.
//
// Obsidian updates view.file.path and fires layout-change before the rename
// batch flushes (about 180 ms apart in the field). The layout-change sweep saw
// the old path with no live view and closed it, so onRenameBatchFlushed found
// nothing to move and the new path was never opened. The rebind that follows
// goes through the binding audit, not bindView, so nothing else tracked it.
// From then on the mirror wrote the note to disk under the live editor on
// every timestamp stamp: 647 of 2,015 stamps between 09-26 and 10-03.

import { MarkdownView, TFile } from "obsidian";
import { EditorWorkspaceOrchestrator } from "../../src/runtime/editorWorkspaceOrchestrator";
import { suite } from "../harness.ts";

const s = suite("rename-keeps-open-tracking");

function makeView(path: string): MarkdownView {
	const file = new TFile();
	file.path = path;
	file.stat = { ctime: 1, mtime: 1, size: 0 };
	return Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
		file,
		editor: { getValue: (): string => "" },
	});
}

function fixture(syncable: (path: string) => boolean = () => true) {
	const open = new Set<string>();
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
		bind: () => {},
		clearLocalCursor: () => {},
		auditBindings: () => 0,
		unbindByPath: () => {},
		updatePathsAfterRename: () => {},
		pruneOrphanedBindings: () => 0,
		getLiveLeafKeys: () => new Set<string>(),
	};
	const diskMirror = {
		notifyFileOpened: (p: string) => { open.add(p); },
		notifyFileClosed: (p: string) => { open.delete(p); },
		flushOpenPath: async () => {},
	};
	const orchestrator = new EditorWorkspaceOrchestrator({
		app: app as never,
		getSettings: () => ({ deviceName: "test" }) as never,
		getEditorBindings: () => editorBindings as never,
		getDiskMirror: () => diskMirror as never,
		maybeImportDeferredClosedOnlyPath: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		isMarkdownPathSyncable: syncable,
	});
	return { orchestrator, open, setActive: (v: MarkdownView | null) => { active = v; } };
}

const OLD = "Notes/Writing/Free Write/Untitled.md";
const NEW = "Notes/Writing/Free Write/Freewrite.md";

s.section("Test 1: layout-change before the rename batch keeps the note open");
{
	const f = fixture();
	const v = makeView(OLD);
	f.setActive(v);
	f.orchestrator.onFileOpen(OLD);
	s.check(f.open.has(OLD), "note is open before the rename");

	v.file!.path = NEW;
	f.orchestrator.onLayoutChange();
	f.orchestrator.onRenameBatchFlushed(new Map([[OLD, NEW]]));

	s.check(f.open.has(NEW), "mirror believes the renamed note is open");
	s.check(!f.open.has(OLD), "old path is no longer open");
}

s.section("Test 2: rename batch first still moves the open state");
{
	const f = fixture();
	const v = makeView(OLD);
	f.setActive(v);
	f.orchestrator.onFileOpen(OLD);

	v.file!.path = NEW;
	f.orchestrator.onRenameBatchFlushed(new Map([[OLD, NEW]]));
	f.orchestrator.onLayoutChange();

	s.check(f.open.has(NEW) && !f.open.has(OLD), "open state moved to the new path");
}

s.section("Test 3: renaming a note that is not open opens nothing");
{
	const f = fixture();
	f.orchestrator.onRenameBatchFlushed(new Map([[OLD, NEW]]));
	s.check(f.open.size === 0, "nothing tracked as open");
}

s.section("Test 4: a rename onto an excluded path is not tracked");
{
	const f = fixture((p) => p !== NEW);
	const v = makeView(OLD);
	f.setActive(v);
	f.orchestrator.onFileOpen(OLD);

	v.file!.path = NEW;
	f.orchestrator.onLayoutChange();
	f.orchestrator.onRenameBatchFlushed(new Map([[OLD, NEW]]));

	s.check(!f.open.has(NEW), "excluded destination is not opened");
}

await s.done();
