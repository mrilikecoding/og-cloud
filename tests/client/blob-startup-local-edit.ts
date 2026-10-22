// Regression (2026-10-21, SYNC-08): a non-Markdown file edited on disk while
// Obsidian was closed must survive the next start.
//
// Field case: 21 blobs (vocabulary.json, check_notes.py, 19 .edtz sidecars)
// edited offline were reverted to the server copy four seconds after boot.
// The IndexedDB replay at startup fired the pathToBlob observer for every
// blob in the vault (11,856) with the persistence instance as origin; the
// observer only excluded ORIGIN_SEED, so it queued a download for each. The
// gate's prune dropped the 11,835 whose cached hash matched and drained the
// 21 whose disk file had changed, which were exactly the 21 the blob
// reconcile had just queued for upload. processDownload compared disk hash
// to remote hash, saw a difference, and overwrote. The upload then recorded
// a ref with the local hash and the overwritten file's size.
//
// Three rules now.
//   1. The blob observers treat only provider-origin transactions as remote
//      (isLocalOrigin), so a cache replay schedules nothing.
//   2. A download for a path with an upload pending or in flight does not
//      overwrite the local file: the remote bytes go to a conflict artifact.
//   3. The ref written after an upload carries the size of the bytes that
//      were hashed and uploaded, not the file's size at commit time.

import { App, TFile, type FileStats } from "obsidian";
import * as Y from "yjs";
import { BlobSyncManager } from "../../src/sync/blobSync";
import { VaultSync } from "../../src/sync/vaultSync";
import type { BlobRef, BlobMeta } from "../../src/types";
import { ORIGIN_RESTORE, ORIGIN_SEED } from "../../src/sync/origins";
import { suite } from "../harness.ts";

const s = suite("blob-startup-local-edit");

function bytes(text: string): ArrayBuffer {
	const encoded = new TextEncoder().encode(text);
	return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

function text(buffer: ArrayBuffer): string {
	return new TextDecoder().decode(buffer);
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", buffer);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface StoredFile {
	file: TFile;
	data: ArrayBuffer;
}

function makeFile(path: string, stat: FileStats): TFile {
	const file = new TFile();
	file.path = path;
	file.stat = stat;
	return file;
}

/** In-memory vault, the same shape as blob-download-conflicts.ts uses. */
function makeVaultFixture() {
	let clock = 1;
	const files = new Map<string, StoredFile>();

	function put(path: string, data: ArrayBuffer): StoredFile {
		const existing = files.get(path);
		const writtenAt = clock++;
		const stat: FileStats = {
			ctime: existing?.file.stat.ctime ?? writtenAt,
			mtime: writtenAt,
			size: data.byteLength,
		};
		const file = existing?.file ?? makeFile(path, stat);
		file.stat = stat;
		const stored = { file, data };
		files.set(path, stored);
		return stored;
	}

	const vault = {
		getAbstractFileByPath: (path: string) => files.get(path)?.file ?? null,
		getFiles: () => Array.from(files.values(), (f) => f.file),
		readBinary: async (file: TFile) => {
			const stored = files.get(file.path);
			if (!stored) throw new Error("missing file");
			return stored.data;
		},
		modifyBinary: async (file: TFile, data: ArrayBuffer) => {
			put(file.path, data);
		},
		createBinary: async (path: string, data: ArrayBuffer) => {
			if (files.has(path)) {
				const error = new Error("exists") as Error & { code?: string };
				error.code = "EEXIST";
				throw error;
			}
			put(path, data);
		},
		createFolder: async () => {},
		adapter: { stat: async (path: string) => files.get(path)?.file.stat ?? null },
		configDir: ".obsidian",
	};

	return { vault, files, put };
}

/** Stands in for the y-partyserver provider: remote transactions carry it as origin. */
const provider = { kind: "fake-provider" };
/** Stands in for the IndexeddbPersistence instance: its replay carries it as origin. */
const persistence = { kind: "fake-persistence" };

function makeVaultSyncFixture(): VaultSync {
	const ydoc = new Y.Doc();
	return Object.assign(Object.create(VaultSync.prototype) as VaultSync, {
		ydoc,
		provider,
		pathToBlob: ydoc.getMap<BlobRef>("pathToBlob"),
		blobMeta: ydoc.getMap<BlobMeta>("blobMeta"),
		blobTombstones: ydoc.getMap<{ deletedAt: number }>("blobTombstones"),
		debug: false,
		_eventRing: [],
	});
}

function makeHarness() {
	const { vault, files, put } = makeVaultFixture();
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	const vaultSync = makeVaultSyncFixture();
	const manager = new BlobSyncManager(
		Object.assign(Object.create(App.prototype) as App, { vault, fileManager: {} }),
		vaultSync,
		{
			host: "https://worker.example",
			token: "token",
			vaultId: "vault",
			maxAttachmentSizeKB: 1024,
			attachmentConcurrency: 1,
			debug: false,
		},
		{},
		(source, msg, details) => traces.push({ source, msg, details }),
	);
	return { vault, files, put, traces, vaultSync, manager };
}

// ---------------------------------------------------------------------------

s.section("Test 1: the IndexedDB replay at startup schedules no downloads");
{
	const { vaultSync, manager } = makeHarness();
	manager.startObservers();
	vaultSync.ydoc.transact(() => {
		vaultSync.pathToBlob.set("Vault Maintenance/vocabulary.json", { hash: "a".repeat(64), size: 1092 });
		vaultSync.pathToBlob.set("img.png", { hash: "b".repeat(64), size: 10 });
	}, persistence);
	s.check(
		manager["downloadQueue"].size === 0,
		`persistence-origin adds queue nothing (queued=${manager["downloadQueue"].size})`,
	);

	vaultSync.ydoc.transact(() => {
		vaultSync.pathToBlob.set("new-from-phone.png", { hash: "c".repeat(64), size: 10 });
	}, provider);
	s.check(
		manager["downloadQueue"].has("new-from-phone.png"),
		"a provider-origin add still queues a download",
	);

	vaultSync.ydoc.transact(() => {
		vaultSync.pathToBlob.set("own-upload.png", { hash: "d".repeat(64), size: 10 });
	}, ORIGIN_SEED);
	s.check(!manager["downloadQueue"].has("own-upload.png"), "this device's own setBlobRef queues nothing");

	vaultSync.ydoc.transact(() => {
		vaultSync.pathToBlob.set("restored.png", { hash: "e".repeat(64), size: 10 });
	}, ORIGIN_RESTORE);
	s.check(manager["downloadQueue"].has("restored.png"), "a snapshot-restore add queues a download");
}

s.section("Test 2: a download for a path with an upload pending keeps the local file");
{
	const { manager, files, put, traces } = makeHarness();
	put("Vault Maintenance/vocabulary.json", bytes("local-edited-offline"));
	manager["uploadQueue"].set("Vault Maintenance/vocabulary.json", {
		path: "Vault Maintenance/vocabulary.json",
		sizeBytes: 20,
		retries: 0,
		status: "pending",
		readyAt: 0,
		needsRerun: false,
		rerunResets: 0,
	});

	const remote = bytes("server-older-copy");
	const hash = await sha256Hex(remote);
	manager["blobClient"].download = async () => remote;
	manager["downloadQueue"].set("Vault Maintenance/vocabulary.json", {
		path: "Vault Maintenance/vocabulary.json",
		hash,
		sizeBytes: remote.byteLength,
		retries: 0,
		status: "processing",
		readyAt: 0,
		rerunResets: 0,
	});
	await manager["processDownload"](manager["downloadQueue"].get("Vault Maintenance/vocabulary.json")!);

	s.check(
		text(files.get("Vault Maintenance/vocabulary.json")!.data) === "local-edited-offline",
		"local file is not overwritten",
	);
	const conflict = Array.from(files.keys()).find((p) => p.includes("YAOS remote conflict"));
	s.check(!!conflict, "remote bytes are preserved in a conflict artifact");
	s.check(conflict ? text(files.get(conflict)!.data) === "server-older-copy" : false, "artifact holds the remote bytes");
	s.check(!manager["downloadQueue"].has("Vault Maintenance/vocabulary.json"), "download is removed from the queue");
	s.check(
		traces.some(
			(t) => t.msg === "download-conflict-quarantined" && t.details?.reason === "local-upload-pending",
		),
		"quarantine is traced with reason local-upload-pending",
	);
	s.check(
		manager["uploadQueue"].has("Vault Maintenance/vocabulary.json"),
		"the pending upload is left to run",
	);
}

s.section("Test 3: the ref written after an upload carries the uploaded size");
{
	const { manager, put, vaultSync } = makeHarness();
	const path = "Vault Maintenance/vocabulary.json";
	put(path, bytes("x".repeat(1332)));
	manager["blobClient"].exists = async () => [];
	manager["blobClient"].upload = async () => {
		// Something else rewrites the file while the upload is on the wire
		// (in the field: the download that this suite's Test 2 now prevents).
		put(path, bytes("y".repeat(1092)));
	};
	const item = {
		path,
		sizeBytes: 1332,
		retries: 0,
		status: "processing" as const,
		readyAt: 0,
		needsRerun: false,
		rerunResets: 0,
	};
	manager["uploadQueue"].set(path, item);
	await manager["processUpload"](item);

	const ref = vaultSync.pathToBlob.get(path);
	const uploadedHash = await sha256Hex(bytes("x".repeat(1332)));
	s.check(ref?.hash === uploadedHash, "ref hash is the uploaded content's hash");
	s.check(ref?.size === 1332, `ref size matches the uploaded bytes (size=${ref?.size})`);
}

await s.done();
