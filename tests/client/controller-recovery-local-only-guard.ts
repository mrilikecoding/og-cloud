// Regression (2026-09-21): the editor-bound localOnly recovery
// (editor == disk, CRDT trails) has to actually run, and has to run without
// feeding its own diff back into the editor.
//
// Three defects seen in the Svalbard vault logs on 09-17 and 09-19:
//
//   1. The idle guard read getLastEditorActivityForPath, and bind() sets
//      that to the bind time. Every freshly opened note therefore looked
//      like "the user just typed" and recovery was deferred.
//   2. A deferral returned and waited for the next disk modify event.
//      Obsidian autosaves ~2s after a keystroke, inside the 3s idle window,
//      so during an editing session the recovery never ran at all.
//   3. The disk diff was applied to the Y.Text while yCollab was attached.
//      y-codemirror mirrors every non-editor-origin Y.Text change into the
//      editor, which already held that text, so each cycle grew the editor
//      and the disk by the size of the lag. That is the "+5 per cycle"
//      amplifier in controller-recovery-orchestration-amplifier.ts.
//
// The rules now: the guard reads real doc changes since bind; a deferral
// schedules one retry for when the idle window has elapsed; and yCollab is
// suspended on every bound view before the diff and repaired after it.

import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import { ReconciliationController } from "../../src/runtime/reconciliationController";
import type { DiskIngestPort } from "../../src/runtime/engineControlPort";
import { FLIGHT_KIND } from "../../src/observability/flightTaxonomy";
import type {
	FlightEventInput,
	FlightPathEventInput,
} from "../../src/observability/flightEnvelope";
import { suite } from "../harness.ts";

const s = suite("controller-recovery-local-only-guard");

// ---------------------------------------------------------------------------
// Fake clock for window.setTimeout (the harness aliases window to globalThis,
// configurable, so only the alias is replaced).
// ---------------------------------------------------------------------------

interface FakeTimer { id: number; delayMs: number; fn: () => void; cleared: boolean }
const timers: FakeTimer[] = [];
let nextTimerId = 1;
Object.defineProperty(globalThis, "window", {
	configurable: true,
	value: {
		setTimeout: (fn: () => void, ms: number): number => {
			const t: FakeTimer = { id: nextTimerId++, delayMs: ms, fn, cleared: false };
			timers.push(t);
			return t.id;
		},
		clearTimeout: (id: number): void => {
			const t = timers.find((x) => x.id === id);
			if (t) t.cleared = true;
		},
	},
});
function pendingTimers(): FakeTimer[] { return timers.filter((t) => !t.cleared); }
function fire(t: FakeTimer): void { t.cleared = true; t.fn(); }

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Captured { kind: string; data: Record<string, unknown> }

function makeTFile(path: string): TFile {
	const file = new TFile() as TFile & { path: string };
	file.path = path;
	return file;
}

function buildFixture(initial: { disk: string; editor: string; crdt: string }) {
	const path = "Notes/note.md";
	let diskContent = initial.disk;
	let editorContent = initial.editor;
	let lastDocChangeAtMs: number | null = null;
	let diskIngestPort: DiskIngestPort | null = null;

	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, initial.crdt);

	const file = makeTFile(path);
	const view = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
		file,
		editor: { getValue: (): string => editorContent },
	});

	const captured: Captured[] = [];
	const recordFlightPathEvent = (e: FlightPathEventInput): void => {
		captured.push({ kind: e.kind, data: (e.data as Record<string, unknown>) ?? {} });
	};
	const recordFlightEvent = (e: FlightEventInput): void => {
		captured.push({ kind: e.kind, data: (e.data as Record<string, unknown>) ?? {} });
	};

	/** Order of binding operations, each stamped with the Y.Text at that moment. */
	const bindingOps: Array<{ op: "suspend" | "repair"; ytextAtCall: string }> = [];

	const editorBindings = {
		isBound: () => true,
		getBindingDebugInfoForView: () => ({
			leafId: "leaf-1", storedCmId: "cm-1", liveCmId: "cm-1", cmMatches: true,
		}),
		getCollabDebugInfoForView: () => ({
			hasSyncFacet: true, awarenessMatchesProvider: true, yTextMatchesExpected: true,
			undoManagerMatchesFacet: true, facetFileId: "f", expectedFileId: "f",
		}),
		suspendCollab: (_view: MarkdownView): boolean => {
			bindingOps.push({ op: "suspend", ytextAtCall: ytext.toString() });
			return true;
		},
		repair: (_view: MarkdownView, _deviceName: string, _reason: string): boolean => {
			bindingOps.push({ op: "repair", ytextAtCall: ytext.toString() });
			return true;
		},
		rebind: () => {},
		unbindByPath: () => {},
		// What bind() sets: "activity" is the bind time, always recent.
		getLastEditorActivityForPath: () => Date.now(),
		// What a keystroke sets: null until the user actually types.
		getLastEditorDocChangeForPath: () => lastDocChangeAtMs,
	};

	const app = {
		vault: {
			read: async () => diskContent,
			adapter: { stat: async () => ({ mtime: 1, size: diskContent.length }) },
			getAbstractFileByPath: (p: string) => (p === path ? file : null),
			getMarkdownFiles: () => [file],
		},
		workspace: { iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => { cb({ view }); } },
	};

	const vaultSync = {
		getTextForPath: (p: string) => (p === path ? ytext : null),
		serverAckTracker: { withActiveOpId: (_o: string | undefined, fn: () => void) => fn() },
		getFileIdForText: () => "f",
	};

	const traces: Array<{ message: string; details: Record<string, unknown> }> = [];
	const controller = new ReconciliationController({
		app: app as never,
		getSettings: () => ({ deviceName: "TestDevice" }) as never,
		getRuntimeConfig: () => ({ maxFileSizeBytes: 0, maxFileSizeKB: 0, excludePatterns: [], externalEditPolicy: "always" }) as never,
		getVaultSync: () => vaultSync as never,
		getDiskMirror: () => ({ isPreservedUnresolved: () => false, clearPreservedUnresolved: () => {}, flushWrite: async () => {} }) as never,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as never,
		getDiskIndex: () => ({}),
		setDiskIndex: () => {},
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (_source: string, message: string, details?: Record<string, unknown>) => { traces.push({ message, details: details ?? {} }); },
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		recordFlightEvent,
		recordFlightPathEvent,
		registerDiskIngestPort: (p: DiskIngestPort) => { diskIngestPort = p; },
	});

	return {
		path, ytext, captured, traces, bindingOps, controller,
		setDisk: (c: string) => { diskContent = c; },
		setEditor: (c: string) => { editorContent = c; },
		typedAt: (ms: number | null) => { lastDocChangeAtMs = ms; },
		ingest: () => {
			if (!diskIngestPort) throw new Error("no ingest port");
			return diskIngestPort.ingestDiskFileNow(path, "modify");
		},
		skips: () => captured.filter((e) => e.kind === FLIGHT_KIND.recoverySkipped),
		decisions: () => captured.filter((e) => e.kind === FLIGHT_KIND.recoveryDecision),
	};
}

const CRDT = "hello";
const TYPED = "hello world";

// ---------------------------------------------------------------------------
// (a) idle guard reads real keystrokes
// ---------------------------------------------------------------------------

s.section("Test 1: a freshly bound note with no keystrokes since bind recovers immediately");
{
	const f = buildFixture({ disk: TYPED, editor: TYPED, crdt: CRDT });
	f.typedAt(null);
	await f.ingest();
	s.check(f.skips().length === 0, "no recovery.skipped for a bind-time-only activity stamp");
	s.check(f.decisions().length === 1, "recovery.decision emitted");
	s.check(f.ytext.toString() === TYPED, "CRDT now equals the editor/disk content");
}

s.section("Test 2: real typing inside the idle window still defers");
{
	const f = buildFixture({ disk: TYPED, editor: TYPED, crdt: CRDT });
	f.typedAt(Date.now() - 200);
	await f.ingest();
	const skip = f.skips().find((e) => e.data.reason === "recent-editor-activity-local-only");
	s.check(skip !== undefined, "recovery.skipped with recent-editor-activity-local-only");
	s.check(f.ytext.toString() === CRDT, "CRDT untouched while the user is typing");
}

// ---------------------------------------------------------------------------
// (b) a deferral schedules a retry
// ---------------------------------------------------------------------------

s.section("Test 3: a deferral schedules one retry for when the idle window has elapsed");
{
	timers.length = 0;
	const f = buildFixture({ disk: TYPED, editor: TYPED, crdt: CRDT });
	f.typedAt(Date.now() - 200);
	await f.ingest();
	const pending = pendingTimers();
	s.check(pending.length === 1, "exactly one retry timer pending after the deferral");
	const delay = pending[0]?.delayMs ?? 0;
	s.check(delay >= 2500 && delay <= 3500, `retry delay covers the rest of the idle window (got ${delay}ms)`);
	const scheduled = f.traces.find((t) => t.message === "local-only-recovery-retry-scheduled");
	s.check(scheduled !== undefined && scheduled.details.path === f.path, "retry is traced with the path");

	// The user paused; the retry fires and recovery runs.
	f.typedAt(Date.now() - 10_000);
	if (pending[0]) fire(pending[0]);
	await new Promise((r) => setTimeout(r, 20));
	s.check(f.decisions().length === 1, "retry ran the recovery once typing had stopped");
	s.check(f.ytext.toString() === TYPED, "CRDT caught up on the retry");
}

s.section("Test 4: a second deferral for the same path replaces the pending retry");
{
	timers.length = 0;
	const f = buildFixture({ disk: TYPED, editor: TYPED, crdt: CRDT });
	f.typedAt(Date.now() - 200);
	await f.ingest();
	f.typedAt(Date.now() - 100);
	await f.ingest();
	s.check(pendingTimers().length === 1, "still exactly one pending retry timer");
}

// ---------------------------------------------------------------------------
// (c) yCollab is suspended around the diff
// ---------------------------------------------------------------------------

s.section("Test 5: collab is suspended before the diff and repaired after it, even for a healthy binding");
{
	const f = buildFixture({ disk: TYPED, editor: TYPED, crdt: CRDT });
	f.typedAt(null);
	await f.ingest();
	const ops = f.bindingOps.map((o) => o.op);
	s.check(ops.join(",") === "suspend,repair", `binding ops in order suspend,repair (got ${ops.join(",") || "none"})`);
	s.check(f.bindingOps[0]?.ytextAtCall === CRDT, "suspend happened before the Y.Text changed");
	s.check(f.bindingOps[1]?.ytextAtCall === TYPED, "repair happened after the Y.Text was updated");
}

void s.done();
