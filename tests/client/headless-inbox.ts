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

await s.done();
