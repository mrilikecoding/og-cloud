#!/usr/bin/env node
/**
 * Resolve the `p:` pseudonyms in a redacted debug trace back to vault paths.
 *
 * "Export debug trace" replaces every path with a keyed hash and ships no
 * lookup table, which is what makes an exported trace safe to hand to someone
 * else. The salt is derived from the vault id, so anyone holding the vault
 * itself can rebuild the table by hashing the files they already have. That
 * is this script: the redacted export stays shareable, and stays readable at
 * home without a second, unredacted export ever existing.
 *
 * The derivation mirrors src/telemetry/debug/pathIdentity.ts and is pinned
 * against it by tests/client/resolve-path-ids.ts, because a drift here would
 * not announce itself: the tool would just resolve nothing.
 *
 *   salt   = sha256("yaos.path-pseudonym.v1" + NUL + vaultId)
 *   pathId = "p:" + sha256(salt + NUL + normalizedPath).slice(0, 32)
 *
 * Usage:
 *   node scripts/resolve-path-ids.mjs <trace.ndjson> [--vault <dir>] [--rewrite]
 *
 *   --vault    vault root. Defaults to two levels up from the trace, which is
 *              correct for a trace sitting in <vault>/og-cloud-logs/.
 *   --rewrite  write the trace to stdout with pseudonyms replaced, instead of
 *              printing the mapping.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SALT_DOMAIN = "yaos.path-pseudonym.v1";
const NUL = "\u0000";
const PATH_PREFIX = "p:";
/** Directories that never hold vault notes and can be large. */
const SKIP_DIRS = new Set([".git", ".trash", "node_modules"]);

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

/** The vault-scoped pseudonymization salt. Mirrors deriveVaultPathSalt(). */
export function deriveSalt(vaultId) {
	return sha256(`${SALT_DOMAIN}${NUL}${vaultId.trim()}`);
}

/** The pseudonym for one vault-relative path. Mirrors computePathId(). */
export function computePathId(salt, normalizedPath) {
	if (!normalizedPath) return `${PATH_PREFIX}empty`;
	return `${PATH_PREFIX}${sha256(`${salt}${NUL}${normalizedPath}`).slice(0, 32)}`;
}

/** Every file in the vault, keyed by pseudonym. */
export function buildPathTable(vaultDir, salt) {
	const table = new Map();
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				walk(join(dir, entry.name));
			} else if (entry.isFile()) {
				const rel = relative(vaultDir, join(dir, entry.name));
				table.set(computePathId(salt, rel), rel);
			}
		}
	};
	walk(vaultDir);
	return table;
}

function readArg(argv, name) {
	const index = argv.indexOf(name);
	if (index === -1) return null;
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
	return value;
}

function main() {
	const argv = process.argv.slice(2);
	const tracePath = argv.find((a) => !a.startsWith("--") && a !== readArg(argv, "--vault"));
	if (!tracePath) {
		console.error("usage: resolve-path-ids.mjs <trace.ndjson> [--vault <dir>] [--rewrite]");
		process.exit(2);
	}

	const traceFile = resolve(tracePath);
	// A trace exported by the plugin lives in <vault>/og-cloud-logs/<file>.
	const vaultDir = resolve(readArg(argv, "--vault") ?? resolve(traceFile, "../.."));
	const settingsPath = join(vaultDir, ".obsidian/plugins/og-cloud/data.json");

	let vaultId;
	try {
		vaultId = JSON.parse(readFileSync(settingsPath, "utf8")).vaultId;
	} catch {
		console.error(`Could not read the vault id from ${settingsPath}.`);
		console.error("Pass --vault <dir> pointing at the vault this trace came from.");
		process.exit(1);
	}
	if (!statSync(vaultDir).isDirectory()) {
		console.error(`Not a directory: ${vaultDir}`);
		process.exit(1);
	}

	const salt = deriveSalt(vaultId);
	const table = buildPathTable(vaultDir, salt);
	let text = readFileSync(traceFile, "utf8");
	const found = [...new Set(text.match(/p:[0-9a-f]{32}/g) ?? [])].sort();

	if (argv.includes("--rewrite")) {
		for (const pathId of found) {
			const real = table.get(pathId);
			if (real) text = text.split(pathId).join(real);
		}
		process.stdout.write(text);
		return;
	}

	const resolved = found.filter((pathId) => table.has(pathId));
	console.log(`vault:       ${vaultDir}`);
	console.log(`files:       ${table.size}`);
	console.log(`pseudonyms:  ${found.length}`);
	console.log(`resolved:    ${resolved.length}/${found.length}\n`);
	for (const pathId of found) {
		console.log(`  ${pathId}  ->  ${table.get(pathId) ?? "(not a current vault file)"}`);
	}
}

// Only run as a CLI; the tests import the derivation directly.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	main();
}
