/** Paths that are always excluded, regardless of user settings. */
function normalizePrefix(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+/, "");
}

function alwaysExcludedPrefixes(configDir: string): string[] {
	const normalizedConfigDir = normalizePrefix(configDir).replace(/\/$/, "");
	return [
		`${normalizedConfigDir}/`,
		".trash/",
	];
}

/**
 * Check if a vault-relative path should be excluded from sync.
 * Always excludes the current config directory and .trash/, plus any
 * user-configured patterns. A pattern is a path prefix ("templates/"), or
 * an extension when written as "*.ext" ("*.edtz" excludes every file whose
 * name ends in ".edtz", at any depth).
 *
 * @param path - Vault-relative path (e.g. "templates/daily.md")
 * @param patterns - Parsed exclude patterns (e.g. ["templates/", "*.edtz"])
 * @param configDir - Obsidian config directory name
 * @returns true if the path matches any exclude pattern
 */
export function isExcluded(path: string, patterns: string[], configDir: string): boolean {
	const normalizedPath = normalizePrefix(path);
	for (const prefix of alwaysExcludedPrefixes(configDir)) {
		if (normalizedPath.startsWith(prefix)) return true;
	}
	for (const pattern of patterns) {
		if (pattern.startsWith("*.")) {
			if (normalizedPath.endsWith(pattern.slice(1))) return true;
			continue;
		}
		if (normalizedPath.startsWith(normalizePrefix(pattern))) return true;
	}
	return false;
}

/**
 * Parse the comma-separated excludePatterns setting into a list of
 * trimmed, non-empty prefixes.
 */
export function parseExcludePatterns(raw: string): string[] {
	return raw
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
}
