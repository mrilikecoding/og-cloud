import type { App } from "obsidian";
import { PersistentTraceLogger } from "../../src/telemetry/debug/trace";
import { sleep } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

const s = suite("persistent-trace-logger");

function makeFakeApp() {
	const writes = new Map<string, string>();
	return {
		writes,
		app: partialOf<App>({
			vault: {
				configDir: ".obsidian",
				adapter: {
					mkdir: async () => {},
					exists: async () => true,
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
await s.done();
