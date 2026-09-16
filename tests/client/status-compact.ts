/**
 * Compact status bar derivation: one dot colour and one word per situation.
 *
 * Proves: every ConnectionState kind maps to a tone and a word; receipt
 * outcomes refine the online and offline words; "Server not saving" and
 * "files need attention" override any state in that order; a transfer
 * status is appended; the full label is carried along for hover and click.
 */

import { getCompactStatus } from "../../src/status/statusBarController";
import type { ServerReceiptStatus } from "../../src/status/statusBarController";
import type { ConnectionState } from "../../src/runtime/connectionController";
import { suite } from "../harness.ts";

const s = suite("status-compact");

const online: ConnectionState = { kind: "online", generation: 1 };
const offline: ConnectionState = { kind: "offline", reason: "provider_disconnected", generation: 1 };

function receipt(partial: Partial<ServerReceiptStatus>): ServerReceiptStatus {
	return {
		serverAppliedLocalState: null,
		lastServerReceiptEchoAt: null,
		lastKnownServerReceiptEchoAt: null,
		candidatePersistenceHealthy: true,
		serverReceiptStartupValidation: null,
		receiptGuaranteeIsDurable: true,
		...partial,
	};
}

function expect(state: ConnectionState, r: ServerReceiptStatus | null, tone: string, word: string, extra: { transfer?: string | null; attention?: number } = {}) {
	const c = getCompactStatus(state, extra.transfer ?? null, r, extra.attention ?? 0);
	s.check(c.tone === tone && c.word === word, `${state.kind}/${r?.serverAppliedLocalState ?? "-"} → ${c.tone} "${c.word}" (want ${tone} "${word}")`);
	return c;
}

s.section("Test 1: connection states without a receipt");
expect({ kind: "disconnected" }, null, "grey", "Disconnected");
expect({ kind: "loading_cache" }, null, "grey", "Loading");
expect({ kind: "connecting" }, null, "grey", "Connecting");
expect(online, null, "green", "Connected");
expect(offline, null, "orange", "Offline");
expect({ kind: "auth_failed", code: "unauthorized" }, null, "red", "Auth");
expect({ kind: "auth_failed", code: "unclaimed" }, null, "red", "Server");
expect({ kind: "auth_failed", code: "server_misconfigured" }, null, "red", "Server");
expect({ kind: "server_update_required", details: null }, null, "red", "Update");

s.section("Test 2: receipt refines the online word");
expect(online, receipt({ serverAppliedLocalState: true }), "green", "Saved");
expect(online, receipt({ serverAppliedLocalState: true, receiptGuaranteeIsDurable: false }), "green", "Saved");
expect(online, receipt({ serverAppliedLocalState: false }), "orange", "Pending");
expect(online, receipt({ serverReceiptStartupValidation: "skipped_local_yjs_timeout" }), "orange", "Checking");
expect(online, receipt({ lastKnownServerReceiptEchoAt: 1 }), "orange", "Checking");
expect(online, receipt({}), "orange", "Checking");

s.section("Test 3: receipt refines the offline word");
expect(offline, receipt({ serverAppliedLocalState: true, lastServerReceiptEchoAt: 1 }), "orange", "Offline");
expect(offline, receipt({ serverAppliedLocalState: false }), "orange", "Unsent");

s.section("Test 4: overrides rank above the state");
expect(online, receipt({ serverAppliedLocalState: true, serverPersistenceDegraded: true }), "red", "Not saving");
expect(online, receipt({ serverAppliedLocalState: true }), "red", "Attention", { attention: 2 });
expect(online, receipt({ serverAppliedLocalState: true, serverPersistenceDegraded: true }), "red", "Not saving", { attention: 2 });
expect({ kind: "disconnected" }, null, "red", "Attention", { attention: 1 });

s.section("Test 5: transfer status is appended, full label carried");
{
	const c = expect(online, receipt({ serverAppliedLocalState: true }), "green", "Saved", { transfer: "↑ 3 files" });
	s.check(c.text === "OG-cloud Saved (↑ 3 files)", `text with transfer: ${c.text}`);
	s.check(c.full.startsWith("OG-cloud: Connected") && c.full.includes("Receipt: server saved"), `full label kept: ${c.full}`);
	const plain = getCompactStatus(online, null, receipt({ serverAppliedLocalState: true }), 0);
	s.check(plain.text === "OG-cloud Saved", `text without transfer: ${plain.text}`);
}

await s.done();
