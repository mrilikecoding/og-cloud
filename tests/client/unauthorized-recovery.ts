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

function harness(opts: { getTicket?: ((force: boolean) => Promise<CachedSocketTicket | null>) | null; connect?: () => Promise<void> } = {}) {
	const calls: string[] = [];
	let clock = 1_000_000;
	const rec = new UnauthorizedRecovery({
		getTicket: opts.getTicket === undefined ? async (force) => { calls.push(`getTicket(force=${force})`); return TICKET; } : opts.getTicket,
		disconnect: () => calls.push("disconnect"),
		applyTicket: (t) => calls.push(`applyTicket(${t.value})`),
		connect: opts.connect ?? (async () => { calls.push("connect"); }),
		log: () => {},
		now: () => clock,
	});
	let latched = 0;
	const latch = () => { latched++; };
	const settle = () => new Promise<void>((r) => setTimeout(r, 0));
	return { rec, calls, latch, latched: () => latched, settle, advance: (ms: number) => { clock += ms; } };
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

s.section("Test 7: a transient ticket error (network) neither latches nor reconnects");
{
	const h = harness({ getTicket: async () => { throw new Error("fetch failed"); } });
	h.rec.handle("unauthorized", h.latch);
	await h.settle();
	s.check(h.latched() === 0, "transient error does not latch");
	s.check(!h.calls.includes("connect"), "no reconnect after a transient error (today's behaviour)");
}

await s.done();
