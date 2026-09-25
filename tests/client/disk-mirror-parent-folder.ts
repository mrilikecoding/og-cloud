// Regression (2026-09-25): a stale vault index must not make flushWrite try to
// create a folder that already exists.
//
// On boot, reconcile ran before Obsidian had populated its in-memory index, so
// getAbstractFileByPath reported long-existing folders as absent. flushWrite
// took the create branch, called vault.createFolder, and Obsidian threw
// "Folder already exists." because createFolder consults the filesystem, not
// the index. The throw happened before vault.create, so 9 writes were lost on
// that pass (Notes/Writing/* and Vault Maintenance/README.md), all recovered
// by a later reconcile.
//
// The index is a cache; the adapter is the filesystem. Ask the adapter, and
// treat a folder appearing underneath us as success rather than an error.

import * as Y from "yjs";
import type { App } from "obsidian";
import { DiskMirror } from "../../src/sync/diskMirror";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import type { VaultSync } from "../../src/sync/vaultSync";
import { partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

const s = suite("disk-mirror-parent-folder");

const PATH = "Notes/Writing/note.md";
const DIR = "Notes/Writing";

interface Options {
	/** Directories the filesystem really has. */
	onDisk?: string[];
	/** Paths Obsidian's index admits to. An empty index is the boot case. */
	indexed?: string[];
	/** Make createFolder throw, as Obsidian does for an existing folder. */
	createFolderThrows?: boolean;
	/** A folder that appears between the exists() check and createFolder. */
	appearsDuringCreate?: boolean;
}

function makeMirror(options: Options = {}) {
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "hello");

	const onDisk = new Set(options.onDisk ?? []);
	const indexed = new Set(options.indexed ?? []);
	const created: string[] = [];
	const createFolderCalls: string[] = [];

	const app = partialOf<App>({
		vault: {
			configDir: ".obsidian",
			getAbstractFileByPath: (p: string) => (indexed.has(p) ? ({ path: p } as never) : null),
			create: async (p: string, data: string) => { created.push(`${p}:${data.length}`); return {} as never; },
			createFolder: async (p: string) => {
				createFolderCalls.push(p);
				if (options.appearsDuringCreate) onDisk.add(p);
				if (options.createFolderThrows || options.appearsDuringCreate) {
					throw new Error("Folder already exists.");
				}
				onDisk.add(p);
				return {} as never;
			},
			adapter: {
				exists: async (p: string) => onDisk.has(p),
				stat: async () => null,
			},
		},
	});

	const vaultSync = partialOf<VaultSync>({
		getTextForPath: (p: string) => (p === PATH ? ytext : null),
		getFileIdForText: () => "file-1",
	});
	const editorBindings = partialOf<EditorBindingManager>({
		getLastEditorActivityForPath: () => null,
	});

	const mirror = new DiskMirror(app, vaultSync, editorBindings, false);
	// disk.write.failed is the observable for a failed write; the log line
	// itself goes to console.error.
	const failures: string[] = [];
	mirror.setFlightEventHandler((event) => {
		if (event.kind === "disk.write.failed") failures.push(String((event.data as { error?: string })?.error));
	});
	return { mirror, created, createFolderCalls, failures };
}

s.section("Test 1: a folder the index has not loaded yet is not re-created");
{
	// The boot case: filesystem has it, index does not.
	const f = makeMirror({ onDisk: [DIR], indexed: [], createFolderThrows: true });
	await f.mirror.flushWrite(PATH, true);

	s.check(f.createFolderCalls.length === 0, `createFolder not called (got ${JSON.stringify(f.createFolderCalls)})`);
	s.check(f.created.length === 1, `the file was still written (got ${JSON.stringify(f.created)})`);
}

s.section("Test 2: a genuinely absent folder is still created");
{
	const f = makeMirror({ onDisk: [], indexed: [] });
	await f.mirror.flushWrite(PATH, true);

	s.check(f.createFolderCalls.includes(DIR), "createFolder called for the missing parent");
	s.check(f.created.length === 1, "and the file was written after it");
}

s.section("Test 3: a folder appearing mid-flight is not an error");
{
	// Two writers racing into the same new folder: exists() says no for both,
	// the loser's createFolder throws, and its write must still happen.
	const f = makeMirror({ onDisk: [], indexed: [], appearsDuringCreate: true });
	await f.mirror.flushWrite(PATH, true);

	s.check(f.createFolderCalls.includes(DIR), "createFolder was attempted");
	s.check(f.created.length === 1, `the write survived the race (got ${JSON.stringify(f.created)})`);
	s.check(f.failures.length === 0, `no failure logged (got ${JSON.stringify(f.failures)})`);
}

s.section("Test 4: a real folder-creation error still surfaces");
{
	const f = makeMirror({ onDisk: [], indexed: [], createFolderThrows: true });
	await f.mirror.flushWrite(PATH, true);

	s.check(f.created.length === 0, "the file was not written");
	s.check(f.failures.length > 0, "the failure was reported rather than swallowed");
}

void s.done();
