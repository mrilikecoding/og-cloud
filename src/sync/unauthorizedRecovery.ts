/**
 * Recovery from an `unauthorized` control frame on the sync socket.
 *
 * `unauthorized` is usually the client's own doing: y-partyserver's internal
 * reconnect loop reuses provider.url, and after laptop sleep or app suspend
 * that URL carries a socket ticket that expired hours ago. The long-lived
 * token is still valid, so the right response is to mint a fresh ticket and
 * reconnect, and only treat the rejection as fatal when the fresh ticket is
 * itself refused or a second rejection follows a completed recovery within
 * a short window.
 *
 * The recovery disconnects the provider first, which stops its reconnect
 * loop. From then on this class owns reconnection until it succeeds: a
 * ticket fetch that fails for a transient reason (the network is often not
 * back yet right after wake) is retried with backoff rather than abandoned,
 * because nothing else would call connect() again until the next browser
 * online or visibility event.
 *
 * Extracted from VaultSync so the policy can be tested without a provider,
 * a vault, or Obsidian. All side effects go through `deps`.
 */

import { SocketTicketHttpError, type CachedSocketTicket } from "./socketTicket";
import { formatUnknown } from "../utils/format";

/**
 * After a recovery starts, another `unauthorized` inside this window (once
 * the recovery has finished) means the token itself is bad, so the caller
 * latches.
 */
export const UNAUTHORIZED_RETRY_WINDOW_MS = 60_000;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

export interface UnauthorizedRecoveryDeps {
	/** null when the server has no ticket endpoint (legacy token auth); recovery is then impossible. */
	getTicket: ((force: boolean) => Promise<CachedSocketTicket | null>) | null;
	/** Stop the provider's own reconnect loop so it cannot retry the stale URL meanwhile. */
	disconnect(): void;
	/** Patch the ticket into provider.url and (re)arm the proactive refresh. */
	applyTicket(ticket: CachedSocketTicket): void;
	connect(): Promise<void>;
	/** Lets a pending retry stand down when another path already reconnected. */
	isConnected?: () => boolean;
	log(message: string): void;
	now?: () => number;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
}

export class UnauthorizedRecovery {
	private inFlight = false;
	private lastStartedAt = 0;
	private attempts = 0;
	private retryTimer: unknown = null;
	private disposed = false;

	constructor(private readonly deps: UnauthorizedRecoveryDeps) {}

	/**
	 * Decide what to do with a fatal-auth frame. Returns true when recovery
	 * has taken over (or is already under way); false means the caller must
	 * latch the fatal state. `latch` is invoked by the recovery itself when
	 * it concludes the token is genuinely refused.
	 */
	handle(code: string, latch: () => void): boolean {
		if (code !== "unauthorized" || this.deps.getTicket === null || this.disposed) {
			return false;
		}
		if (this.inFlight) {
			// A stale-URL connect from another path (fast reconnect) can draw a
			// second frame while we are between retries. We already own this.
			this.deps.log("Auth rejected (unauthorized) while a fresh-ticket recovery is in progress; ignoring");
			return true;
		}
		const now = this.now();
		if (now - this.lastStartedAt <= UNAUTHORIZED_RETRY_WINDOW_MS) {
			return false;
		}
		this.inFlight = true;
		this.lastStartedAt = now;
		this.attempts = 0;
		this.deps.log("Auth rejected (unauthorized) — assuming stale socket ticket; fetching a fresh one and reconnecting");
		this.deps.disconnect();
		void this.attempt(latch);
		return true;
	}

	/** Forget the retry window, e.g. when the user asks for an explicit reconnect. */
	reset(): void {
		this.lastStartedAt = 0;
	}

	dispose(): void {
		this.disposed = true;
		this.clearRetry();
		this.inFlight = false;
	}

	private async attempt(latch: () => void): Promise<void> {
		if (this.disposed) return;
		if (this.attempts > 0 && this.deps.isConnected?.()) {
			this.deps.log("Fresh-ticket retry stood down: already reconnected");
			this.finish();
			return;
		}
		this.attempts++;
		try {
			const ticket = await this.deps.getTicket!(true);
			if (this.disposed) return;
			if (!ticket) {
				// Server has no ticket endpoint, so the legacy token itself was rejected.
				latch();
				this.finish();
				return;
			}
			this.deps.applyTicket(ticket);
			await this.deps.connect();
			this.finish();
		} catch (err) {
			if (this.disposed) return;
			if (err instanceof SocketTicketHttpError && (err.status === 401 || err.status === 403)) {
				// Fresh ticket refused: the token really is bad.
				latch();
				this.finish();
				return;
			}
			const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.attempts - 1));
			this.deps.log(`Ticket refresh after unauthorized failed (${formatUnknown(err)}); retrying in ${Math.round(delay / 1000)} s`);
			this.clearRetry();
			this.retryTimer = this.deps.setTimer(() => {
				this.retryTimer = null;
				void this.attempt(latch);
			}, delay);
		}
	}

	private finish(): void {
		this.clearRetry();
		this.inFlight = false;
	}

	private clearRetry(): void {
		if (this.retryTimer !== null) {
			this.deps.clearTimer(this.retryTimer);
			this.retryTimer = null;
		}
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}
}
