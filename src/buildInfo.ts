/**
 * Build provenance stamped into the bundle by esbuild.config.mjs.
 *
 * manifest.json keeps upstream's version so every fork build reads the same
 * there; the commit and build time are what tell one build from another.
 * Absent (null) in test and QA runs, where esbuild has not run.
 */

declare const __OG_CLOUD_BUILD__: string | undefined;

export interface BuildInfo {
	commit: string;
	branch: string;
	/** ISO-8601 timestamp. */
	builtAt: string;
}

export function getBuildInfo(): BuildInfo | null {
	if (typeof __OG_CLOUD_BUILD__ !== "string") return null;
	try {
		const parsed: unknown = JSON.parse(__OG_CLOUD_BUILD__);
		if (
			typeof parsed !== "object" || parsed === null
			|| typeof (parsed as BuildInfo).commit !== "string"
			|| typeof (parsed as BuildInfo).branch !== "string"
			|| typeof (parsed as BuildInfo).builtAt !== "string"
		) {
			return null;
		}
		return parsed as BuildInfo;
	} catch {
		return null;
	}
}

/** "2.1.1 (build a9db183, main, 2026-09-21 21:21 UTC)"; just the version without build info. */
export function formatPluginVersion(manifestVersion: string, build: BuildInfo | null): string {
	if (!build) return manifestVersion;
	const parts = [`build ${build.commit}`, build.branch];
	const when = new Date(build.builtAt);
	if (!Number.isNaN(when.getTime())) {
		parts.push(`${when.toISOString().slice(0, 16).replace("T", " ")} UTC`);
	}
	return `${manifestVersion} (${parts.join(", ")})`;
}
