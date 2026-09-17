// Regression for the bind-retry starvation bug (2026-09-17).
//
// When a note opens, the collab compartment reconfigure often does not stick
// because Obsidian is still loading the file into the view. The manager's
// health check is meant to retry. Before this policy existed, every live
// editor update (each keystroke) cleared the pending retry timer and
// rescheduled a "deferred" check that could never itself repair, so the
// facet attached only after an 850 ms typing pause. Keystrokes in that
// window reached disk via autosave but never the CRDT, and the reconciler
// minted a conflict pair at the five-second mark.
//
// The policy is pure so this suite can pin the rules without CodeMirror.

import {
	decideHealthAction,
	MISSING_FACET_RETRY_DELAY_MS,
	MISSING_FACET_MAX_RETRIES,
} from "../../src/sync/bindingHealthPolicy";
import { suite } from "../harness.ts";

const s = suite("binding-health-policy");

s.section("Test 1: healthy or settling binding → noop");
{
	s.check(
		decideHealthAction({ source: "live-update", issues: [], deferredIssues: [], hasPendingRetry: false, retryCount: 0 }).kind === "noop",
		"healthy is noop",
	);
	s.check(
		decideHealthAction({ source: "post-bind-health", issues: [], deferredIssues: ["missing-sync-facet"], hasPendingRetry: false, retryCount: 0 }).kind === "noop",
		"settling is noop",
	);
}

s.section("Test 2: missing facet with no retry pending → defer with the retry delay");
{
	const a = decideHealthAction({ source: "live-update", issues: ["missing-sync-facet"], deferredIssues: [], hasPendingRetry: false, retryCount: 0 });
	s.check(a.kind === "defer" && a.delayMs === MISSING_FACET_RETRY_DELAY_MS, "defers with MISSING_FACET_RETRY_DELAY_MS");
	s.check(MISSING_FACET_RETRY_DELAY_MS <= 200, "retry delay is short (fits inside a typing burst)");
}

s.section("Test 3: missing facet with a retry already pending → noop (keystrokes must not reschedule)");
{
	for (const source of ["live-update", "status-tick", "post-bind-health", "layout-change"]) {
		const a = decideHealthAction({ source, issues: ["missing-sync-facet"], deferredIssues: [], hasPendingRetry: true, retryCount: 0 });
		s.check(a.kind === "noop", `${source} with pending retry is noop`);
	}
}

s.section("Test 4: the retry itself finds the facet still missing → repair");
{
	const a = decideHealthAction({ source: "retry-health-check", issues: ["missing-sync-facet"], deferredIssues: [], hasPendingRetry: false, retryCount: 0 });
	s.check(a.kind === "repair", "retry repairs");
	const b = decideHealthAction({ source: "retry-health-check", issues: ["missing-sync-facet"], deferredIssues: [], hasPendingRetry: false, retryCount: MISSING_FACET_MAX_RETRIES - 1 });
	s.check(b.kind === "repair", "still repairs on the last allowed attempt");
}

s.section("Test 5: retry cap reached → give-up (log as failed, stop scheduling)");
{
	const a = decideHealthAction({ source: "retry-health-check", issues: ["missing-sync-facet"], deferredIssues: [], hasPendingRetry: false, retryCount: MISSING_FACET_MAX_RETRIES });
	s.check(a.kind === "give-up", "give-up at the cap");
}

s.section("Test 6: any other issue → repair immediately, regardless of source or pending retry");
{
	for (const issues of [["ytext-mismatch"], ["path-changed", "ytext-mismatch"], ["missing-sync-facet", "awareness-mismatch"]]) {
		const a = decideHealthAction({ source: "live-update", issues, deferredIssues: [], hasPendingRetry: true, retryCount: 0 });
		s.check(a.kind === "repair", `${issues.join("+")} repairs`);
	}
}

await s.done();
