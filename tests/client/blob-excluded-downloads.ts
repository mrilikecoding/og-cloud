// Excluded blob paths must be excluded in both directions, and a pattern can
// name a file extension.
//
// Before this, exclude patterns applied to uploads only: the vault event
// handlers and the blob reconcile's disk scan honoured them, while the
// pathToBlob observer, the reconcile's CRDT loop and prioritizeDownloads
// downloaded whatever the shared map named. Excluding a path therefore
// stopped this device publishing it but kept pulling other devices' copies
// over the local file. Patterns were also prefix-only, so there was no way
// to exclude a file type.
//
// Motivating case (2026-10-22): Edit History's `.edtz` sidecars. Each device
// writes its own archive beside the note, so every device's reconcile saw
// its own archive as "changed offline" and the copies fought through blob
// sync (19 of the 21 files reverted in SYNC-08 were .edtz; 15 refs flipped
// back and forth in the SYNC-09 minute). They are per-device history and
// should never have been shared.

import { App, TFile, type FileStats } from "obsidian";
import * as Y from "yjs";
import { BlobSyncManager } from "../../src/sync/blobSync";
import { VaultSync } from "../../src/sync/vaultSync";
import { isExcluded, parseExcludePatterns } from "../../src/sync/exclude";
import { isBlobSyncable } from "../../src/types";
import type { BlobRef, BlobMeta } from "../../src/types";
import { suite } from "../harness.ts";

const s = suite("blob-excluded-downloads");

function bytes(text: string): ArrayBuffer {
	const encoded = new TextEncoder().encode(text);
	return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

function makeFile(path: string, stat: FileStats): TFile {
	const file = new TFile();
	file.path = path;
	file.stat = stat;
	return file;
}

const provider = { kind: "fake-provider" };

function makeHarness(excludePatterns: string[]) {
	let clock = 1;
	const files = new Map<string, { file: TFile; data: ArrayBuffer }>();
	const put = (path: string, data: ArrayBuffer) => {
		const existing = files.get(path);
		const stat: FileStats = { ctime: 1, mtime: clock++, size: data.byteLength };
		const file = existing?.file ?? makeFile(path, stat);
		file.stat = stat;
		files.set(path, { file, data });
	};
	const vault = {
		getAbstractFileByPath: (path: string) => files.get(path)?.file ?? null,
		getFiles: () => Array.from(files.values(), (f) => f.file),
		readBinary: async (file: TFile) => files.get(file.path)!.data,
		modifyBinary: async (file: TFile, data: ArrayBuffer) => put(file.path, data),
		createBinary: async (path: string, data: ArrayBuffer) => put(path, data),
		createFolder: async () => {},
		adapter: { stat: async (path: string) => files.get(path)?.file.stat ?? null },
		configDir: ".obsidian",
	};
	const ydoc = new Y.Doc();
	const vaultSync = Object.assign(Object.create(VaultSync.prototype) as VaultSync, {
		ydoc,
		provider,
		pathToBlob: ydoc.getMap<BlobRef>("pathToBlob"),
		blobMeta: ydoc.getMap<BlobMeta>("blobMeta"),
		blobTombstones: ydoc.getMap<{ deletedAt: number }>("blobTombstones"),
		debug: false,
		_eventRing: [],
	});
	const traces: Array<{ msg: string; details?: Record<string, unknown> }> = [];
	const downloads: string[] = [];
	const manager = new BlobSyncManager(
		Object.assign(Object.create(App.prototype) as App, { vault, fileManager: {} }),
		vaultSync,
		{ host: "https://worker.example", token: "t", vaultId: "v", maxAttachmentSizeKB: 1024, attachmentConcurrency: 1, debug: false },
		{},
		(_source, msg, details) => traces.push({ msg, details }),
		[],
		undefined,
		(path) => isBlobSyncable(path, excludePatterns, ".obsidian"),
	);
	manager["blobClient"].download = async (hash: string) => {
		downloads.push(hash);
		return bytes("remote");
	};
	return { manager, vaultSync, put, files, traces, downloads, excludePatterns };
}

s.section("Test 1: a pattern of the form *.ext excludes by extension");
{
	const patterns = parseExcludePatterns("templates/, *.edtz");
	s.check(isExcluded("Notes/A.md.edtz", patterns, ".obsidian"), "*.edtz excludes a nested .edtz file");
	s.check(isExcluded("templates/x.png", patterns, ".obsidian"), "prefix patterns still work alongside");
	s.check(!isExcluded("Notes/A.md", patterns, ".obsidian"), "an unrelated file is not excluded");
	s.check(!isExcluded("Notes/edtz-notes.md", patterns, ".obsidian"), "the extension must end the path");
	s.check(!isBlobSyncable("Notes/A.md.edtz", patterns, ".obsidian"), "isBlobSyncable agrees");
}

s.section("Test 2: the observer does not queue a download for an excluded path");
{
	const h = makeHarness(["*.edtz"]);
	h.manager.startObservers();
	h.vaultSync.ydoc.transact(() => {
		h.vaultSync.pathToBlob.set("Notes/A.md.edtz", { hash: "a".repeat(64), size: 10 });
		h.vaultSync.pathToBlob.set("img.png", { hash: "b".repeat(64), size: 10 });
	}, provider);
	s.check(!h.manager["downloadQueue"].has("Notes/A.md.edtz"), "excluded path not queued");
	s.check(h.manager["downloadQueue"].has("img.png"), "included path queued");
}

s.section("Test 3: reconcile does not download an excluded CRDT path that is missing on disk");
{
	const h = makeHarness(["*.edtz"]);
	h.vaultSync.pathToBlob.set("Notes/A.md.edtz", { hash: "a".repeat(64), size: 10 });
	h.vaultSync.pathToBlob.set("img.png", { hash: "b".repeat(64), size: 10 });
	const result = h.manager.reconcile("authoritative", h.excludePatterns);
	s.check(result.downloadQueued === 1, `one download queued (got ${result.downloadQueued})`);
	s.check(!h.manager["downloadQueue"].has("Notes/A.md.edtz"), "the excluded path is not among them");
}

s.section("Test 4: prioritizeDownloads skips excluded paths");
{
	const h = makeHarness(["*.edtz"]);
	h.vaultSync.pathToBlob.set("Notes/A.md.edtz", { hash: "a".repeat(64), size: 10 });
	const queued = h.manager.prioritizeDownloads(["Notes/A.md.edtz"]);
	s.check(queued === 0, "nothing queued");
}

s.section("Test 5: a queued download for an excluded path is dropped without touching disk or the network");
{
	// A queue entry can predate the exclude (restored from the persisted
	// snapshot, or queued before the setting changed).
	const h = makeHarness(["*.edtz"]);
	h.put("Notes/A.md.edtz", bytes("local history"));
	const item = { path: "Notes/A.md.edtz", hash: "a".repeat(64), sizeBytes: 6, retries: 0, status: "processing" as const, readyAt: 0, rerunResets: 0 };
	h.manager["downloadQueue"].set(item.path, item);
	await h.manager["processDownload"](item);
	s.check(h.downloads.length === 0, "no network fetch");
	s.check(new TextDecoder().decode(h.files.get("Notes/A.md.edtz")!.data) === "local history", "local file untouched");
	s.check(!h.manager["downloadQueue"].has(item.path), "queue entry removed");
	s.check(h.traces.some((t) => t.msg === "download-overwrite-decision" && t.details?.action === "skip-excluded"), "skip is traced");
}

await s.done();
