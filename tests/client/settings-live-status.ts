// Settings tab (2026-09-21): the "Status" row is live, and the plugin
// version names the build.
//
// getSettingDefinitions() runs once per display(). Toggling the plugin off
// and on from the settings window re-shows the tab before onload has built
// VaultSync, so the row rendered "Disconnected" and stayed that way for as
// long as the window was open, while the status bar (which is pushed on
// every state change) said Connected. The row is now a render item that
// subscribes to the host's status changes and unsubscribes on teardown.
//
// build.sh keeps upstream's 2.1.1 in manifest.json, so every fork build
// showed the same version. The label now appends the commit and build time
// that esbuild stamps into the bundle.

import {
	App,
	Plugin,
	type Setting,
	type SettingDefinition,
	type SettingDefinitionItem,
	type SettingGroup,
} from "obsidian";
import { DEFAULT_SETTINGS, type VaultSyncSettings } from "../../src/settings/settingsStore";
import {
	VaultSyncSettingTab,
	type VaultSyncSettingsHost,
} from "../../src/settings/settingsTab";
import { formatPluginVersion } from "../../src/buildInfo";
import { suite } from "../harness.ts";

const s = suite("settings-live-status");

function collectDefinitions(items: SettingDefinitionItem[]): SettingDefinition[] {
	const out: SettingDefinition[] = [];
	for (const item of items) {
		if ("type" in item) {
			if (item.items) out.push(...collectDefinitions(item.items));
			continue;
		}
		out.push(item);
	}
	return out;
}

function createFixture() {
	const settings: VaultSyncSettings = { ...DEFAULT_SETTINGS, host: "https://example.test", token: "t", vaultId: "v" };
	let label = "Disconnected";
	const listeners = new Set<() => void>();
	const host: VaultSyncSettingsHost = {
		settings,
		serverAuthMode: "claim",
		serverSupportsAttachments: true,
		serverMaxBlobUploadBytes: 5 * 1024 * 1024,
		updateSettings: async (mutator) => { mutator(settings); },
		refreshServerCapabilities: async () => {},
		refreshUpdateManifest: async () => {},
		refreshAttachmentSyncRuntime: async () => {},
		getSettingsStatusSummary: () => ({ state: label === "Connected" ? "connected" : "disconnected", label }),
		onSyncStatusChanged: (listener) => {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		getUpdateState: () => ({
			serverVersion: "0.3.0",
			latestServerVersion: "0.3.0",
			serverUpdateAvailable: false,
			pluginVersion: "2.1.1",
			latestPluginVersion: null,
			pluginUpdateRecommended: false,
			updateRepoUrl: null,
			updateActionUrl: null,
			updateBootstrapUrl: null,
			legacyServerDetected: false,
			pluginCompatibilityWarning: null,
		}),
		buildSetupDeepLink: () => null,
		buildMobileSetupUrl: () => null,
		buildRecoveryKitText: () => null,
	};
	const plugin = Object.create(Plugin.prototype) as Plugin;
	const tab = new VaultSyncSettingTab(new App(), plugin, host);
	return {
		tab,
		setLabel: (next: string) => { label = next; },
		fireStatusChange: () => { for (const l of listeners) l(); },
		listenerCount: () => listeners.size,
	};
}

/** The Setting the render item receives; only setDesc matters here. */
function fakeSetting() {
	const descs: string[] = [];
	const setting = {
		setDesc: (d: string) => { descs.push(d); return setting; },
		setName: () => setting,
	};
	return { setting: setting as unknown as Setting, descs };
}

s.section("Test 1: the Status row is a render item whose text follows the host");
{
	const f = createFixture();
	const status = collectDefinitions(f.tab.getSettingDefinitions()).find((d) => d.name === "Status");
	s.check(status !== undefined, "a Status definition exists");
	s.check(typeof status?.render === "function", "Status is a render item, not a static description");

	const { setting, descs } = fakeSetting();
	const cleanup = status?.render?.(setting, {} as SettingGroup);
	s.check(descs[descs.length - 1] === "Disconnected", "initial render shows the host's current label");

	f.setLabel("Connected");
	f.fireStatusChange();
	s.check(descs[descs.length - 1] === "Connected", "a status change updates the row in place");

	s.check(typeof cleanup === "function", "render returns a cleanup");
	if (typeof cleanup === "function") cleanup();
	s.check(f.listenerCount() === 0, "cleanup unsubscribes from the host");
	f.setLabel("Offline");
	f.fireStatusChange();
	s.check(descs[descs.length - 1] === "Connected", "no update after cleanup");
}

s.section("Test 2: the plugin version label names the build");
{
	s.check(
		formatPluginVersion("2.1.1", { commit: "a9db183", branch: "main", builtAt: "2026-09-21T21:21:37Z" })
			=== "2.1.1 (build a9db183, main, 2026-09-21 21:21 UTC)",
		"manifest version plus commit, branch and build time",
	);
	s.check(
		formatPluginVersion("2.1.1", { commit: "a9db183", branch: "fix/no-editor-seed", builtAt: "2026-09-21T21:21:37Z" })
			=== "2.1.1 (build a9db183, fix/no-editor-seed, 2026-09-21 21:21 UTC)",
		"a branch build shows its branch",
	);
	s.check(formatPluginVersion("2.1.1", null) === "2.1.1", "no build info: plain manifest version");
	s.check(
		formatPluginVersion("2.1.1", { commit: "a9db183", branch: "main", builtAt: "not a date" })
			=== "2.1.1 (build a9db183, main)",
		"an unparsable build time is left out rather than shown as garbage",
	);
}

void s.done();
