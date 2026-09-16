/**
 * Recovery from an `unauthorized` control frame on the sync socket.
 *
 * `unauthorized` is usually the client's own doing: y-partyserver's internal
 * reconnect loop reuses provider.url, and after laptop sleep or app suspend
 * that URL carries a socket ticket that expired hours ago. The long-lived
 * token is still valid, so the right response is to mint a fresh ticket and
 * reconnect, and only treat the rejection as fatal when the fresh ticket is
 * itself refused or a second rejection follows a successful recovery within
 * a short window.
 *
 * Extracted from VaultSync so the policy can be tested without a provider,
 * a vault, or Obsidian. All side effects go through `deps`.
 */

import { SocketTicketHttpError, type CachedSocketTicket } from "./socketTicket";
import { formatUnknown } from "../utils/format";

/**
 * After a recovery starts, another `unauthorized` inside this window means
 * the token itself is bad (or the server changed), so the caller latches.
 */
export const UNAUTHORIZED_RETRY_WINDOW_MS = 60_000;

export interface UnauthorizedRecoveryDeps {
	/** null when the server has no ticket endpoint (legacy token auth); recovery is then impossible. */
	getTicket: ((force: boolean) => Promise<CachedSocketTicket | null>) | null;
	/** Stop the provider's own reconnect loop so it cannot retry the stale URL meanwhile. */
	disconnect(): void;
	/** Patch the ticket into provider.url and (re)arm the proactive refresh. */
	applyTicket(ticket: CachedSocketTicket): void;
	connect(): Promise<void>;
	log(message: string): void;
	now?: () => number;
}

export class UnauthorizedRecovery {
	private inFlight = false;
	private lastStartedAt = 0;

	constructor(private readonly deps: UnauthorizedRecoveryDeps) {}

	/**
	 * Decide what to do with a fatal-auth frame. Returns true when recovery
	 * has taken over; false means the caller must latch the fatal state.
	 * `latch` is invoked by the recovery itself when it concludes the token
	 * is genuinely refused.
	 */
	handle(code: string, latch: () => void): boolean {
		const now = this.deps.now?.() ?? Date.now();
		const canRetry =
			code === "unauthorized" &&
			this.deps.getTicket !== null &&
			!this.inFlight &&
			now - this.lastStartedAt > UNAUTHORIZED_RETRY_WINDOW_MS;
		if (!canRetry) {
			return false;
		}
		this.inFlight = true;
		this.lastStartedAt = now;
		this.deps.log("Auth rejected (unauthorized) — assuming stale socket ticket; fetching a fresh one and retrying once");
		this.deps.disconnect();
		void this.run(latch);
		return true;
	}

	/** Forget the retry window, e.g. when the user asks for an explicit reconnect. */
	reset(): void {
		this.lastStartedAt = 0;
	}

	private async run(latch: () => void): Promise<void> {
		try {
			const ticket = await this.deps.getTicket!(true);
			if (!ticket) {
				// Server has no ticket endpoint, so the legacy token itself was rejected.
				latch();
				return;
			}
			this.deps.applyTicket(ticket);
			await this.deps.connect();
		} catch (err) {
			if (err instanceof SocketTicketHttpError && (err.status === 401 || err.status === 403)) {
				// Fresh ticket refused: the token really is bad.
				latch();
			} else {
				this.deps.log(`Ticket refresh after unauthorized failed (${formatUnknown(err)}); leaving reconnect to the normal path`);
			}
		} finally {
			this.inFlight = false;
		}
	}
}
