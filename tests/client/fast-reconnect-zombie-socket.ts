// Regression (2026-10-19): the fast reconnect after wake must leave the
// provider wanting to connect, even when the old socket takes a minute to
// report closed.
//
// Field case: the Mac slept at 08:13 and woke at 08:28. The socket still said
// connected but its ticket was stale, so requestFastReconnect called
// provider.disconnect() and, 500 ms later, checked `sync.connected` before
// calling connect(). The dead socket's close event did not arrive for 60 s
// (Chromium waits out the close handshake), so `connected` was still true and
// connect() was skipped. disconnect() had already set shouldConnect=false, so
// when the close finally fired the provider's own backoff reconnect did
// nothing. Sync stayed offline for nine hours, until a manual reconnect.
//
// Rule: after disconnect(), the fast path always calls connect(). connect()
// sets shouldConnect=true and only opens a socket when none exists, so the
// late close event then reconnects through the provider's backoff path.

import { ConnectionController } from "../../src/runtime/connectionController";
import type { VaultSync } from "../../src/sync/vaultSync";
import { suite } from "../harness.ts";

const s = suite("fast-reconnect-zombie-socket");

// ---------------------------------------------------------------------------
// Fake clock standing in for window.setTimeout / clearTimeout.
// ---------------------------------------------------------------------------

interface FakeTimer {
	id: number;
	at: number;
	fn: () => void;
	cleared: boolean;
}

const timers: FakeTimer[] = [];
// Start well past 0 so the controller's "last fast reconnect" rate limit
// (which treats 0 as "never") does not swallow the first request.
let now = 1_000_000;
let nextTimerId = 1;

Object.defineProperty(globalThis, "window", {
	configurable: true,
	value: {
		setTimeout: (fn: () => void, ms: number): number => {
			const timer: FakeTimer = { id: nextTimerId++, at: now + ms, fn, cleared: false };
			timers.push(timer);
			return timer.id;
		},
		clearTimeout: (id: number): void => {
			const timer = timers.find((t) => t.id === id);
			if (timer) timer.cleared = true;
		},
		addEventListener: () => {},
		removeEventListener: () => {},
	},
});

type Listener = () => void;
const documentListeners = new Map<string, Listener[]>();
let visibilityState = "visible";
Object.defineProperty(globalThis, "document", {
	configurable: true,
	value: {
		get visibilityState() {
			return visibilityState;
		},
		addEventListener: (name: string, fn: Listener) => {
			documentListeners.set(name, [...(documentListeners.get(name) ?? []), fn]);
		},
		removeEventListener: (name: string, fn: Listener) => {
			documentListeners.set(name, (documentListeners.get(name) ?? []).filter((f) => f !== fn));
		},
	},
});

const realDateNow = Date.now;
Date.now = () => now;

function advance(ms: number): void {
	const until = now + ms;
	for (;;) {
		const due = timers
			.filter((t) => !t.cleared && t.at <= until)
			.sort((a, b) => a.at - b.at)[0];
		if (!due) break;
		now = due.at;
		due.cleared = true;
		due.fn();
	}
	now = until;
}

function foreground(): void {
	visibilityState = "visible";
	for (const fn of documentListeners.get("visibilitychange") ?? []) fn();
}

// ---------------------------------------------------------------------------
// Fake provider with y-partyserver's connect/disconnect/close semantics:
//   disconnect(): shouldConnect=false, ws.close() (close event arrives later)
//   connect():    shouldConnect=true, open a socket only when ws === null
//   close event:  clears wsconnected, then reconnects only if shouldConnect
// ---------------------------------------------------------------------------

class FakeProvider {
	shouldConnect = true;
	wsconnected = true;
	wsconnecting = false;
	ws: object | null = {};
	connectCalls = 0;
	socketsOpened = 0;
	private closing = false;

	constructor(private readonly closeDelayMs: number) {}

	on(): void {}

	disconnect(): void {
		this.shouldConnect = false;
		if (this.ws !== null && !this.closing) {
			this.closing = true;
			window.setTimeout(() => this.onClose(), this.closeDelayMs);
		}
	}

	connect(): Promise<void> {
		this.connectCalls += 1;
		this.shouldConnect = true;
		if (!this.wsconnected && this.ws === null) this.setupWS();
		return Promise.resolve();
	}

	private setupWS(): void {
		if (!this.shouldConnect || this.ws !== null) return;
		this.ws = {};
		this.socketsOpened += 1;
		this.wsconnecting = true;
		this.wsconnected = false;
		window.setTimeout(() => {
			this.wsconnecting = false;
			this.wsconnected = true;
		}, 10);
	}

	private onClose(): void {
		this.closing = false;
		this.ws = null;
		this.wsconnecting = false;
		this.wsconnected = false;
		window.setTimeout(() => this.setupWS(), 100);
	}
}

function fixture(opts: { closeDelayMs: number; ticketStale: boolean }) {
	const provider = new FakeProvider(opts.closeDelayMs);
	const logs: string[] = [];
	const sync = {
		provider,
		fatalAuthError: false,
		fatalAuthCode: null,
		get connected() {
			return provider.wsconnected;
		},
		isSocketTicketStale: () => opts.ticketStale,
		onProviderSync: () => {},
	} as unknown as VaultSync;
	const controller = new ConnectionController({
		getVaultSync: () => sync,
		isReconciled: () => true,
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		getLastReconciledGeneration: () => 0,
		setReconnectPending: () => {},
		isReconcileInFlight: () => false,
		runReconnectReconciliation: () => {},
		refreshServerCapabilities: () => {},
		flushOpenWrites: () => {},
		updateOfflineStatus: () => {},
		refreshStatusBar: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: (m) => logs.push(m),
		trace: (() => {}) as never,
		registerCleanup: () => {},
	});
	controller.start();
	return { provider, controller, logs };
}

// ---------------------------------------------------------------------------

s.section("Test 1: stale-ticket socket whose close takes 60 s is reconnected");
{
	const { provider, logs } = fixture({ closeDelayMs: 60_000, ticketStale: true });
	foreground();
	advance(1_000);
	s.check(
		logs.some((m) => m.startsWith("Fast reconnect triggered")),
		"fast reconnect fires after the debounce",
	);
	s.check(provider.wsconnected, "socket still reports connected while its close is pending");
	advance(500);
	s.check(provider.connectCalls === 1, `connect() called while the close is pending (calls=${provider.connectCalls})`);
	s.check(provider.shouldConnect, "provider wants to connect after the fast path ran");
	advance(60_000);
	s.check(provider.socketsOpened === 1, `late close opened a new socket (opened=${provider.socketsOpened})`);
	advance(100);
	s.check(provider.wsconnected, "provider is connected again");
}

s.section("Test 2: socket that closes promptly reconnects once, not twice");
{
	const { provider } = fixture({ closeDelayMs: 100, ticketStale: true });
	foreground();
	advance(1_500);
	s.check(provider.connectCalls === 1, `connect() called once (calls=${provider.connectCalls})`);
	s.check(provider.socketsOpened === 1, `one socket opened (opened=${provider.socketsOpened})`);
	advance(1_000);
	s.check(provider.socketsOpened === 1, "backoff reconnect did not open a second socket");
	s.check(provider.wsconnected, "provider is connected");
}

s.section("Test 3: healthy socket with a fresh ticket is left alone");
{
	const { provider, logs } = fixture({ closeDelayMs: 100, ticketStale: false });
	foreground();
	advance(2_000);
	s.check(provider.connectCalls === 0, "no connect()");
	s.check(!logs.some((m) => m.startsWith("Fast reconnect triggered")), "no fast reconnect");
	s.check(provider.wsconnected && provider.socketsOpened === 0, "socket untouched");
}

Date.now = realDateNow;
await s.done();
