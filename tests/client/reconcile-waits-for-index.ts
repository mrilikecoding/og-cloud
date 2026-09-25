// Regression (2026-09-25): reconcile must not run against an unpopulated
// vault index.
//
// On boot, runReconciliation read app.vault.getMarkdownFiles() roughly two
// seconds after plugin start, before Obsidian had finished indexing the vault.
// It therefore saw far fewer files than the vault holds and recorded 20
// crdt-file-missing-on-disk decisions for notes that had existed for years,
// then tried to create them and their parent folders. Nine of those writes
// died on "Folder already exists." and a later pass repaired everything, so
// the visible damage was nil, but the shape is how a sync plugin overwrites a
// newer disk file with older CRDT content.
//
// Attachment sync already gated itself on workspace.onLayoutReady
// (attachmentOrchestrator.ts). Markdown reconcile had no such gate.

import { TFile } from "obsidian";
import * as Y from "yjs";
import { ReconciliationController } from "../../src/runtime/reconciliationController";
import type { DiskIngestPort } from "../../src/runtime/engineControlPort";
import { suite } from "../harness.ts";

const s = suite("reconcile-waits-for-index");

function buildFixture() {
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "body");

	/** Files Obsidian's index has loaded so far. Empty until we say otherwise. */
	let indexedFiles: TFile[] = [];
	const markdownFileReads: number[] = [];
	let releaseIndex: (() => void) | null = null;
	const indexReady = new Promise<void>((resolve) => { releaseIndex = resolve; });

	const makeFile = (path: string): TFile => {
		const file = new TFile() as TFile & { path: string };
		file.path = path;
		file.stat = { ctime: 1, mtime: 1, size: 4 };
		return file;
	};

	const controller = new ReconciliationController({
		app: {
			vault: {
				getMarkdownFiles: () => { markdownFileReads.push(indexedFiles.length); return indexedFiles; },
				read: async () => "body",
				adapter: { stat: async () => ({ mtime: 1, size: 4 }) },
				getAbstractFileByPath: (p: string) => indexedFiles.find((f) => f.path === p) ?? null,
			},
			workspace: { iterateAllLeaves: () => {} },
		} as never,
		getSettings: () => ({ deviceName: "TestDevice" }) as never,
		getRuntimeConfig: () => ({ maxFileSizeBytes: 0, maxFileSizeKB: 0, excludePatterns: [], externalEditPolicy: "always" }) as never,
		getVaultSync: () => ({
			getActiveMarkdownPaths: () => [],
			getTextForPath: () => ytext,
			connected: true,
			providerSynced: true,
			getSafeReconcileMode: () => "authoritative",
			reconcileVault: () => ({ mode: "authoritative", createdOnDisk: [], updatedOnDisk: [], seededToCrdt: [], untracked: [], tombstonedDiskConflicts: [], purgedExcluded: [], skipped: 0 }),
			runIntegrityChecks: () => ({ duplicateIds: 0, orphansCleaned: 0 }),
			serverAckTracker: { withActiveOpId: (_o: string | undefined, fn: () => void) => fn() },
		}) as never,
		getDiskMirror: () => ({ isPreservedUnresolved: () => false, clearPreservedUnresolved: () => {}, flushWrite: async () => {} }) as never,
		getBlobSync: () => null,
		getEditorBindings: () => ({ isBound: () => false, getLastEditorActivityForPath: () => null, getLastEditorDocChangeForPath: () => null, suspendCollab: () => true, repair: () => true, rebind: () => {}, unbindByPath: () => {} }) as never,
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
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		recordFlightEvent: () => {},
		recordFlightPathEvent: () => {},
		registerDiskIngestPort: (_p: DiskIngestPort) => {},
		whenVaultIndexReady: () => indexReady,
	});

	return {
		controller,
		markdownFileReads,
		loadIndex: (paths: string[]) => { indexedFiles = paths.map(makeFile); },
		releaseIndex: () => releaseIndex?.(),
	};
}

s.section("Test 1: reconcile does not read the file list before the index is ready");
{
	const f = buildFixture();
	const run = f.controller.runReconciliation("authoritative");
	// Give the promise chain room to reach the gate and stop there.
	await new Promise((r) => setTimeout(r, 30));

	s.check(f.markdownFileReads.length === 0, `no vault read while the index is loading (got ${f.markdownFileReads.length})`);

	// Obsidian finishes indexing, then signals ready.
	f.loadIndex(["Notes/Writing/a.md", "Notes/Writing/b.md"]);
	f.releaseIndex();
    await run;

	s.check(f.markdownFileReads.length > 0, "the file list was read once the index was ready");
	s.check(
		f.markdownFileReads.every((n) => n === 2),
		`every read saw the fully loaded vault (saw ${JSON.stringify(f.markdownFileReads)})`,
	);
}

s.section("Test 2: an already-ready index does not delay reconcile");
{
	const f = buildFixture();
	f.loadIndex(["Notes/Writing/a.md"]);
	f.releaseIndex();
	await f.controller.runReconciliation("authoritative");

	s.check(f.markdownFileReads.length > 0, "reconcile ran");
	s.check(f.markdownFileReads.every((n) => n === 1), "and saw the loaded vault");
}

void s.done();
