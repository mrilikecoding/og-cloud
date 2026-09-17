/**
 * Plan which excluded markdown files on disk should be removed because the
 * CRDT remembers their path as deleted.
 *
 * Excluded paths (conflict artifacts, user-excluded paths) are filtered out
 * of the reconcile disk scan, so nothing else ever revisits them. When a
 * leaked excluded entry is purged from the CRDT (see reconcileVault's
 * `isPathSyncable`), every device that already materialised the file must
 * remove it; otherwise it lingers unsynced and undeletable.
 *
 * Only paths with a tombstone qualify. A local-only artifact that never
 * entered the CRDT has none and is left alone. Syncable paths are not this
 * planner's concern: the reconciler's tombstone-conflict branch preserves
 * those deliberately.
 */
export interface TombstonedExcludedInput {
	diskMarkdownPaths: readonly string[];
	isPathSyncable(path: string): boolean;
	isMarkdownTombstoned(path: string): boolean;
}

export function planTombstonedExcludedRemovals(input: TombstonedExcludedInput): string[] {
	const out: string[] = [];
	for (const path of input.diskMarkdownPaths) {
		if (input.isPathSyncable(path)) continue;
		if (!input.isMarkdownTombstoned(path)) continue;
		out.push(path);
	}
	return out;
}
