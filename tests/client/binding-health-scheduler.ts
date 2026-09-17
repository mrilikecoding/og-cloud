// The scheduler half of the missing-sync-facet retry: owns the per-binding
// timer and retry count, consults decideHealthAction, and calls back into
// the manager to inspect health and run a repair. Driven here with a fake
// clock so a keystroke burst can be replayed deterministically.

import {
	BindingHealthScheduler,
	type SchedulerDeps,
} from "../../src/sync/bindingHealthScheduler";
import {
	MISSING_FACET_RETRY_DELAY_MS,
	MISSING_FACET_MAX_RETRIES,
} from "../../src/sync/bindingHealthPolicy";
import { suite } from "../harness.ts";

const s = suite("binding-health-scheduler");

function fixture(opts: { facetAttachesAfterRepairs?: number } = {}) {
	let now = 0;
	const timers: Array<{ at: number; fn: () => void; id: number; cleared: boolean }> = [];
	let nextId = 1;
	let repairs = 0;
	let facetPresent = false;
	const attachAfter = opts.facetAttachesAfterRepairs ?? 1;
	const events: string[] = [];
	const deps: SchedulerDeps = {
		setTimeout: (fn, ms) => {
			const t = { at: now + ms, fn, id: nextId++, cleared: false };
			timers.push(t);
			return t.id;
		},
		clearTimeout: (id) => {
			const t = timers.find((x) => x.id === id);
			if (t) t.cleared = true;
		},
		inspect: () => ({
			issues: facetPresent ? [] : ["missing-sync-facet"],
			deferredIssues: [],
		}),
		repair: () => {
			repairs += 1;
			if (repairs >= attachAfter) facetPresent = true;
			events.push(`repair@${now}`);
			return true;
		},
		onGiveUp: () => events.push(`give-up@${now}`),
		trace: (event) => events.push(`${event}@${now}`),
	};
	const sched = new BindingHealthScheduler(deps);
	const advance = (ms: number) => {
		const target = now + ms;
		for (;;) {
			const due = timers.filter((t) => !t.cleared && t.at <= target).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			now = due.at;
			due.cleared = true;
			due.fn();
		}
		now = target;
	};
	return { sched, advance, events, timers, get now() { return now; }, get repairs() { return repairs; }, get facetPresent() { return facetPresent; } };
}

const LEAF = "leaf-1";

s.section("Test 1: a keystroke burst cannot starve the retry");
{
	const f = fixture();
	f.sched.check(LEAF, "post-bind-health");
	// 80 ms between keystrokes for two seconds, each one a live-update check.
	for (let t = 0; t < 2000; t += 80) {
		f.advance(80);
		f.sched.check(LEAF, "live-update");
	}
	s.check(f.repairs >= 1, "a repair ran during the burst");
	const firstRepair = f.events.find((e) => e.startsWith("repair@"));
	const at = Number(firstRepair?.split("@")[1] ?? -1);
	s.check(at >= 0 && at <= MISSING_FACET_RETRY_DELAY_MS + 80, `first repair by ${at}ms (limit ${MISSING_FACET_RETRY_DELAY_MS + 80})`);
	s.check(f.facetPresent, "facet present after the burst");
}

s.section("Test 2: a live-update check while a retry is pending does not reschedule it");
{
	const f = fixture();
	f.sched.check(LEAF, "post-bind-health");
	const before = f.timers.filter((t) => !t.cleared).length;
	f.advance(50);
	f.sched.check(LEAF, "live-update");
	f.sched.check(LEAF, "status-tick");
	const after = f.timers.filter((t) => !t.cleared).length;
	s.check(before === 1 && after === 1, "exactly one live timer before and after");
	s.check(f.timers.filter((t) => !t.cleared)[0]!.at === MISSING_FACET_RETRY_DELAY_MS, "the original timer is untouched");
}

s.section("Test 3: retries repeat on the fixed cadence until the facet attaches");
{
	const f = fixture({ facetAttachesAfterRepairs: 3 });
	f.sched.check(LEAF, "post-bind-health");
	f.advance(MISSING_FACET_RETRY_DELAY_MS * 3 + 5);
	s.check(f.repairs === 3, `three repairs (${f.repairs})`);
	s.check(f.facetPresent, "facet attached on the third");
	f.advance(MISSING_FACET_RETRY_DELAY_MS * 2);
	s.check(f.repairs === 3, "no further repairs once healthy");
}

s.section("Test 4: give-up at the cap sticks until the binding is released");
{
	const f = fixture({ facetAttachesAfterRepairs: 999 });
	f.sched.check(LEAF, "post-bind-health");
	f.advance(MISSING_FACET_RETRY_DELAY_MS * (MISSING_FACET_MAX_RETRIES + 2));
	s.check(f.repairs === MISSING_FACET_MAX_RETRIES, `stopped at the cap (${f.repairs})`);
	s.check(f.events.some((e) => e.startsWith("give-up@")), "give-up reported");
	s.check(f.timers.every((t) => t.cleared), "no timer left after give-up");
	f.sched.check(LEAF, "status-tick");
	s.check(f.timers.every((t) => t.cleared), "a later facet-only check does not reopen the loop");
	f.sched.clear(LEAF);
	f.sched.check(LEAF, "post-bind-health");
	s.check(f.timers.filter((t) => !t.cleared).length === 1, "after clear (rebind) a new episode may start");
}

s.section("Test 5: a healthy check clears the episode");
{
	const f = fixture();
	f.sched.check(LEAF, "post-bind-health");
	f.advance(MISSING_FACET_RETRY_DELAY_MS + 1);
	s.check(f.facetPresent, "repaired");
	f.sched.check(LEAF, "live-update");
	s.check(f.timers.every((t) => t.cleared), "nothing scheduled once healthy");
}

s.section("Test 6: clear(leaf) cancels a pending retry");
{
	const f = fixture();
	f.sched.check(LEAF, "post-bind-health");
	f.sched.clear(LEAF);
	f.advance(MISSING_FACET_RETRY_DELAY_MS * 2);
	s.check(f.repairs === 0, "no repair after clear");
}

s.section("Test 7: a non-facet issue repairs immediately even with a retry pending");
{
	const f = fixture();
	f.sched.check(LEAF, "post-bind-health");
	let calls = 0;
	const deps2: SchedulerDeps = {
		setTimeout: () => 0,
		clearTimeout: () => undefined,
		inspect: () => ({ issues: ["ytext-mismatch"], deferredIssues: [] }),
		repair: () => { calls += 1; return true; },
		onGiveUp: () => undefined,
		trace: () => undefined,
	};
	const sched2 = new BindingHealthScheduler(deps2);
	sched2.check(LEAF, "live-update");
	s.check(calls === 1, "immediate repair for ytext-mismatch");
}

s.section("Test 8: a repair that re-enters with a post-bind check cannot reset the retry count");
{
	// In the manager, repair() → applyBinding() → schedulePostBindHealthCheck()
	// fires a "post-bind-health" check into this same scheduler while the
	// retry episode is live. That check must be a noop, so the cap still
	// accumulates and give-up is reachable for a persistently broken bind.
	let now = 0;
	const timers: Array<{ at: number; fn: () => void; id: number; cleared: boolean }> = [];
	let nextId = 1;
	let repairs = 0;
	let gaveUp = false;
	let schedRef: BindingHealthScheduler | null = null;
	const deps: SchedulerDeps = {
		setTimeout: (fn, ms) => { const t = { at: now + ms, fn, id: nextId++, cleared: false }; timers.push(t); return t.id; },
		clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; },
		inspect: () => ({ issues: ["missing-sync-facet"], deferredIssues: [] }),
		repair: () => {
			repairs += 1;
			// Simulate applyBinding's post-bind timer landing later and re-checking.
			timers.push({ at: now + 850, fn: () => schedRef?.check(LEAF, "post-bind-health"), id: nextId++, cleared: false });
			return true;
		},
		onGiveUp: () => { gaveUp = true; },
		trace: () => undefined,
	};
	const sched = new BindingHealthScheduler(deps);
	schedRef = sched;
	const advance = (ms: number) => {
		const target = now + ms;
		for (;;) {
			const due = timers.filter((t) => !t.cleared && t.at <= target).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			now = due.at; due.cleared = true; due.fn();
		}
		now = target;
	};
	sched.check(LEAF, "post-bind-health");
	advance(MISSING_FACET_RETRY_DELAY_MS * (MISSING_FACET_MAX_RETRIES + 3) + 900);
	s.check(gaveUp, "give-up reached despite re-entrant post-bind checks");
	s.check(repairs === MISSING_FACET_MAX_RETRIES, `exactly the cap of repairs (${repairs})`);
}

await s.done();
