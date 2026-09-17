/**
 * Per-binding retry scheduler for editor binding health.
 *
 * Owns the retry timer and retry count for each leaf and applies
 * decideHealthAction. The manager supplies inspect/repair callbacks so this
 * stays free of CodeMirror and Obsidian and can be driven by a fake clock.
 */

import {
	decideHealthAction,
	MISSING_FACET_RETRY_DELAY_MS,
	RETRY_SOURCE,
	type HealthAction,
} from "./bindingHealthPolicy";

export interface HealthReport {
	issues: readonly string[];
	deferredIssues: readonly string[];
}

export interface SchedulerDeps {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	/** Inspect the binding for this leaf. Return null when it no longer exists. */
	inspect(leafId: string): HealthReport | null;
	/** Attempt a repair. Return false when the binding is gone. */
	repair(leafId: string, source: string, issues: readonly string[]): boolean;
	onGiveUp(leafId: string, issues: readonly string[]): void;
	trace?(event: string, leafId: string, data: Record<string, unknown>): void;
}

interface Episode {
	timer: unknown;
	retryCount: number;
}

export class BindingHealthScheduler {
	private readonly episodes = new Map<string, Episode>();
	/** Leaves whose current binding has exhausted its retries; cleared on unbind. */
	private readonly gaveUp = new Set<string>();

	constructor(private readonly deps: SchedulerDeps) {}

	/**
	 * Run a health check for a leaf on behalf of `source`.
	 *
	 * Synchronous by design: `inspect` and `repair` run to completion inside
	 * this call, so a repair that re-enters `check` (the manager's repair path
	 * schedules a post-bind check) sees a consistent episode. If either
	 * callback ever becomes async, the stale-episode guard in `schedule`
	 * needs re-verifying.
	 */
	check(leafId: string, source: string): HealthAction["kind"] {
		const report = this.deps.inspect(leafId);
		if (!report) {
			this.clear(leafId);
			return "noop";
		}
		if (this.gaveUp.has(leafId) && isOnlyMissingFacet(report.issues)) return "noop";
		const episode = this.episodes.get(leafId);
		const action = decideHealthAction({
			source,
			issues: report.issues,
			deferredIssues: report.deferredIssues,
			hasPendingRetry: episode !== undefined && episode.timer !== null,
			retryCount: episode?.retryCount ?? 0,
		});

		switch (action.kind) {
			case "noop":
				if (report.issues.length === 0) this.clear(leafId);
				return "noop";
			case "defer":
				this.schedule(leafId, action.delayMs, episode?.retryCount ?? 0);
				this.deps.trace?.("binding-health-retry-scheduled", leafId, {
					source,
					delayMs: action.delayMs,
					retryCount: episode?.retryCount ?? 0,
				});
				return "defer";
			case "repair": {
				const attempt = (episode?.retryCount ?? 0) + (source === RETRY_SOURCE ? 1 : 0);
				const alive = this.deps.repair(leafId, source, report.issues);
				if (!alive) {
					this.clear(leafId);
					return "repair";
				}
				if (source === RETRY_SOURCE) {
					// Re-check on the same cadence; a healthy result clears the episode.
					const after = this.deps.inspect(leafId);
					if (after && after.issues.length > 0) {
						this.schedule(leafId, MISSING_FACET_RETRY_DELAY_MS, attempt);
					} else {
						this.clear(leafId);
					}
				}
				return "repair";
			}
			case "give-up":
				this.clear(leafId);
				this.gaveUp.add(leafId);
				this.deps.onGiveUp(leafId, report.issues);
				return "give-up";
		}
	}

	/** Cancel any pending retry and forget the episode and any give-up. */
	clear(leafId: string): void {
		this.gaveUp.delete(leafId);
		const episode = this.episodes.get(leafId);
		if (!episode) return;
		if (episode.timer !== null) this.deps.clearTimeout(episode.timer);
		this.episodes.delete(leafId);
	}

	clearAll(): void {
		for (const leafId of [...this.episodes.keys()]) this.clear(leafId);
		this.gaveUp.clear();
	}

	hasPending(leafId: string): boolean {
		const e = this.episodes.get(leafId);
		return e !== undefined && e.timer !== null;
	}

	private schedule(leafId: string, delayMs: number, retryCount: number): void {
		const existing = this.episodes.get(leafId);
		if (existing?.timer != null) this.deps.clearTimeout(existing.timer);
		const episode: Episode = { timer: null, retryCount };
		episode.timer = this.deps.setTimeout(() => {
			episode.timer = null;
			if (this.episodes.get(leafId) !== episode) return;
			this.check(leafId, RETRY_SOURCE);
		}, delayMs);
		this.episodes.set(leafId, episode);
	}
}

function isOnlyMissingFacet(issues: readonly string[]): boolean {
	return issues.length === 1 && issues[0] === "missing-sync-facet";
}
