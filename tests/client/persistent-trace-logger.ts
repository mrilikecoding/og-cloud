import type { App, Stat } from "obsidian";
import { PersistentTraceLogger } from "../../src/telemetry/debug/trace";
import { sleep } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

const s = suite("persistent-trace-logger");

function makeFakeApp(preexisting: Record<string, number> = {}) {
	const writes = new Map<string, string>();
	// Day directories already on disk, as <path, size>, so retention has
	// something to prune.
	const sizes = new Map<string, number>(Object.entries(preexisting));
	const removed: string[] = [];
	const childrenOf = (dir: string) => {
		const prefix = `${dir}/`;
		const files: string[] = [];
		const folders = new Set<string>();
		for (const path of sizes.keys()) {
			if (!path.startsWith(prefix)) continue;
			const rest = path.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash === -1) files.push(path);
			else folders.add(`${prefix}${rest.slice(0, slash)}`);
		}
		return { files, folders: [...folders] };
	};
	return {
		writes,
		removed,
		remainingDays: () => [...new Set([...sizes.keys()].map((p) => p.split("/").at(-2)!))].sort(),
		app: partialOf<App>({
			vault: {
				configDir: ".obsidian",
				adapter: {
					mkdir: async () => {},
					exists: async () => true,
					list: async (path: string) => childrenOf(path),
					stat: async (path: string) =>
						(sizes.has(path)
							? ({ type: "file", ctime: 0, mtime: 0, size: sizes.get(path)! } as Stat)
							: null),
					remove: async (path: string) => { sizes.delete(path); removed.push(path); },
					rmdir: async () => {},
					write: async (path: string, data: string) => {
						writes.set(path, data);
					},
					append: async (path: string, data: string) => {
						writes.set(path, (writes.get(path) ?? "") + data);
					},
				},
			},
		}),
	};
}

const RETENTION_DAY_MS = 86_400_000;
const daysAgo = (n: number): string =>
	new Date(Date.now() - n * RETENTION_DAY_MS).toISOString().slice(0, 10);

s.section("Test 1: persistent trace logger drops instead of growing unbounded");
{
	const fake = makeFakeApp();
	const logger = new PersistentTraceLogger(fake.app, {
		enabled: true,
		deviceName: "Device",
		vaultId: "vault",
	});

	for (let i = 0; i < 2_500; i++) {
		logger.record("test", "storm", { i, path: `Private/${i}.md` });
	}
	await logger.shutdown();

	const sessionLog = [...fake.writes.entries()]
		.find(([path]) => path.endsWith(".ndjson") && !path.endsWith("-state.ndjson"))?.[1] ?? "";
	const lines = sessionLog.trim().split("\n").filter(Boolean);
	const dropped = lines
		.map((line) => JSON.parse(line))
		.find((event) => event.msg === "trace-events-dropped");

	s.check(Boolean(dropped), "trace storm emits a dropped-event marker");
	s.check(dropped?.details?.count > 0, "dropped-event marker reports how many events were dropped");
	s.check(lines.length <= 2_002, "trace storm log stays bounded after marker and shutdown event");
}
s.section("Test 2: state history stops growing at its cap; current state keeps updating");
{
	const fake = makeFakeApp();
	const logger = new PersistentTraceLogger(fake.app, {
		enabled: true,
		deviceName: "Device",
		vaultId: "vault",
		maxStateHistoryBytes: 5_000,
	});
	const state = (i: number) => ({ i, pad: "x".repeat(1_500) });
	for (let i = 0; i < 6; i++) {
		logger.updateCurrentState(state(i));
		await sleep(700); // past STATE_WRITE_DELAY_MS so each update lands
	}
	await logger.shutdown();

	const history = [...fake.writes.entries()].find(([path]) => path.endsWith("-state.ndjson"))?.[1] ?? "";
	const current = [...fake.writes.entries()].find(([path]) => path.endsWith("current-state.json"))?.[1] ?? "";
	const sessionLog = [...fake.writes.entries()]
		.find(([path]) => path.endsWith(".ndjson") && !path.endsWith("-state.ndjson"))?.[1] ?? "";
	const historyLines = history.trim().split("\n").filter(Boolean).length;

	s.check(historyLines >= 3 && historyLines < 6, `history stops at the cap (${historyLines} of 6 states kept)`);
	s.check(history.length <= 5_000 + 1_600, `history stays near the cap (${history.length} bytes)`);
	s.check(JSON.parse(current).i === 5, "current-state.json still reflects the latest state");
	s.check(sessionLog.includes("state-history-capped"), "a capped marker is recorded once in the event log");
	s.check(sessionLog.split("state-history-capped").length === 2, "the marker is recorded only once");
}
s.section("Test: old day directories are pruned when the logger starts");
{
	// 489 MB had accumulated over 10 days on the Svalbard Mac because nothing
	// ever deleted a day under logs/. Debug mode is per device and now on a
	// phone, so an unbounded log is a storage leak there.
	const fake = makeFakeApp({
		[`.obsidian/plugins/og-cloud/logs/${daysAgo(30)}/boot-ancient-state.ndjson`]: 16_000_000,
		[`.obsidian/plugins/og-cloud/logs/${daysAgo(9)}/boot-old-state.ndjson`]: 16_000_000,
		[`.obsidian/plugins/og-cloud/logs/${daysAgo(2)}/boot-recent-state.ndjson`]: 1_000,
	});
	const logger = new PersistentTraceLogger(fake.app, {
		enabled: true,
		deviceName: "Device",
		vaultId: "vault",
	});

	await logger.enforceRetention();

	s.check(!fake.remainingDays().includes(daysAgo(30)), "a 30-day-old day directory is gone");
	s.check(!fake.remainingDays().includes(daysAgo(9)), "a 9-day-old day directory is gone");
	s.check(fake.remainingDays().includes(daysAgo(2)), "a 2-day-old day directory is kept");
	await logger.shutdown();
}

s.section("Test: retention never runs when debug mode is off");
{
	const fake = makeFakeApp({
		[`.obsidian/plugins/og-cloud/logs/${daysAgo(30)}/boot-ancient-state.ndjson`]: 10,
	});
	const logger = new PersistentTraceLogger(fake.app, {
		enabled: false,
		deviceName: "Device",
		vaultId: "vault",
	});

	await logger.enforceRetention();

	s.check(fake.removed.length === 0, "a disabled logger touches no files");
}

await s.done();
