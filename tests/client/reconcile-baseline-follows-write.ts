// Regression (2026-10-22, SYNC-09): the reconcile baseline may only advance
// to the CRDT text when the disk actually holds that text.
//
// Field case: two notes edited on the Mac on 21 Oct were replaced, in full,
// by their 19 Oct text at 03:44Z on 22 Oct. The replacement came from the
// phone: a reconcile there chose import-disk-to-crdt (crdt-at-baseline), so
// its baseline for each note equalled the 21 Oct CRDT text while its disk
// still held 19 Oct. The baseline got there through runReconciliation's
// flush loop, which called diskMirror.flushWrite(path) and then advanced the
// baseline to the CRDT hash without looking at whether the write happened.
// flushWrite has several silent no-write exits; for John J. Akin it was the
// frontmatter guard (frontmatter-growth-burst: 128 -> 503 chars). The next
// boot then saw disk != baseline == crdt and "imported" the stale disk.
//
// Two rules now.
//   1. flushWrite reports what it did: written, unchanged, deferred, no-ytext
//      or failed. (It no longer refuses on frontmatter grounds at all: the
//      CRDT is the shared truth, and a device that will not write it
//      diverges. Validation still runs and traces frontmatter-write-flagged.)
//   2. runReconciliation advances a path's baseline only on written or
//      unchanged. Anything else holds the previous baseline and traces
//      reconcile-baseline-held, so the next reconcile sees the same
//      divergence instead of a fabricated "disk changed locally".

import { App, TFile } from "obsidian";
import * as Y from "yjs";
import { ReconciliationController } from "../../src/runtime/reconciliationController";
import { DiskMirror, type FlushWriteOutcome } from "../../src/sync/diskMirror";
import { contentBaselineHash } from "../../src/sync/diskIndex";
import type { DiskIngestPort } from "../../src/runtime/engineControlPort";
import type { VaultSync } from "../../src/sync/vaultSync";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import { partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

const s = suite("reconcile-baseline-follows-write");

const PATH = "Notes/Genealogy/Paternal/AKIN/John J. Akin.md";
const OLD = "---\ntype: person\n---\n# John J. Akin\n\nold body\n";
const NEW = "---\ntype: person\nschema: person\nsurname: Akin\ngiven: John J.\nline: paternal\nborn-date: 1810\nborn-place: Chautauqua County, New York\ndied-date: 1880\ndied-place: McMinn County, Tennessee\nfather: William H. Akin\nmother: Hannah Akin\nparents-confidence: probable\nahnentafel: 8\nresearch-status: active\naka: J. J. Akin\n---\n# John J. Akin\n\nnew body with much more\n";

// ---------------------------------------------------------------------------
// Controller fixture: one closed note, disk at the old text, CRDT at the new,
// baseline equal to the disk. flushWrite's outcome is scripted.
// ---------------------------------------------------------------------------

function controllerFixture(flushOutcome: FlushWriteOutcome) {
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, NEW);
	const file = new TFile() as TFile & { path: string };
	file.path = PATH;
	file.stat = { ctime: 1, mtime: 1, size: OLD.length };

	let diskIndex: Record<string, { mtime: number; size: number; contentHash?: string }> = {};
	const traces: Array<{ source: string; event: string; data?: Record<string, unknown> }> = [];
	const flushCalls: string[] = [];

	const controller = new ReconciliationController({
		app: {
			vault: {
				getMarkdownFiles: () => [file],
				read: async () => OLD,
				adapter: { stat: async () => ({ mtime: 1, size: OLD.length }) },
				getAbstractFileByPath: (p: string) => (p === PATH ? file : null),
			},
			workspace: { iterateAllLeaves: () => {} },
		} as never,
		getSettings: () => ({ deviceName: "Phone" }) as never,
		getRuntimeConfig: () => ({ maxFileSizeBytes: 0, maxFileSizeKB: 0, excludePatterns: [], externalEditPolicy: "always" }) as never,
		getVaultSync: () => ({
			getActiveMarkdownPaths: () => [PATH],
			getTextForPath: (p: string) => (p === PATH ? ytext : null),
			connected: true,
			providerSynced: true,
			getSafeReconcileMode: () => "authoritative",
			reconcileVault: () => ({ mode: "authoritative", createdOnDisk: [], updatedOnDisk: [PATH], seededToCrdt: [], untracked: [], tombstonedDiskConflicts: [], purgedExcluded: [], skipped: 0 }),
			runIntegrityChecks: () => ({ duplicateIds: 0, orphansCleaned: 0 }),
			serverAckTracker: { withActiveOpId: (_o: string | undefined, fn: () => void) => fn() },
		}) as never,
		getDiskMirror: () => ({
			isPreservedUnresolved: () => false,
			clearPreservedUnresolved: () => {},
			flushWrite: async (p: string) => {
				flushCalls.push(p);
				return flushOutcome;
			},
		}) as never,
		getBlobSync: () => null,
		getEditorBindings: () => ({ isBound: () => false, getLastEditorActivityForPath: () => null, getLastEditorDocChangeForPath: () => null, suspendCollab: () => true, repair: () => true, rebind: () => {}, unbindByPath: () => {} }) as never,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source, event, data) => traces.push({ source, event, data }),
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		recordFlightEvent: () => {},
		recordFlightPathEvent: () => {},
		registerDiskIngestPort: (_p: DiskIngestPort) => {},
		whenVaultIndexReady: () => Promise.resolve(),
	});

	return {
		controller,
		ytext,
		traces,
		flushCalls,
		setBaseline: (hash: string) => { diskIndex = { [PATH]: { mtime: 1, size: OLD.length, contentHash: hash } }; },
		baseline: () => diskIndex[PATH]?.contentHash ?? null,
	};
}

const oldHash = await contentBaselineHash(OLD);
const newHash = await contentBaselineHash(NEW);

let baselineAfterTest1: string | null = null;

s.section("Test 1: a failed flush holds the baseline at the disk text");
{
	const f = controllerFixture("failed");
	f.setBaseline(oldHash);
	await f.controller.runReconciliation("authoritative");

	s.check(f.flushCalls.length === 1, "reconcile tried to write the CRDT text to disk (disk-at-baseline)");
	s.check(f.ytext.toString() === NEW, "CRDT untouched");
	s.check(
		f.baseline() === oldHash,
		`baseline still equals the disk text (got ${f.baseline()?.slice(0, 8)}, old ${oldHash.slice(0, 8)}, new ${newHash.slice(0, 8)})`,
	);
	s.check(
		f.traces.some((t) => t.event === "reconcile-baseline-held" && t.data?.outcome === "failed"),
		"baseline hold is traced with the flush outcome",
	);
	baselineAfterTest1 = f.baseline();
}

s.section("Test 2: the next reconcile after a failed flush does not import the stale disk");
{
	// Same device, next boot: disk still OLD, CRDT NEW, baseline as Test 1 left it.
	// This is the 03:44Z step: with the baseline wrongly at NEW, the planner
	// reads "crdt-at-baseline, disk changed" and replaces the CRDT with OLD.
	const f = controllerFixture("failed");
	f.setBaseline(baselineAfterTest1 ?? oldHash);
	await f.controller.runReconciliation("authoritative");
	s.check(f.ytext.toString() === NEW, "second pass: CRDT still holds the new text, nothing imported from disk");
	s.check(
		!f.traces.some((t) => t.event === "closed-file-disk-wins-clean"),
		"no closed-file-disk-wins-clean decision",
	);
}

s.section("Test 3: a written flush advances the baseline to the CRDT text");
{
	const f = controllerFixture("written");
	f.setBaseline(oldHash);
	await f.controller.runReconciliation("authoritative");
	s.check(f.baseline() === newHash, "baseline advanced to the CRDT hash");
	s.check(!f.traces.some((t) => t.event === "reconcile-baseline-held"), "no hold traced");
}

s.section("Test 4: an unchanged flush (disk already equals CRDT) also advances");
{
	const f = controllerFixture("unchanged");
	f.setBaseline(oldHash);
	await f.controller.runReconciliation("authoritative");
	s.check(f.baseline() === newHash, "baseline advanced");
}

s.section("Test 5: deferred and no-ytext flushes hold the baseline too");
for (const outcome of ["deferred", "no-ytext"] as FlushWriteOutcome[]) {
	const f = controllerFixture(outcome);
	f.setBaseline(oldHash);
	await f.controller.runReconciliation("authoritative");
	s.check(f.baseline() === oldHash, `${outcome}: baseline held`);
}

// ---------------------------------------------------------------------------
// DiskMirror.flushWrite reports its outcome.
// ---------------------------------------------------------------------------

function mirrorFixture(diskText: string | null, crdtText: string, traces: Array<{ event: string; data?: Record<string, unknown> }> = []) {
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtText);
	const file = new TFile() as TFile & { path: string };
	file.path = PATH;
	let disk = diskText;
	const vaultSync = partialOf<VaultSync>({
		provider: {} as never,
		ydoc: doc,
		getTextForPath: (p: string) => (p === PATH ? ytext : null),
	});
	const editorBindings = partialOf<EditorBindingManager>({
		getLastEditorActivityForPath: () => null,
	});
	const app = partialOf<App>({
		workspace: { getActiveViewOfType: () => null } as never,
		vault: {
			getAbstractFileByPath: () => (disk === null ? null : file),
			read: async () => disk ?? "",
			modify: async (_f: TFile, content: string) => { disk = content; },
			create: async (_p: string, content: string) => { disk = content; return file; },
			adapter: { exists: async () => true, stat: async () => ({ mtime: 2, size: (disk ?? "").length, ctime: 1, type: "file" }) },
		} as never,
	});
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, (_s, event, data) => traces.push({ event, data }));
	return { mirror, disk: () => disk };
}

s.section("Test 6: flushWrite writes a large frontmatter growth (the John J. Akin transition)");
{
	const traces: Array<{ event: string; data?: Record<string, unknown> }> = [];
	const f = mirrorFixture(OLD, NEW, traces);
	const outcome = await f.mirror.flushWrite(PATH);
	s.check(outcome === "written", `outcome is written (got ${outcome})`);
	s.check(f.disk() === NEW, "disk now holds the CRDT text");
	s.check(
		traces.some((t) => t.event === "frontmatter-write-flagged" && (t.data?.reasons as string[] | undefined)?.includes("frontmatter-growth-burst")),
		"the growth is traced as a flag, not a refusal",
	);
}

s.section("Test 6b: flushWrite writes even a structurally suspect CRDT state (duplicate key)");
{
	const traces: Array<{ event: string; data?: Record<string, unknown> }> = [];
	const dup = "---\ntype: person\ntype: place\n---\nbody\n";
	const f = mirrorFixture(OLD, dup, traces);
	const outcome = await f.mirror.flushWrite(PATH);
	s.check(outcome === "written", `duplicate-key CRDT text is still written (got ${outcome})`);
	s.check(f.disk() === dup, "disk matches the CRDT, so this device shows what the others show");
	s.check(traces.some((t) => t.event === "frontmatter-write-flagged" && t.data?.risk === "block"), "and the structural problem is traced");
}

s.section("Test 7: flushWrite returns written for an ordinary update and unchanged when disk already matches");
{
	const f = mirrorFixture(OLD, OLD + "more\n");
	const first = await f.mirror.flushWrite(PATH);
	s.check(first === "written", `first flush written (got ${first})`);
	s.check(f.disk() === OLD + "more\n", "disk now holds the CRDT text");
	const second = await f.mirror.flushWrite(PATH);
	s.check(second === "unchanged", `second flush unchanged (got ${second})`);
}

s.section("Test 8: flushWrite returns no-ytext when the path has no Y.Text");
{
	const f = mirrorFixture(OLD, OLD);
	const outcome = await f.mirror.flushWrite("Notes/none.md");
	s.check(outcome === "no-ytext", `got ${outcome}`);
}

await s.done();
