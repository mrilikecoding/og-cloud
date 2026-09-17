import { computeTimestampEdits, type TimestampEdit } from "../../src/sync/timestampStamper";
import { suite } from "../harness.ts";

const s = suite("timestamp-stamper-edits");

const NOW = "2026-09-16T21:08:12-07:00";

function apply(text: string, edits: TimestampEdit[]): string {
	// Edits arrive sorted by `from` descending; apply in that order.
	let out = text;
	for (const e of edits) {
		out = out.slice(0, e.from) + e.insert + out.slice(e.to);
	}
	return out;
}

s.section("Test 1: no frontmatter, modified only → minimal block prepended");
{
	const edits = computeTimestampEdits("hello\n", NOW, { withCreated: false });
	s.check(edits.length === 1, "one edit");
	s.check(apply("hello\n", edits) === `---\nmodified: ${NOW}\n---\nhello\n`, "block prepended");
}

s.section("Test 2: no frontmatter, withCreated → created and modified block");
{
	const edits = computeTimestampEdits("", NOW, { withCreated: true });
	s.check(apply("", edits) === `---\ncreated: ${NOW}\nmodified: ${NOW}\n---\n`, "both keys");
}

s.section("Test 3: block without modified → modified appended before the closing fence");
{
	const text = "---\ntype: stub\ntags:\n  - x\n---\nbody\n";
	const edits = computeTimestampEdits(text, NOW, { withCreated: false });
	s.check(apply(text, edits) === `---\ntype: stub\ntags:\n  - x\nmodified: ${NOW}\n---\nbody\n`, "appended");
}

s.section("Test 4: block with modified → only the value range is replaced");
{
	const old = "2023-02-16T10:00:00-08:00";
	const text = `---\ncreated: 2022-01-01T00:00:00-08:00\nmodified: ${old}\n---\nbody\n`;
	const edits = computeTimestampEdits(text, NOW, { withCreated: false });
	s.check(edits.length === 1, "one edit");
	s.check(edits[0]!.to - edits[0]!.from === old.length, "range covers exactly the old value");
	s.check(edits[0]!.insert === NOW, "inserts the new value");
	s.check(apply(text, edits) === `---\ncreated: 2022-01-01T00:00:00-08:00\nmodified: ${NOW}\n---\nbody\n`, "rest untouched");
}

s.section("Test 5: withCreated but created already present → not touched");
{
	const text = `---\ncreated: 2022-01-01T00:00:00-08:00\nmodified: 2022-01-02T00:00:00-08:00\n---\n`;
	const out = apply(text, computeTimestampEdits(text, NOW, { withCreated: true }));
	s.check(out === `---\ncreated: 2022-01-01T00:00:00-08:00\nmodified: ${NOW}\n---\n`, "created kept, modified replaced");
}

s.section("Test 6: withCreated, block has modified but no created → created added, modified replaced");
{
	const text = `---\nmodified: 2022-01-02T00:00:00-08:00\n---\nbody`;
	const out = apply(text, computeTimestampEdits(text, NOW, { withCreated: true }));
	s.check(out === `---\nmodified: ${NOW}\ncreated: ${NOW}\n---\nbody`, "created appended, modified replaced");
}

s.section("Test 7: malformed frontmatter (no closing fence) → no edits");
{
	const edits = computeTimestampEdits("---\nmodified: x\nbody", NOW, { withCreated: true });
	s.check(edits.length === 0, "left alone");
}

s.section("Test 8: value already equals now → no edits");
{
	const text = `---\nmodified: ${NOW}\n---\n`;
	s.check(computeTimestampEdits(text, NOW, { withCreated: false }).length === 0, "no-op");
}

s.section("Test 9: CRLF line endings → value range excludes the CR");
{
	const old = "2023-02-16T10:00:00-08:00";
	const text = `---\r\nmodified: ${old}\r\n---\r\nbody\r\n`;
	const edits = computeTimestampEdits(text, NOW, { withCreated: false });
	s.check(apply(text, edits) === `---\r\nmodified: ${NOW}\r\n---\r\nbody\r\n`, "CR preserved");
}

s.section("Test 10: edits are sorted by from descending");
{
	const text = `---\nmodified: 2022-01-02T00:00:00-08:00\n---\n`;
	const edits = computeTimestampEdits(text, NOW, { withCreated: true });
	s.check(edits.length === 2, "two edits");
	s.check(edits[0]!.from > edits[1]!.from, "descending");
}

await s.done();
