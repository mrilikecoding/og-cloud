// Regression (2026-09-17): an excluded path that nonetheless holds a live
// CRDT entry must be purged, never materialised on disk.
//
// Conflict artifacts and user-excluded paths are classified "excluded" and
// skipped by the disk scan, but reconcileVault iterated every CRDT path and
// created any that was absent from disk — so an artifact that had leaked
// into the CRDT (via the editor-bind hole fixed in og.13, or any other
// route) was written back to disk at every boot and pushed to every device.
// The in-app delete handler is gated on the same syncable predicate, so the
// user could not tombstone it either.
//
// Contract pinned here: reconcileVault takes an `isPathSyncable` predicate;
// a CRDT path failing it is tombstoned and reported under `purgedExcluded`,
// and is never in `createdOnDisk` or `updatedOnDisk`.

import * as Y from "yjs";
import { VaultSync } from "../../src/sync/vaultSync";
import { suite } from "../harness.ts";

const s = suite("excluded-crdt-entries");

function makeVaultSync(): VaultSync {
	const ydoc = new Y.Doc();
	return Object.assign(Object.create(VaultSync.prototype), {
		ydoc,
		pathToId: ydoc.getMap<string>("pathToId"),
		idToText: ydoc.getMap<Y.Text>("idToText"),
		meta: ydoc.getMap<unknown>("meta"),
		sys: ydoc.getMap<unknown>("sys"),
		pathToBlob: ydoc.getMap("pathToBlob"),
		blobMeta: ydoc.getMap("blobMeta"),
		blobTombstones: ydoc.getMap("blobTombstones"),
		_textToFileId: new WeakMap<Y.Text, string>(),
		_pathIndex: new Map<string, string>(),
		_deletedPathIndex: new Set<string>(),
		_pathIndexesDirty: true,
		_localReady: true,
		_providerSynced: true,
		_connectionGeneration: 0,
		_renameBatch: new Map<string, string>(),
		_renameBatchNewToOld: new Map<string, string>(),
		_renameTimer: null,
		_eventRing: [],
		_device: "TestDevice",
		debug: false,
		trace: undefined,
		onFlightEvent: undefined,
		onFlightPathEvent: () => {},
		provider: { wsconnected: false },
	}) as VaultSync;
}

const ARTIFACT = "Notes/Rayna/Labor (YAOS conflict - crdt from device-mu0kz43t 2026-09-17T21-15-08Z).md";
const NOTE = "Notes/Rayna/Labor.md";
const isSyncable = (p: string): boolean => !p.includes("(YAOS conflict");

s.section("Test 1: an excluded CRDT path absent from disk is purged, not created");
{
	const vs = makeVaultSync();
	vs.ensureFile(ARTIFACT, "leaked body", "TestDevice");
	vs.ensureFile(NOTE, "real note", "TestDevice");
	const result = vs.reconcileVault(new Map(), new Set(), "authoritative", "TestDevice", undefined, isSyncable);
	s.check(!result.createdOnDisk.includes(ARTIFACT), "artifact not planned for disk creation");
	s.check(result.createdOnDisk.includes(NOTE), "the real note still is");
	s.check(result.purgedExcluded.includes(ARTIFACT), "artifact reported as purged");
	s.check(vs.isMarkdownTombstoned(ARTIFACT), "artifact is tombstoned in the CRDT");
	s.check(vs.getTextForPath(ARTIFACT) === undefined || vs.getTextForPath(ARTIFACT) === null, "artifact has no live text");
}

s.section("Test 2: an excluded CRDT path that IS on disk is purged from the CRDT and not updated");
{
	const vs = makeVaultSync();
	vs.ensureFile(ARTIFACT, "leaked body", "TestDevice");
	const disk = new Map([[ARTIFACT, "different on disk"]]);
	const result = vs.reconcileVault(disk, new Set([ARTIFACT]), "authoritative", "TestDevice", undefined, isSyncable);
	s.check(!result.updatedOnDisk.includes(ARTIFACT), "not planned for disk update");
	s.check(result.purgedExcluded.includes(ARTIFACT), "purged");
	s.check(vs.isMarkdownTombstoned(ARTIFACT), "tombstoned");
}

s.section("Test 3: without a predicate, behaviour is unchanged (every CRDT path is eligible)");
{
	const vs = makeVaultSync();
	vs.ensureFile(ARTIFACT, "leaked body", "TestDevice");
	const result = vs.reconcileVault(new Map(), new Set(), "authoritative", "TestDevice");
	s.check(result.createdOnDisk.includes(ARTIFACT), "legacy callers still see it as a create");
	s.check(result.purgedExcluded.length === 0, "nothing purged");
}

s.section("Test 4: a purge is idempotent across reconciles");
{
	const vs = makeVaultSync();
	vs.ensureFile(ARTIFACT, "leaked body", "TestDevice");
	vs.reconcileVault(new Map(), new Set(), "authoritative", "TestDevice", undefined, isSyncable);
	const second = vs.reconcileVault(new Map(), new Set(), "authoritative", "TestDevice", undefined, isSyncable);
	s.check(second.purgedExcluded.length === 0, "second pass purges nothing");
	s.check(!second.createdOnDisk.includes(ARTIFACT), "still not created");
}

await s.done();
