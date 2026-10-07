// Regression (2026-10-06): the mirror must recognise the vault event for its
// own write however late it arrives, and for every write it made.
//
// Suppression was a single entry per path that expired 500 ms after the
// write. Obsidian's modify event for a write arrives about 360 ms later on
// the Mac (p50 over four days; p90 450 ms), so a slow one crossed the window
// and was imported as an external edit. On a closed note that is harmless
// while the CRDT is still; while the phone is typing it diffs a stale copy of
// the note into the CRDT and deletes the phone's newest keystrokes. The Mac
// did this four times in four seconds to Rayna Sleep Log.md on 10-06 while
// the phone wrote it: 485 -> 483, 484 -> 485, 485 -> 484, ... and the phone's
// own recovery put the text back each time. That is the text that
// "disappears and reappears" on mobile.
//
// A second write to the same path also replaced the entry, so the first
// write's echo met the second write's fingerprint and failed the same way.
//
// Identity is the content fingerprint; time is only garbage collection. The
// mirror now keeps every recent write per path and acknowledges whichever one
// the event matches.

import * as Y from "yjs";
import { TFile, type App } from "obsidian";
import { DiskMirror } from "../../src/sync/diskMirror";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import type { VaultSync } from "../../src/sync/vaultSync";
import { partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

const s = suite("disk-mirror-write-echo");

const PATH = "Notes/Rayna/Rayna Sleep Log.md";

const realNow = Date.now;
let now = 1_000_000;
Date.now = () => now;
const advance = (ms: number): void => { now += ms; };

function makeMirror() {
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	const file = new TFile();
	file.path = PATH;
	let disk = "";
	const setDisk = (content: string): void => {
		disk = content;
		file.stat = { ctime: 1, mtime: now, size: new TextEncoder().encode(content).length };
	};
	setDisk("");

	const app = partialOf<App>({
		vault: {
			configDir: ".obsidian",
			getAbstractFileByPath: (p: string) => (p === PATH ? file : null),
			read: async () => disk,
			modify: async (_f: TFile, data: string) => { setDisk(data); },
			adapter: { exists: async () => true, stat: async () => null },
		},
	});
	const vaultSync = partialOf<VaultSync>({
		getTextForPath: (p: string) => (p === PATH ? ytext : null),
		getFileIdForText: () => "file-1",
	});
	const editorBindings = partialOf<EditorBindingManager>({
		getLastEditorActivityForPath: () => null,
	});
	const mirror = new DiskMirror(app, vaultSync, editorBindings, false, undefined, () => false);

	/** A remote edit landed in the CRDT and the mirror wrote it to disk. */
	const writeFromCrdt = async (content: string): Promise<void> => {
		ytext.delete(0, ytext.length);
		ytext.insert(0, content);
		await mirror.flushWrite(PATH, true);
	};
	/** Obsidian's modify event for whatever is on disk right now. */
	const echo = (): Promise<boolean> => mirror.shouldSuppressModify(file);

	return { mirror, file, writeFromCrdt, echo, setDisk, disk: () => disk };
}

s.section("Test 1: an echo that arrives after 500 ms is still our own write");
{
	const f = makeMirror();
	await f.writeFromCrdt("Legless.");
	advance(1_020);
	s.check(await f.echo(), "late modify event acknowledged as the mirror's write");
}

s.section("Test 2: two writes in a row, both echoes acknowledged in order");
{
	const f = makeMirror();
	await f.writeFromCrdt("Legless. S");
	const firstOnDisk = f.disk();
	await f.writeFromCrdt("Legless. Sn");
	const secondOnDisk = f.disk();

	// The filesystem reports the first write's state first.
	f.setDisk(firstOnDisk);
	s.check(await f.echo(), "first write's echo acknowledged although a newer write exists");
	f.setDisk(secondOnDisk);
	s.check(await f.echo(), "second write's echo acknowledged too");
	s.check(!(await f.echo()), "a third event with the same content is not ours");
}

s.section("Test 3: a genuine external edit is not suppressed");
{
	const f = makeMirror();
	await f.writeFromCrdt("Legless.");
	f.setDisk("Legless. Written by someone else.");
	s.check(!(await f.echo()), "different content is an external edit");
	f.setDisk("Legless!");
	s.check(!(await f.echo()), "same size, different content is an external edit");
}

s.section("Test 4: an external edit does not forget a pending echo");
{
	const f = makeMirror();
	await f.writeFromCrdt("Legless.");
	const ours = f.disk();
	f.setDisk("Legless. Written by someone else.");
	s.check(!(await f.echo()), "external edit seen");
	f.setDisk(ours);
	s.check(await f.echo(), "our write's echo is still recognised afterwards");
}

s.section("Test 5: entries do expire eventually");
{
	const f = makeMirror();
	await f.writeFromCrdt("Legless.");
	advance(60_000);
	s.check(!(await f.echo()), "a minute-old write is no longer a suppression candidate");
	s.check(!f.mirror.isSuppressed(PATH), "nothing left pending for the path");
}

Date.now = realNow;
await s.done();
