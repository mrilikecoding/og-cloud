// scripts/resolve-path-ids.mjs reverses the `p:` pseudonyms in a redacted
// debug trace by recomputing them for every file in the vault. It only works
// while its derivation matches the plugin's, and nothing would announce a
// drift: the tool would simply resolve nothing and look like an empty trace.
//
// So these tests compare the script against PathIdentityResolver itself
// rather than against a frozen fixture. A change to the scheme in
// pathIdentity.ts fails here.

import { PathIdentityResolver, deriveVaultPathSalt } from "../../src/telemetry/debug/pathIdentity";
import { computePathId, deriveSalt } from "../../scripts/resolve-path-ids.mjs";
import { suite } from "../harness.ts";

const s = suite("resolve-path-ids");

async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const VAULT_ID = "c3jhnXAy5RXeWaaeqfXIaA";
const PATHS = [
	"Notes/Rayna/Rayna Sleep Log.md",
	"Notes/Writing/Tunnel 13/Tunnel 13 v2.md",
	"README.md",
	"Notes/Career/Songfinch/Tickets/DONE/PE-418 TikTok/Initiate Checkout.md",
	"Vault Maintenance/scripts/stamp_file_dates.py",
];

s.section("Test 1: the tool derives the same salt as the plugin");
{
	const fromPlugin = await deriveVaultPathSalt(sha256Hex, VAULT_ID);
	const fromTool = deriveSalt(VAULT_ID);
	s.check(fromTool === fromPlugin, "deriveSalt matches deriveVaultPathSalt");
}

s.section("Test 2: the tool computes the same pathId as the plugin, for every shape of path");
{
	const salt = await deriveVaultPathSalt(sha256Hex, VAULT_ID);
	const resolver = new PathIdentityResolver(sha256Hex, { salt });
	for (const path of PATHS) {
		const expected = (await resolver.getPathIdentity(path)).pathId;
		const actual = computePathId(salt, path);
		s.check(actual === expected, `${path} -> ${expected}${actual === expected ? "" : ` (tool produced ${actual})`}`);
	}
}

s.section("Test 3: pseudonyms are vault-scoped, so one vault's table cannot read another's trace");
{
	const ours = deriveSalt(VAULT_ID);
	const theirs = deriveSalt("some-other-vault");
	const path = "Notes/Rayna/Rayna Sleep Log.md";
	s.check(
		computePathId(ours, path) !== computePathId(theirs, path),
		"the same path pseudonymizes differently under a different vault id",
	);
}

void s.done();
