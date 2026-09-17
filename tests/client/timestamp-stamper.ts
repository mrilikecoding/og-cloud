import * as Y from "yjs";
import {
	TimestampStamper,
	TIMESTAMP_DEBOUNCE_MS,
	type TimestampStamperDeps,
} from "../../src/sync/timestampStamper";
import { ORIGIN_TIMESTAMP } from "../../src/sync/origins";
import { suite } from "../harness.ts";

const s = suite("timestamp-stamper");

const USER = { __kind: "YSyncConfig" };
const PROVIDER = { __kind: "provider" };

function fixture(overrides: Partial<TimestampStamperDeps> = {}) {
	const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
	let clock = "2026-09-16T21:00:00-07:00";
	const traces: Array<{ event: string; data?: Record<string, unknown> }> = [];
	const deps: TimestampStamperDeps = {
		isUserOrigin: (origin) => origin === USER,
		now: () => clock,
		isEnabled: () => true,
		setTimeout: (fn, ms) => {
			const t = { fn, ms, cleared: false };
			timers.push(t);
			return t;
		},
		clearTimeout: (handle) => {
			(handle as { cleared: boolean }).cleared = true;
		},
		trace: (_source, event, data) => traces.push({ event, data }),
		...overrides,
	};
	const stamper = new TimestampStamper(deps);
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	const typeAs = (origin: unknown, text: string) =>
		doc.transact(() => ytext.insert(ytext.length, text), origin);
	const firePending = () => {
		const live = timers.filter((t) => !t.cleared);
		timers.length = 0;
		for (const t of live) t.fn();
	};
	const setClock = (v: string) => { clock = v; };
	return { stamper, doc, ytext, typeAs, timers, firePending, setClock, traces };
}

s.section("Test 1: a burst of user edits collapses to one stamp after the debounce");
{
	const f = fixture();
	f.stamper.watch(f.ytext, "a.md");
	f.typeAs(USER, "h");
	f.typeAs(USER, "e");
	f.typeAs(USER, "y");
	const live = f.timers.filter((t) => !t.cleared);
	s.check(live.length === 1, "one live timer after three edits");
	s.check(live[0]!.ms === TIMESTAMP_DEBOUNCE_MS, "debounce is 2000ms");
	f.firePending();
	s.check(f.ytext.toString() === "---\nmodified: 2026-09-16T21:00:00-07:00\n---\nhey", "stamped once");
}

s.section("Test 2: the stamp's own transaction does not re-trigger a stamp");
{
	const f = fixture();
	f.stamper.watch(f.ytext, "a.md");
	f.typeAs(USER, "x");
	f.firePending();
	s.check(f.timers.filter((t) => !t.cleared).length === 0, "no timer scheduled by the stamp itself");
}

s.section("Test 3: remote and repair origins do not stamp");
{
	const f = fixture();
	f.stamper.watch(f.ytext, "a.md");
	f.typeAs(PROVIDER, "remote");
	f.typeAs("disk-sync", "repair");
	f.typeAs(ORIGIN_TIMESTAMP, "self");
	s.check(f.timers.length === 0, "no timers");
	s.check(f.ytext.toString() === "remoterepairself", "text untouched");
}

s.section("Test 4: born-empty note gets created once, later stamps only touch modified");
{
	const f = fixture();
	f.stamper.markBornEmpty("Untitled.md");
	f.stamper.watch(f.ytext, "Untitled.md");
	f.typeAs(USER, "first");
	f.firePending();
	s.check(
		f.ytext.toString() === "---\ncreated: 2026-09-16T21:00:00-07:00\nmodified: 2026-09-16T21:00:00-07:00\n---\nfirst",
		"created and modified seeded",
	);
	f.setClock("2026-09-16T21:05:00-07:00");
	f.typeAs(USER, " second");
	f.firePending();
	s.check(
		f.ytext.toString() === "---\ncreated: 2026-09-16T21:00:00-07:00\nmodified: 2026-09-16T21:05:00-07:00\n---\nfirst second",
		"created kept, modified advanced",
	);
}

s.section("Test 5: a path never marked born-empty never gets created");
{
	const f = fixture();
	f.stamper.watch(f.ytext, "old.md");
	f.typeAs(USER, "edit");
	f.firePending();
	s.check(!f.ytext.toString().includes("created:"), "no created");
}

s.section("Test 6: the stamp transaction carries ORIGIN_TIMESTAMP");
{
	const f = fixture();
	let seen: unknown = "unset";
	f.ytext.observe((_e, txn) => { if (txn.origin !== USER) seen = txn.origin; });
	f.stamper.watch(f.ytext, "a.md");
	f.typeAs(USER, "x");
	f.firePending();
	s.check(seen === ORIGIN_TIMESTAMP, "origin is ORIGIN_TIMESTAMP");
}

s.section("Test 7: last unwatch flushes a pending stamp immediately and detaches");
{
	const f = fixture();
	f.stamper.watch(f.ytext, "a.md");
	f.stamper.watch(f.ytext, "a.md"); // second pane
	f.typeAs(USER, "x");
	f.stamper.unwatch(f.ytext);
	s.check(!f.ytext.toString().includes("modified:"), "still pending while one pane remains");
	f.stamper.unwatch(f.ytext);
	s.check(f.ytext.toString().includes("modified:"), "flushed on last unwatch");
	s.check(f.timers.every((t) => t.cleared), "timer cleared");
	f.typeAs(USER, "y");
	s.check(f.timers.filter((t) => !t.cleared).length === 0, "observer detached: no new timer");
}

s.section("Test 8: disabled → inert");
{
	const f = fixture({ isEnabled: () => false });
	f.stamper.watch(f.ytext, "a.md");
	f.typeAs(USER, "x");
	s.check(f.timers.length === 0, "no timer");
	f.stamper.unwatch(f.ytext);
	s.check(f.ytext.toString() === "x", "nothing written");
}

s.section("Test 9: dispose cancels pending stamps and detaches");
{
	const f = fixture();
	f.stamper.watch(f.ytext, "a.md");
	f.typeAs(USER, "x");
	f.stamper.dispose();
	s.check(f.timers.every((t) => t.cleared), "timer cleared");
	f.firePending();
	s.check(f.ytext.toString() === "x", "pending stamp dropped");
}

s.section("Test 10: a stamp emits a trace event with the path");
{
	const f = fixture();
	f.stamper.watch(f.ytext, "Notes/a.md");
	f.typeAs(USER, "x");
	f.firePending();
	const t = f.traces.find((x) => x.event === "timestamp-stamped");
	s.check(t !== undefined && t.data?.path === "Notes/a.md", "traced with path");
}

s.section("Test 11: born-empty status survives an unwatch/watch cycle with no edits in between");
{
	const f = fixture();
	f.stamper.markBornEmpty("Untitled.md");
	f.stamper.watch(f.ytext, "Untitled.md");
	f.stamper.unwatch(f.ytext); // closed before typing anything: no timer, nothing flushed
	f.stamper.watch(f.ytext, "Untitled.md"); // reopened
	f.typeAs(USER, "first");
	f.firePending();
	s.check(
		f.ytext.toString().includes("created:"),
		"created written on reopen even though the first watch never stamped",
	);

	f.stamper.unwatch(f.ytext);
	f.stamper.watch(f.ytext, "Untitled.md");
	f.setClock("2026-09-16T21:05:00-07:00");
	f.typeAs(USER, " second");
	f.firePending();
	s.check(
		f.ytext.toString() === "---\ncreated: 2026-09-16T21:00:00-07:00\nmodified: 2026-09-16T21:05:00-07:00\n---\nfirst second",
		"created flag consumed by the first stamp, not re-stamped on the later one",
	);
}

await s.done();
