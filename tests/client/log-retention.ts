// Log retention (2026-09-24): day-level pruning for the plugin's on-disk log
// roots, extracted from FlightRecorder so the plain trace logger can share it.
//
// FlightRecorder capped flight-logs/ at 7 days and 100 MB. The plain logger
// under logs/ capped each boot's state history at 16 MB but never deleted a
// day, so it grew without bound: 489 MB across 10 days on the Svalbard Mac,
// 448 MB of it in -state.ndjson files, with 2026-09-15 still present ten days
// on. Debug mode is per device and now on a phone, where that is a leak.
//
// The algorithm is unchanged, so these tests pin the behaviour that was
// already shipping for flight-logs before the plain logger started using it.

import { enforceLogRetention, type RetentionAdapter } from "../../src/telemetry/debug/logRetention";
import { suite } from "../harness.ts";

const s = suite("log-retention");

const DAY_MS = 86_400_000;
const day = (offsetDays: number): string =>
	new Date(Date.now() - offsetDays * DAY_MS).toISOString().slice(0, 10);

/** In-memory adapter: files keyed by full path, sizes in bytes. */
function makeAdapter(files: Record<string, number>) {
	const store = new Map<string, number>(Object.entries(files));
	const removed: string[] = [];
	const rmdirs: string[] = [];

	const childrenOf = (dir: string) => {
		const prefix = `${dir}/`;
		const directFiles: string[] = [];
		const folders = new Set<string>();
		for (const path of store.keys()) {
			if (!path.startsWith(prefix)) continue;
			const rest = path.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash === -1) directFiles.push(path);
			else folders.add(`${prefix}${rest.slice(0, slash)}`);
		}
		return { files: directFiles, folders: [...folders] };
	};

	const adapter: RetentionAdapter = {
		exists: async (path) => path === "root" || [...store.keys()].some((p) => p.startsWith(`${path}/`)),
		list: async (path) => childrenOf(path),
		stat: async (path) => (store.has(path) ? { size: store.get(path)! } : null),
		remove: async (path) => { store.delete(path); removed.push(path); },
		rmdir: async (path) => { rmdirs.push(path); },
	};

	return { adapter, store, removed, rmdirs, remainingDays: () => [...new Set([...store.keys()].map((p) => p.split("/")[1]!))].sort() };
}

s.section("Test 1: day directories older than the cutoff are deleted");
{
	const a = makeAdapter({
		[`root/${day(9)}/boot-old.ndjson`]: 1_000,
		[`root/${day(8)}/boot-old2.ndjson`]: 1_000,
		[`root/${day(2)}/boot-recent.ndjson`]: 1_000,
		[`root/${day(0)}/boot-today.ndjson`]: 1_000,
	});
	await enforceLogRetention(a.adapter, "root", { maxDays: 7, maxTotalBytes: 100_000_000 });
	s.check(!a.remainingDays().includes(day(9)), "9-day-old directory removed");
	s.check(!a.remainingDays().includes(day(8)), "8-day-old directory removed");
	s.check(a.remainingDays().includes(day(2)), "2-day-old directory kept");
	s.check(a.remainingDays().includes(day(0)), "today kept");
	s.check(a.rmdirs.length > 0, "the emptied directories are rmdir'd, not just their files");
}

s.section("Test 2: oldest days are deleted until the total byte cap is met");
{
	// 120 bytes against a 100-byte cap: dropping the oldest day alone gets
	// under it, so the middle day must survive.
	const a = makeAdapter({
		[`root/${day(5)}/boot-a-state.ndjson`]: 60,
		[`root/${day(3)}/boot-b-state.ndjson`]: 30,
		[`root/${day(0)}/boot-c-state.ndjson`]: 30,
	});
	await enforceLogRetention(a.adapter, "root", { maxDays: 7, maxTotalBytes: 100 });
	s.check(!a.remainingDays().includes(day(5)), "oldest day dropped to get under the cap");
	s.check(a.remainingDays().includes(day(0)), "today is never deleted for size");
	s.check(a.remainingDays().includes(day(3)), "deletion stops once the total is under the cap");
}

s.section("Test 3: today is exempt even when it alone exceeds the cap");
{
	const a = makeAdapter({ [`root/${day(0)}/boot-huge-state.ndjson`]: 5_000 });
	await enforceLogRetention(a.adapter, "root", { maxDays: 7, maxTotalBytes: 100 });
	s.check(a.remainingDays().includes(day(0)), "the active day survives; the per-file cap bounds it instead");
}

s.section("Test 4: non-date directories and a missing root are left alone");
{
	const a = makeAdapter({ "root/scratch/notes.txt": 10, [`root/${day(9)}/boot-old.ndjson`]: 10 });
	await enforceLogRetention(a.adapter, "root", { maxDays: 7, maxTotalBytes: 1 });
	s.check(a.remainingDays().includes("scratch"), "a directory that is not a date is never pruned");

	const empty = makeAdapter({});
	let threw = false;
	try {
		await enforceLogRetention(empty.adapter, "missing", { maxDays: 7, maxTotalBytes: 1 });
	} catch { threw = true; }
	s.check(!threw, "a missing root is a no-op rather than an error");
}

s.section("Test 5: an adapter that throws does not propagate");
{
	const hostile: RetentionAdapter = {
		exists: async () => true,
		list: async () => { throw new Error("adapter down"); },
		stat: async () => null,
		remove: async () => {},
		rmdir: async () => {},
	};
	let threw = false;
	try {
		await enforceLogRetention(hostile, "root", { maxDays: 7, maxTotalBytes: 1 });
	} catch { threw = true; }
	s.check(!threw, "retention failures stay non-fatal: logging must never break sync");
}

void s.done();
