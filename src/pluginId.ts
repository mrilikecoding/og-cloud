import type { App } from "obsidian";

/** This build ships as "og-cloud" (owlgourd-cloudflare), a fork of YAOS. */
export const PLUGIN_ID = "og-cloud";
/** Id of the upstream plugin whose settings we adopt on first run. */
export const LEGACY_PLUGIN_ID = "yaos";

export function pluginDir(app: App): string {
	return `${app.vault.configDir}/plugins/${PLUGIN_ID}`;
}
