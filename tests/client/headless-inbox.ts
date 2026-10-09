/**
 * Tests for the headless inbox peer (headless/lib).
 *
 * Proves: frontmatter parsing, request/result path mapping, that result-note
 * frontmatter round-trips through a YAML parser (the plugin quarantines a note
 * whose YAML does not parse), that createFile writes the vault model the way
 * VaultSync.ensureFile does, and that the request loop runs a request once and
 * turns a failure into an error note instead of a retry.
 */

import yaml from "js-yaml";
import * as Y from "yjs";
import { createInbox } from "../../headless/lib/inbox.mjs";
import { parseNote as parseNoteJs } from "../../headless/lib/frontmatter.mjs";
import { requestName, resultPath } from "../../headless/lib/paths.mjs";
import { composeGardenRequest, gardenIfDue } from "../../headless/lib/gardener.mjs";
import { shutdown } from "../../headless/lib/shutdown.mjs";
import { resultNote } from "../../headless/lib/resultNote.mjs";
import { createFile, liveFiles, textOf } from "../../headless/lib/vault.mjs";
import { suite } from "../harness.ts";

const s = suite("headless-inbox");

interface ParsedNote {
	frontmatter: Record<string, unknown>;
	body: string;
	error?: string;
}
const parseNote = (text: string): ParsedNote => parseNoteJs(text) as ParsedNote;

const cfg = { device: "mini", inboxDir: "inbox/", resultsDir: "results/" };

function request(ydoc: Y.Doc, name: string, ensemble: string | null, body = "do the thing"): string {
	const fm = ensemble === null ? "" : `---\nagent: ${ensemble}\n---\n`;
	return createFile(ydoc, `inbox/${name}.md`, fm + body, "laptop");
}

function resultText(ydoc: Y.Doc, name: string): string | null {
	const id = liveFiles(ydoc).get(`results/${name}.md`);
	return id === undefined ? null : textOf(ydoc, id);
}

s.section("Test 1: frontmatter parsing");
{
	const ok = parseNote("---\nagent: vault-gardener\n---\nbody here");
	s.check(ok.frontmatter.agent === "vault-gardener", "valid frontmatter: agent parsed");
	s.check(ok.body === "body here", "valid frontmatter: body excludes the block");
	s.check(ok.error === undefined, "valid frontmatter: no error");

	const none = parseNote("just a body");
	s.check(Object.keys(none.frontmatter).length === 0, "missing frontmatter: empty object");
	s.check(none.body === "just a body", "missing frontmatter: body is the whole text");

	const bad = parseNote("---\nagent: [unclosed\n---\nbody");
	s.check(typeof bad.error === "string" && bad.error.startsWith("frontmatter:"), "invalid YAML: error reported");
}

s.section("Test 2: path mapping");
{
	s.check(requestName("inbox/foo.md", "inbox/") === "foo", "request name drops dir and extension");
	s.check(requestName("inbox/sub/foo.md", "inbox/") === "sub/foo", "nested request keeps its subpath");
	s.check(resultPath("foo", "results/") === "results/foo.md", "result path is dir + name + .md");
}

s.section("Test 3: result note frontmatter round-trips through YAML");
{
	const startedAt = new Date("2026-10-09T10:00:00Z");
	const finishedAt = new Date("2026-10-09T10:00:08Z");
	const note = resultNote({
		name: "foo",
		requestPath: "inbox/foo.md",
		ensemble: "vault-gardener",
		envelope: { status: "completed", deliverable: "all done", results: { a: { status: "ok" } } },
		error: null,
		startedAt,
		finishedAt,
		runner: "mini",
	});
	const parsed = parseNote(note);
	s.check(parsed.error === undefined, "result note frontmatter parses");
	s.check(
		JSON.stringify(parsed.frontmatter.tags) === JSON.stringify(["agent", "ai-tools"]),
		"tags survive as a list",
	);
	s.check(parsed.frontmatter.request === "[[inbox/foo]]", "request is a wikilink string");
	s.check(parsed.frontmatter.status === "completed", "status comes from the envelope");
	s.check(parsed.frontmatter.duration_s === 8, "duration in seconds");
	s.check(parsed.frontmatter.runner === "mini", "runner is the device name");

	const block = /^---\n([\s\S]*?)\n---\n/.exec(note);
	s.check(block !== null && typeof yaml.load(block[1] ?? "") === "object", "raw block loads with yaml.load");

	const tricky = resultNote({
		name: "t",
		requestPath: "inbox/t.md",
		ensemble: "weird: name # with [brackets]",
		envelope: null,
		error: "boom: it broke",
		startedAt,
		finishedAt,
		runner: "mini",
	});
	const trickyParsed = parseNote(tricky);
	s.check(trickyParsed.error === undefined, "awkward characters still produce valid YAML");
	s.check(trickyParsed.frontmatter.ensemble === "weird: name # with [brackets]", "awkward ensemble value round-trips");
	s.check(trickyParsed.frontmatter.status === "error", "error note has status: error");
}

s.section("Test 4: createFile writes the vault model in one transaction");
{
	const ydoc = new Y.Doc();
	let transactions = 0;
	ydoc.on("afterTransaction", () => {
		transactions++;
	});
	const before = Date.now();
	const id = createFile(ydoc, "results/a.md", "hello", "mini");
	s.check(transactions === 1, "one transaction");
	s.check(id.length === 16, "16-char file id");
	s.check(textOf(ydoc, id) === "hello", "text stored in idToText");
	const entry = ydoc.getMap("meta").get(id);
	s.check(entry instanceof Y.Map, "meta entry is a nested Y.Map");
	s.check(entry instanceof Y.Map && entry.get("path") === "results/a.md", "meta path set");
	s.check(entry instanceof Y.Map && entry.get("device") === "mini", "meta device set");
	s.check(entry instanceof Y.Map && (entry.get("mtime") as number) >= before, "meta mtime set");
	s.check(liveFiles(ydoc).get("results/a.md") === id, "file is live");
}

s.section("Test 5: createFile refuses live and tombstoned paths");
{
	const ydoc = new Y.Doc();
	createFile(ydoc, "results/a.md", "x", "mini");
	let liveRefused = false;
	try {
		createFile(ydoc, "results/a.md", "y", "mini");
	} catch {
		liveRefused = true;
	}
	s.check(liveRefused, "live path refused");

	const tomb = new Y.Map<unknown>();
	tomb.set("path", "results/gone.md");
	tomb.set("deletedAt", Date.now());
	ydoc.getMap("meta").set("tombid", tomb);
	s.check(!liveFiles(ydoc).has("results/gone.md"), "tombstone is not live");
	let tombRefused = false;
	try {
		createFile(ydoc, "results/gone.md", "z", "mini");
	} catch {
		tombRefused = true;
	}
	s.check(tombRefused, "tombstoned path refused");
	s.check(ydoc.getMap("idToText").size === 1, "refusals wrote nothing");
}

s.test("scan skips a request whose result exists", async () => {
	const ydoc = new Y.Doc();
	request(ydoc, "done", "vault-gardener");
	createFile(ydoc, "results/done.md", "earlier result", "mini");
	let calls = 0;
	const inbox = createInbox({
		ydoc,
		cfg,
		run: () => {
			calls++;
			return Promise.resolve({ status: "completed", deliverable: "x" });
		},
	});
	await inbox.scan();
	s.check(calls === 0, "run not called when the result exists");
});

s.test("scan ignores notes without agent frontmatter", async () => {
	const ydoc = new Y.Doc();
	request(ydoc, "plain", null);
	let calls = 0;
	const inbox = createInbox({
		ydoc,
		cfg,
		run: () => {
			calls++;
			return Promise.resolve({});
		},
	});
	await inbox.scan();
	s.check(calls === 0, "run not called");
	s.check(resultText(ydoc, "plain") === null, "no result note written");
});

s.test("scan runs a request and writes a result note", async () => {
	const ydoc = new Y.Doc();
	request(ydoc, "job", "vault-gardener", "  summarize this  ");
	const seen: Array<[string, string]> = [];
	const inbox = createInbox({
		ydoc,
		cfg,
		run: (ensemble: string, input: string) => {
			seen.push([ensemble, input]);
			return Promise.resolve({ status: "completed", deliverable: "the answer" });
		},
	});
	await inbox.scan();
	s.check(seen.length === 1 && seen[0]?.[0] === "vault-gardener", "ensemble named in frontmatter");
	s.check(seen[0]?.[1] === "summarize this", "body is trimmed and sent as input");
	const text = resultText(ydoc, "job");
	s.check(text !== null && text.includes("the answer"), "result note holds the deliverable");
	s.check(text !== null && parseNote(text).frontmatter.status === "completed", "result note status completed");
	await inbox.scan();
	s.check(seen.length === 1, "second scan does not rerun a finished request");
});

s.test("an llm-orc error becomes an error note, not a retry", async () => {
	const ydoc = new Y.Doc();
	request(ydoc, "bad", "vault-gardener");
	let calls = 0;
	const inbox = createInbox({
		ydoc,
		cfg,
		run: () => {
			calls++;
			return Promise.reject(new Error("llm-orc 500: kaput"));
		},
	});
	await inbox.scan();
	const text = resultText(ydoc, "bad");
	s.check(text !== null, "error result note written");
	const parsed = parseNote(text ?? "");
	s.check(parsed.error === undefined, "error note frontmatter parses");
	s.check(parsed.frontmatter.status === "error", "status: error");
	s.check((text ?? "").includes("llm-orc 500: kaput"), "error message in the body");
	await inbox.scan();
	await inbox.scan();
	s.check(calls === 1, "failed request is not retried");
});

s.test("a request with invalid frontmatter gets an error note without a run", async () => {
	const ydoc = new Y.Doc();
	createFile(ydoc, "inbox/oops.md", "---\nagent: [unclosed\n---\nbody", "laptop");
	let calls = 0;
	const inbox = createInbox({
		ydoc,
		cfg,
		run: () => {
			calls++;
			return Promise.resolve({});
		},
	});
	await inbox.scan();
	s.check(calls === 0, "run not called");
	const text = resultText(ydoc, "oops");
	s.check(text !== null && parseNote(text).frontmatter.status === "error", "error note written");
});

s.test("a re-sync mid-run does not start a second run", async () => {
	const ydoc = new Y.Doc();
	request(ydoc, "slow", "vault-gardener");
	let calls = 0;
	let release: (v: unknown) => void = () => {};
	const inbox = createInbox({
		ydoc,
		cfg,
		run: () => {
			calls++;
			return new Promise((resolve) => {
				release = resolve;
			});
		},
	});
	const first = inbox.scan();
	// a reconnect re-syncs the doc and triggers more scans while the run is open
	const again = inbox.scan();
	const thirdTime = inbox.scan();
	s.check(calls === 1, "one run started across repeated scans");
	release({ status: "completed", deliverable: "late" });
	await Promise.all([first, again, thirdTime]);
	s.check(calls === 1, "still one run after it finishes");
	s.check(resultText(ydoc, "slow") !== null, "result written once");
});

function countingInbox(ydoc: Y.Doc, device = "mini") {
	const calls: string[] = [];
	const inbox = createInbox({
		ydoc,
		cfg: { ...cfg, device },
		run: (ensemble: string) => {
			calls.push(ensemble);
			return Promise.resolve({ status: "completed", deliverable: "ok" });
		},
	});
	return { inbox, calls };
}

s.test("runner claim: a request naming another runner is skipped", async () => {
	const ydoc = new Y.Doc();
	createFile(ydoc, "inbox/theirs.md", "---\nagent: e\nrunner: laptop\n---\nbody", "laptop");
	const { inbox, calls } = countingInbox(ydoc, "mini");
	await inbox.scan();
	s.check(calls.length === 0, "not run by a different device");
	s.check(resultText(ydoc, "theirs") === null, "no result written");
});

s.test("runner claim: a request naming this device is taken", async () => {
	const ydoc = new Y.Doc();
	createFile(ydoc, "inbox/mine.md", "---\nagent: e\nrunner: mini\n---\nbody", "laptop");
	const { inbox, calls } = countingInbox(ydoc, "mini");
	await inbox.scan();
	s.check(calls.length === 1, "run by the named device");
});

s.test("runner claim: without runner any peer takes it", async () => {
	const ydoc = new Y.Doc();
	request(ydoc, "open", "e");
	const { inbox, calls } = countingInbox(ydoc, "whoever");
	await inbox.scan();
	s.check(calls.length === 1, "run by an arbitrary device");
});

s.test("loop prevention: agent-tagged notes are not requests", async () => {
	const ydoc = new Y.Doc();
	createFile(ydoc, "inbox/list.md", "---\nagent: e\ntags: [agent, ai-tools]\n---\nbody", "x");
	createFile(ydoc, "inbox/str.md", "---\nagent: e\ntags: agent\n---\nbody", "x");
	createFile(ydoc, "inbox/hash.md", "---\nagent: e\ntags: [\"#agent\"]\n---\nbody", "x");
	createFile(ydoc, "inbox/other.md", "---\nagent: e\ntags: [todo]\n---\nbody", "x");
	const { inbox, calls } = countingInbox(ydoc);
	await inbox.scan();
	s.check(calls.length === 1, "only the untagged-as-agent note ran");
	s.check(resultText(ydoc, "other") !== null, "the todo-tagged note got its result");
	s.check(resultText(ydoc, "list") === null, "agent-tagged list: no result");
	s.check(resultText(ydoc, "str") === null, "agent-tagged string: no result");
	s.check(resultText(ydoc, "hash") === null, "#agent tag: no result");
});

s.test("loop prevention: nothing under results/ is a request", async () => {
	const ydoc = new Y.Doc();
	createFile(ydoc, "results/x.md", "---\nagent: e\n---\nbody", "x");
	// inbox and results nested the odd way round
	const { inbox, calls } = countingInbox(ydoc);
	const odd = createInbox({
		ydoc,
		cfg: { device: "mini", inboxDir: "", resultsDir: "results/" },
		run: (ensemble: string) => {
			calls.push(ensemble);
			return Promise.resolve({});
		},
	});
	await inbox.scan();
	await odd.scan();
	s.check(calls.length === 0, "results/ notes never run");
});

s.test("drain waits for an in-flight run, up to the timeout", async () => {
	const ydoc = new Y.Doc();
	request(ydoc, "d", "e");
	let release: (v: unknown) => void = () => {};
	const inbox = createInbox({
		ydoc,
		cfg,
		run: () => new Promise((resolve) => {
			release = resolve;
		}),
	});
	void inbox.scan();
	const early = await inbox.drain(30);
	s.check(early === false, "drain reports a timeout while the run is open");
	const waiting = inbox.drain(2000);
	release({ status: "completed", deliverable: "x" });
	s.check((await waiting) === true, "drain resolves true once the write has landed");
	s.check(resultText(ydoc, "d") !== null, "result is in the doc when drain resolves");
	s.check((await inbox.drain(10)) === true, "drain on an idle inbox is immediate");
});

s.test("shutdown drains in-flight writes before disconnecting", async () => {
	const order: string[] = [];
	let release: (v: unknown) => void = () => {};
	const ydoc = new Y.Doc();
	request(ydoc, "sd", "e");
	const inbox = createInbox({
		ydoc,
		cfg,
		run: () => new Promise((resolve) => {
			release = resolve;
		}),
	});
	void inbox.scan();
	const done = shutdown({
		inbox,
		disconnect: () => {
			order.push("disconnect");
		},
		timeoutMs: 2000,
		settleMs: 0,
		log: (m: string) => {
			order.push(m);
		},
	});
	await new Promise((r) => setTimeout(r, 20));
	s.check(!order.includes("disconnect"), "still connected while the run is open");
	release({ status: "completed", deliverable: "x" });
	await done;
	s.check(order[order.length - 1] === "disconnect", "disconnect comes last");
	s.check(resultText(ydoc, "sd") !== null, "result was written before disconnect");
});

s.test("shutdown gives up after the timeout and disconnects anyway", async () => {
	const ydoc = new Y.Doc();
	request(ydoc, "stuck", "e");
	const inbox = createInbox({ ydoc, cfg, run: () => new Promise(() => {}) });
	void inbox.scan();
	let disconnected = false;
	const t0 = Date.now();
	await shutdown({
		inbox,
		disconnect: () => {
			disconnected = true;
		},
		timeoutMs: 50,
		settleMs: 0,
		log: () => {},
	});
	s.check(disconnected, "disconnected after the timeout");
	s.check(Date.now() - t0 < 1000, "did not wait for the stuck run");
});

function noteAt(ydoc: Y.Doc, path: string, text: string, mtime: number): void {
	const id = createFile(ydoc, path, text, "laptop");
	const entry = ydoc.getMap("meta").get(id) as Y.Map<unknown>;
	entry.set("mtime", mtime);
}

const NOW = new Date(2026, 9, 9, 3, 0, 0); // local time, 03:00
const HOUR = 3_600_000;
const gardenCfg = { ...cfg, ensemble: "vault-gardener" };

s.section("Test 6: gardener request composer");
{
	const ydoc = new Y.Doc();
	noteAt(ydoc, "daily/today.md", "fresh note", NOW.getTime() - 2 * HOUR);
	noteAt(ydoc, "daily/old.md", "stale note", NOW.getTime() - 25 * HOUR);
	noteAt(ydoc, "long.md", "x".repeat(2000), NOW.getTime() - HOUR);
	noteAt(ydoc, "inbox/req.md", "---\nagent: e\n---\nask", NOW.getTime() - HOUR);
	noteAt(ydoc, "results/res.md", "result", NOW.getTime() - HOUR);
	noteAt(ydoc, "tagged.md", "---\ntags: [agent]\n---\nagent output", NOW.getTime() - HOUR);
	noteAt(ydoc, "image-note.txt", "not markdown", NOW.getTime() - HOUR);
	const tomb = new Y.Map<unknown>();
	tomb.set("path", "deleted.md");
	tomb.set("mtime", NOW.getTime() - HOUR);
	tomb.set("deletedAt", NOW.getTime() - HOUR);
	ydoc.getMap("meta").set("tomb", tomb);

	const req = composeGardenRequest({ ydoc, now: NOW, cfg: gardenCfg });
	s.check(req !== null && req.path === "inbox/garden-2026-10-09.md", "path carries the local date");
	const parsed = parseNote(req?.text ?? "");
	s.check(parsed.error === undefined && parsed.frontmatter.agent === "vault-gardener", "frontmatter names the ensemble");
	s.check(parsed.body.includes("daily/today.md\nfresh note"), "recent note: path then text");
	s.check(!parsed.body.includes("daily/old.md"), "note older than 24 h left out");
	s.check(!parsed.body.includes("inbox/req.md") && !parsed.body.includes("results/res.md"), "inbox/ and results/ left out");
	s.check(!parsed.body.includes("tagged.md"), "agent-tagged note left out");
	s.check(!parsed.body.includes("image-note.txt"), "non-markdown left out");
	s.check(!parsed.body.includes("deleted.md"), "tombstone left out");
	s.check(parsed.body.includes("long.md\n" + "x".repeat(1500) + "\n"), "text cut to 1500 chars");
	s.check(!parsed.body.includes("x".repeat(1501)), "nothing past 1500 chars");
	s.check(parsed.body.split("\n---\n").length === 2, "entries separated by --- lines");

	const custom = composeGardenRequest({ ydoc, now: NOW, cfg: { ...gardenCfg, ensemble: "other" } });
	s.check(parseNote(custom?.text ?? "").frontmatter.agent === "other", "ensemble is configurable");

	const quiet = new Y.Doc();
	noteAt(quiet, "old.md", "old", NOW.getTime() - 30 * HOUR);
	s.check(composeGardenRequest({ ydoc: quiet, now: NOW, cfg: gardenCfg }) === null, "nothing recent: no request");
}

s.section("Test 7: gardenIfDue schedule");
{
	const ydoc = new Y.Doc();
	noteAt(ydoc, "a.md", "recent", NOW.getTime() - HOUR);
	const wrongHour = gardenIfDue({ ydoc, now: new Date(2026, 9, 9, 4, 0, 0), hour: 3, cfg: gardenCfg });
	s.check(wrongHour === null, "outside the hour: nothing created");
	s.check(!liveFiles(ydoc).has("inbox/garden-2026-10-09.md"), "no note at the wrong hour");

	const first = gardenIfDue({ ydoc, now: NOW, hour: 3, cfg: gardenCfg });
	s.check(first === "inbox/garden-2026-10-09.md", "creates the note at the hour");
	s.check(liveFiles(ydoc).has("inbox/garden-2026-10-09.md"), "note is live in the doc");
	const again = gardenIfDue({ ydoc, now: new Date(2026, 9, 9, 3, 30, 0), hour: 3, cfg: gardenCfg });
	s.check(again === null, "second tick the same day: skipped, note exists");
	s.check(ydoc.getMap("idToText").size === 2, "exactly one garden note was added");
}

s.test("the ordinary loop runs a garden request", async () => {
	const ydoc = new Y.Doc();
	noteAt(ydoc, "a.md", "recent", NOW.getTime() - HOUR);
	gardenIfDue({ ydoc, now: NOW, hour: 3, cfg: gardenCfg });
	const { inbox, calls } = countingInbox(ydoc);
	await inbox.scan();
	s.check(calls.length === 1 && calls[0] === "vault-gardener", "vault-gardener ran once");
	s.check(resultText(ydoc, "garden-2026-10-09") !== null, "result note written");
});

await s.done();
