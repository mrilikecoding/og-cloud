/**
 * UnauthorizedRecovery policy tests.
 *
 * Proves: an `unauthorized` frame is answered with a fresh ticket and a
 * reconnect rather than a latched fatal state; the caller latches when the
 * code is not `unauthorized`, when the server has no ticket endpoint, or when
 * a second rejection lands inside the retry window; the recovery itself
 * latches when the fresh ticket is refused (401/403).
 */

import { SocketTicketHttpError, type CachedSocketTicket } from "../../src/sync/socketTicket";
import { UNAUTHORIZED_RETRY_WINDOW_MS, UnauthorizedRecovery } from "../../src/sync/unauthorizedRecovery";
import { suite } from "../harness.ts";

const s = suite("unauthorized-recovery");

const TICKET: CachedSocketTicket = { value: "t2", expiresAt: 1, localExpiresAt: 1, ttlMs: 1 };

type TicketFn = (force: boolean) => Promise<CachedSocketTicket | null>;

function harness(opts: { getTicket?: TicketFn | null; connect?: () => Promise<void> } = {}) {
	const calls: string[] = [];
	const timers: { fn: () => void; ms: number; id: number }[] = [];
	let nextTimer = 1;
	let clock = 1_000_000;
	let connected = false;
	const rec = new UnauthorizedRecovery({
		getTicket: opts.getTicket === undefined ? async (force) => { calls.push(`getTicket(force=${force})`); return TICKET; } : opts.getTicket,
		disconnect: () => calls.push("disconnect"),
		applyTicket: (t) => calls.push(`applyTicket(${t.value})`),
		connect: opts.connect ?? (async () => { calls.push("connect"); }),
		isConnected: () => connected,
		log: () => {},
		now: () => clock,
		setTimer: (fn, ms) => { const id = nextTimer++; timers.push({ fn, ms, id }); return id; },
		clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
	});
	let latched = 0;
	const latch = () => { latched++; };
	const settle = () => new Promise<void>((r) => setTimeout(r, 0));
	/** Fire the oldest pending timer, as the runtime would. */
	const fireTimer = async () => { const t = timers.shift(); if (t) { clock += t.ms; t.fn(); } await settle(); return t?.ms ?? null; };
	return { rec, calls, latch, latched: () => latched, settle, fireTimer, timers, advance: (ms: number) => { clock += ms; }, setConnected: (v: boolean) => { connected = v; } };
}

/** getTicket that fails `failures` times with a network error, then succeeds. */
function flaky(failures: number): TicketFn {
	let n = 0;
	return async () => { if (n++ < failures) throw new Error("fetch failed"); return TICKET; };
}

s.section("Test 1: non-unauthorized codes are left to the caller");
{
	const h = harness();
	s.check(h.rec.handle("update_required", h.latch) === false, "update_required: caller latches");
	s.check(h.rec.handle("unclaimed", h.latch) === false, "unclaimed: caller latches");
	s.check(h.calls.length === 0, "no side effects for non-recoverable codes");
}

s.section("Test 2: no ticket endpoint means no recovery");
{
	const h = harness({ getTicket: null });
	s.check(h.rec.handle("unauthorized", h.latch) === false, "legacy token auth: caller latches");
	s.check(h.calls.length === 0, "no side effects without a ticket endpoint");
}

s.section("Test 3: unauthorized is answered with a fresh ticket and a reconnect");
{
	const h = harness();
	s.check(h.rec.handle("unauthorized", h.latch) === true, "recovery takes over");
	await h.settle();
	s.check(h.calls.join(",") === "disconnect,getTicket(force=true),applyTicket(t2),connect", `order of operations: ${h.calls.join(",")}`);
	s.check(h.latched() === 0, "nothing latched on a successful recovery");
}

s.section("Test 4: a null ticket (endpoint gone) latches");
{
	const h = harness({ getTicket: async () => null });
	h.rec.handle("unauthorized", h.latch);
	await h.settle();
	s.check(h.latched() === 1, "latched once");
	s.check(!h.calls.includes("connect"), "no reconnect attempted");
}

s.section("Test 5: a refused fresh ticket (401/403) latches");
{
	for (const status of [401, 403]) {
		const h = harness({ getTicket: async () => { throw new SocketTicketHttpError(status); } });
		h.rec.handle("unauthorized", h.latch);
		await h.settle();
		s.check(h.latched() === 1, `${status}: latched once`);
		s.check(!h.calls.includes("connect"), `${status}: no reconnect attempted`);
	}
}

s.section("Test 6: a second unauthorized inside the window is left to the caller");
{
	const h = harness();
	h.rec.handle("unauthorized", h.latch);
	await h.settle();
	h.advance(UNAUTHORIZED_RETRY_WINDOW_MS / 2);
	s.check(h.rec.handle("unauthorized", h.latch) === false, "inside window: caller latches");
	h.advance(UNAUTHORIZED_RETRY_WINDOW_MS);
	s.check(h.rec.handle("unauthorized", h.latch) === true, "after window: recovery runs again");
	await h.settle();
}

s.section("Test 7: a transient ticket error is retried with backoff until it succeeds");
{
	const h = harness({ getTicket: flaky(1) });
	h.rec.handle("unauthorized", h.latch);
	await h.settle();
	s.check(h.latched() === 0, "transient error does not latch");
	s.check(!h.calls.includes("connect"), "no reconnect before the ticket is obtained");
	s.check(h.timers.length === 1 && h.timers[0].ms === 2_000, `first retry scheduled at 2 s (got ${h.timers[0]?.ms})`);
	await h.fireTimer();
	s.check(h.calls.filter((c) => c === "connect").length === 1, "reconnected once the retry obtained a ticket");
	s.check(h.calls.filter((c) => c === "disconnect").length === 1, "provider disconnected only once, at the start");
	s.check(h.timers.length === 0, "no retry left pending after success");
}

s.section("Test 8: backoff doubles and caps at 30 s");
{
	const h = harness({ getTicket: flaky(99) });
	h.rec.handle("unauthorized", h.latch);
	await h.settle();
	const delays: number[] = [];
	for (let i = 0; i < 6; i++) delays.push((await h.fireTimer()) ?? -1);
	s.check(delays.join(",") === "2000,4000,8000,16000,30000,30000", `delays: ${delays.join(",")}`);
	s.check(h.latched() === 0, "still not latched after repeated network failures");
	h.rec.dispose();
}

s.section("Test 9: another unauthorized during a recovery is absorbed, not latched");
{
	const h = harness({ getTicket: flaky(1) });
	h.rec.handle("unauthorized", h.latch);
	await h.settle();
	s.check(h.rec.handle("unauthorized", h.latch) === true, "frame during recovery is absorbed");
	s.check(h.latched() === 0, "not latched");
	await h.fireTimer();
	s.check(h.calls.filter((c) => c === "connect").length === 1, "recovery still completes once");
}

s.section("Test 10: dispose cancels a pending retry");
{
	const h = harness({ getTicket: flaky(99) });
	h.rec.handle("unauthorized", h.latch);
	await h.settle();
	s.check(h.timers.length === 1, "a retry is pending");
	h.rec.dispose();
	s.check(h.timers.length === 0, "pending retry cleared on dispose");
}

s.section("Test 11: a retry stands down if something else reconnected meanwhile");
{
	const h = harness({ getTicket: flaky(1) });
	h.rec.handle("unauthorized", h.latch);
	await h.settle();
	h.setConnected(true);
	await h.fireTimer();
	s.check(!h.calls.includes("connect"), "no second connect when already connected");
	s.check(h.timers.length === 0, "no further retry scheduled");
}

await s.done();
