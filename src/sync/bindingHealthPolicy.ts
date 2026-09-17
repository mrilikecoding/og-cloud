/**
 * Decides what the editor binding manager does when a binding's health
 * check reports a problem. Pure, Obsidian-free, so the retry rules can be
 * pinned by a Node suite.
 *
 * Background: the collab compartment reconfigure issued at bind time often
 * does not stick, because Obsidian is still loading the file into the view.
 * Until the ySyncFacet is present, keystrokes reach disk via autosave but
 * not the CRDT, so the window must be closed fast and must not be extended
 * by the user typing. The two rules that matter:
 *
 *   - A pending retry is never cancelled or rescheduled by a health check
 *     from another source. Live editor updates used to do exactly that,
 *     and a typing burst starved the retry indefinitely.
 *   - The retry runs on a short fixed cadence until the facet is present,
 *     up to a cap, rather than once after a long settle window.
 */

export const MISSING_FACET_RETRY_DELAY_MS = 150;
export const MISSING_FACET_MAX_RETRIES = 8;

export const RETRY_SOURCE = "retry-health-check";

export interface HealthState {
	/** Who asked: "post-bind-health", "live-update", "status-tick", RETRY_SOURCE, ... */
	source: string;
	/** Issues that block a healthy verdict. */
	issues: readonly string[];
	/** Issues tolerated inside the settle window. */
	deferredIssues: readonly string[];
	/** True when a retry timer for this binding is already scheduled. */
	hasPendingRetry: boolean;
	/** Retries already attempted for the current missing-facet episode. */
	retryCount: number;
}

export type HealthAction =
	| { kind: "noop" }
	| { kind: "defer"; delayMs: number }
	| { kind: "repair" }
	| { kind: "give-up" };

export function decideHealthAction(state: HealthState): HealthAction {
	if (state.issues.length === 0) return { kind: "noop" };

	const onlyMissingFacet =
		state.issues.length === 1 && state.issues[0] === "missing-sync-facet";
	if (!onlyMissingFacet) return { kind: "repair" };

	if (state.source === RETRY_SOURCE) {
		if (state.retryCount >= MISSING_FACET_MAX_RETRIES) return { kind: "give-up" };
		return { kind: "repair" };
	}

	if (state.hasPendingRetry) return { kind: "noop" };
	return { kind: "defer", delayMs: MISSING_FACET_RETRY_DELAY_MS };
}
