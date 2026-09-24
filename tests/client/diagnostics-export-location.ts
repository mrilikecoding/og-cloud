// Export destination (2026-09-24): "Export debug trace" wrote into
// .obsidian/plugins/og-cloud/diagnostics/, which iOS Files hides, so on a
// phone the command worked and produced a file nobody could reach. Debug
// mode is per device and now on a phone, so that was the whole value of it.
//
// The export now lands in a vault-root folder. Non-markdown files outside
// the config dir are blob-syncable, so the export syncs itself to the other
// devices over R2 rather than needing a USB cable. Nothing new is exposed:
// every note path and body is already in that bucket.

import type { App } from "obsidian";
import { DiagnosticsService } from "../../src/telemetry/diagnostics/diagnosticsService";
import { isBlobSyncable } from "../../src/types";
import { partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

const s = suite("diagnostics-export-location");

function makeService() {
	const made: string[] = [];
	const existing = new Set<string>();
	const app = partialOf<App>({
		vault: {
			configDir: ".obsidian",
			adapter: {
				exists: async (path: string) => existing.has(path),
				mkdir: async (path: string) => { made.push(path); existing.add(path); },
			},
		},
	});
	const service = new DiagnosticsService(
		partialOf<ConstructorParameters<typeof DiagnosticsService>[0]>({ app, log: () => {} }),
	);
	return { service, made, existing };
}

s.section("Test 1: the export directory is a vault-root folder, not inside the config dir");
{
	const f = makeService();
	const dir = await f.service.ensureDiagnosticsDir();

	s.check(!dir.startsWith(".obsidian"), `not under the hidden config dir (got "${dir}")`);
	s.check(!dir.includes("/"), `a single root-level folder (got "${dir}")`);
	s.check(dir.length > 0, "a directory is returned");
}

s.section("Test 2: files written there sync to the other devices");
{
	const f = makeService();
	const dir = await f.service.ensureDiagnosticsDir();
	const exported = `${dir}/debug-trace-redacted-2026-09-24.ndjson`;

	s.check(
		isBlobSyncable(exported, [], ".obsidian"),
		"an exported trace is blob-syncable, so it reaches the Mac on its own",
	);
	s.check(
		!isBlobSyncable(".obsidian/plugins/og-cloud/diagnostics/debug-trace.ndjson", [], ".obsidian"),
		"the old location was not syncable, which is why the phone was a dead end",
	);
}

s.section("Test 3: the directory is created once, and only when missing");
{
	const f = makeService();
	const first = await f.service.ensureDiagnosticsDir();
	s.check(f.made.length === 1, "created on first use");

	const second = await f.service.ensureDiagnosticsDir();
	s.check(second === first, "the same directory every time");
	s.check(f.made.length === 1, "not re-created once it exists");
}

void s.done();
