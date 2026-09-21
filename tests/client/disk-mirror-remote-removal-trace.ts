// Observability (2026-09-21): a remote transaction that hard-removes an
// ACTIVE meta entry must leave a trace.
//
// On 2026-09-21 "Tunnel 13 v2.md" lost its CRDT entry three times: the entry
// was removed outright (no tombstone) by a remote transaction, the Mac saw
// only a later ytext-mismatch and re-created the note from disk. Nothing in
// the Mac's log named the moment, so the event could not be lined up with
// the other device's activity. Yjs cannot say who deleted an entry, but the
// entry's own device field and the wall clock are enough to correlate.
//
// Tombstones (kind "deleted") and local removals (integrity cleanup, seed,
// restore) are already covered elsewhere and must not fire this.

import * as Y from "yjs";
import type { App, TAbstractFile } from "obsidian";
import { DiskMirror } from "../../src/sync/diskMirror";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import type { VaultSync } from "../../src/sync/vaultSync";
import type { TraceRecord } from "../../src/observability/traceContext";
import { partialOf } from "../mocks/productFixture.ts";
import { ORIGIN_SEED } from "../../src/sync/origins";
import { isLocalOrigin } from "../../src/sync/origins";
import {
	buildMetaSnapshot,
	extractAffectedFileIds,
	computeIncrementalMetaChanges,
	isFileMetaDeletedValue,
	type MetaChangeBatch,
} from "../../src/sync/fileMeta";
import { suite } from "../harness.ts";

const s = suite("disk-mirror-remote-removal-trace");

const ACTIVE_PATH = "Notes/Writing/Tunnel 13/Tunnel 13 v2.md";
const ACTIVE_ID = "active-001";
const TOMB_PATH = "Notes/old.md";
const TOMB_ID = "tomb-001";

interface TraceCall { source: string; message: string; details?: Record<string, unknown> }

function makeHarness() {
	const doc = new Y.Doc();
	const meta = doc.getMap<{ path: string; deleted?: boolean; deletedAt?: number; device?: string }>("meta");
	const ytext = doc.getText("content");
	const fakeProvider = partialOf<VaultSync["provider"]>({ roomname: "fake-provider" });

	doc.transact(() => {
		meta.set(ACTIVE_ID, { path: ACTIVE_PATH, deleted: false, device: "device-phone" });
		meta.set(TOMB_ID, { path: TOMB_PATH, deleted: true, deletedAt: 1 });
	});

	const fakeVaultSync = partialOf<VaultSync>({
		provider: fakeProvider,
		ydoc: doc,
		meta,
		getTextForPath: (path: string) => (path === ACTIVE_PATH ? ytext : null),
		getFileIdForText: (text: Y.Text) => (text === ytext ? ACTIVE_ID : undefined),
		idToText: new Map<string, Y.Text>([[ACTIVE_ID, ytext]]) as unknown as VaultSync["idToText"],
		isFileMetaDeleted: (m: unknown) => isFileMetaDeletedValue(m),
		observeMetaChanges: (() => {
			const snapshot = buildMetaSnapshot(meta as Y.Map<unknown>);
			const listeners = new Set<(batch: MetaChangeBatch) => void>();
			(meta as Y.Map<unknown>).observeDeep((events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
				const origin = events[0]?.transaction.origin;
				const isLocal = isLocalOrigin(origin, fakeProvider);
				const affected = extractAffectedFileIds(events, meta as Y.Map<unknown>);
				if (!affected) return;
				const changes = computeIncrementalMetaChanges(snapshot, meta as Y.Map<unknown>, affected);
				if (changes.length === 0) return;
				const batch: MetaChangeBatch = { origin, isLocal, changes };
				for (const listener of listeners) listener(batch);
			});
			return (cb: (batch: MetaChangeBatch) => void) => {
				listeners.add(cb);
				return () => { listeners.delete(cb); };
			};
		})(),
	});

	const fakeEditorBindings = partialOf<EditorBindingManager>({
		getLastEditorActivityForPath: () => null,
	});

	const onDisk = new Set<string>([ACTIVE_PATH]);
	const fakeApp = partialOf<App>({
		workspace: { getActiveViewOfType: () => null },
		vault: {
			getAbstractFileByPath: (p: string): TAbstractFile | null =>
				(onDisk.has(p) ? ({ path: p } as TAbstractFile) : null),
		},
	});

	const traces: TraceCall[] = [];
	const trace: TraceRecord = (source, message, details) => {
		traces.push({ source, message, details });
	};

	const mirror = new DiskMirror(fakeApp, fakeVaultSync, fakeEditorBindings, false, trace);
	mirror.startMapObservers();

	const removals = () => traces.filter((t) => t.message === "meta-remote-active-removed");
	return { doc, meta, fakeProvider, removals };
}

s.section("Test 1: a remote hard-removal of an active entry is traced with path, id and device");
{
	const h = makeHarness();
	h.doc.transact(() => { h.meta.delete(ACTIVE_ID); }, h.fakeProvider);
	const got = h.removals();
	s.check(got.length === 1, "exactly one meta-remote-active-removed trace");
	const d = got[0]?.details ?? {};
	s.check(d.path === ACTIVE_PATH, "trace carries the path");
	s.check(d.fileId === ACTIVE_ID, "trace carries the file id");
	s.check(d.device === "device-phone", "trace carries the entry's creating device");
	s.check(d.onDisk === true, "trace says whether the path still exists on disk");
}

s.section("Test 2: a local removal (integrity cleanup, seed) is not traced");
{
	const h = makeHarness();
	h.doc.transact(() => { h.meta.delete(ACTIVE_ID); }, ORIGIN_SEED);
	s.check(h.removals().length === 0, "no trace for a local-origin removal");
}

s.section("Test 3: removing a tombstone is not traced");
{
	const h = makeHarness();
	h.doc.transact(() => { h.meta.delete(TOMB_ID); }, h.fakeProvider);
	s.check(h.removals().length === 0, "no trace when the removed entry was already a tombstone");
}

s.section("Test 4: a remote tombstone (kind deleted) is not double-reported as a removal");
{
	const h = makeHarness();
	h.doc.transact(() => { h.meta.set(ACTIVE_ID, { path: ACTIVE_PATH, deleted: true, deletedAt: 2 }); }, h.fakeProvider);
	s.check(h.removals().length === 0, "tombstoning goes through the existing remote-delete path, not the removal trace");
}

void s.done();
