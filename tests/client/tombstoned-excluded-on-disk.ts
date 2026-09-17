// Regression (2026-09-17): an excluded path on disk whose CRDT entry is
// tombstoned must be removed from disk at reconcile.
//
// Excluded paths (conflict artifacts, user-excluded paths) are filtered out
// of the disk scan, so the reconciler never looked at them again once
// present. After og.14 started purging leaked excluded entries from the CRDT
// (tombstoning them), a device that already held the file on disk kept it
// forever: not synced, not deleted. This is the mirror image of the purge.
//
// A local-only artifact that never entered the CRDT has no tombstone and
// must stay; only paths the CRDT explicitly remembers as deleted are
// removed. The planner is pure so this suite can pin it.

import { planTombstonedExcludedRemovals } from "../../src/sync/tombstonedExcluded";
import { suite } from "../harness.ts";

const s = suite("tombstoned-excluded-on-disk");

const A = "Notes/Rayna/Labor (YAOS conflict - crdt from device-x 2026-09-17T21-15-08Z).md";
const B = "Notes/Rayna/Labor (YAOS conflict - disk from device-x 2026-09-17T21-15-08Z).md";
const FRESH = "Notes/Other (YAOS conflict - crdt from device-y 2026-09-17T22-00-00Z).md";
const NOTE = "Notes/Rayna/Labor.md";

function plan(opts: {
	disk: string[];
	syncable: (p: string) => boolean;
	tombstoned: (p: string) => boolean;
}) {
	return planTombstonedExcludedRemovals({
		diskMarkdownPaths: opts.disk,
		isPathSyncable: opts.syncable,
		isMarkdownTombstoned: opts.tombstoned,
	});
}

const artifactExcluded = (p: string): boolean => !p.includes("(YAOS conflict");

s.section("Test 1: an excluded path on disk with a tombstone is planned for removal");
{
	const out = plan({ disk: [A, NOTE], syncable: artifactExcluded, tombstoned: (p) => p === A });
	s.check(out.length === 1 && out[0] === A, "A removed");
}

s.section("Test 2: an excluded path on disk with no tombstone is kept (never entered the CRDT)");
{
	const out = plan({ disk: [FRESH, NOTE], syncable: artifactExcluded, tombstoned: () => false });
	s.check(out.length === 0, "fresh local-only artifact untouched");
}

s.section("Test 3: a syncable note at a tombstoned path is NOT this planner's business");
{
	// The existing tombstone-conflict branch preserves real notes deliberately.
	const out = plan({ disk: [NOTE], syncable: artifactExcluded, tombstoned: (p) => p === NOTE });
	s.check(out.length === 0, "real note left to the tombstone-conflict path");
}

s.section("Test 4: several leaked artifacts, mixed with keepers, all classified correctly");
{
	const out = plan({ disk: [A, B, FRESH, NOTE], syncable: artifactExcluded, tombstoned: (p) => p === A || p === B });
	s.check(out.length === 2 && out.includes(A) && out.includes(B), "A and B removed, FRESH and NOTE kept");
}

await s.done();
