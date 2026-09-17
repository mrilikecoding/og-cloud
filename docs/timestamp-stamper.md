# Timestamp stamper

OG Cloud maintains `created` and `modified` frontmatter itself, as CRDT edits,
replacing the community plugin Front Matter Timestamps.

## Why

Front Matter Timestamps writes `modified:` to disk through `processFrontMatter`
one second after every keystroke and stamps new notes on create. For a note
open in the editor that is a second writer on a file whose CRDT is fed only by
the editor. The reconciler sees disk and CRDT disagree while the user keeps
typing, and mints conflict artifacts. On a new note the stamp lands during the
`missing-sync-facet` gap and the CRDT copy is garbled. Diagnosed 2026-09-16 in
the Svalbard vault: zero conflicts in six boot logs before the plugin was
enabled, ten after, every divergence exactly one timestamp block or line.

## Rules

- A user edit in the Obsidian editor bumps `modified`. Nothing else does:
  not remote edits arriving from another device, not disk imports, not
  renames or moves, not the stamp itself.
- `created` is stamped once, together with the first `modified`, on a note that
  Obsidian created empty in this session. It is never invented for an existing
  note.
- Notes without a `modified` key get one appended inside their existing block.
  Notes with no frontmatter get a minimal block `---\nmodified: …\n---\n`.
  A malformed block (no closing fence) is left alone.
- Format is `YYYY-MM-DDTHH:mm:ssZ` from Obsidian's `moment`, local offset,
  matching the 2,312 values already in the vault. Property names are fixed.
- One settings toggle, `timestampStampingEnabled`, default on.

## Mechanism

**Trigger.** `EditorBindingManager.handleLiveEditorUpdate`
(`src/sync/editorBinding.ts:1092`) already sees every CodeMirror update for a
bound view. A user edit is `update.docChanged` where no transaction carries
`ySyncAnnotation`; changes y-codemirror applied from Y carry it. The manager
calls `stamper.noteUserEdit(path)`.

**Debounce.** 2 s after the last user edit on a path the stamper runs. If the
path was recorded as born-empty and its Y text has no `created`, it stamps
both keys; otherwise `modified` only.

**Edit.** `computeTimestampEdit(text, now, { withCreated })` is a pure function
returning `{ from, to, insert } | null`. It reuses `extractFrontmatter` from
`src/sync/frontmatterGuard.ts`. It replaces only the value range of an
existing `modified:` line, so the change is as small as possible. The stamper
applies it as one `ytext.delete` + `ytext.insert` in a transaction with origin
`ORIGIN_TIMESTAMP`.

**Origin.** `ORIGIN_TIMESTAMP` is a string origin that is deliberately *not* in
`LOCAL_STRING_ORIGIN_SET` (`src/sync/origins.ts`). y-codemirror applies any
transaction whose origin is not its own config to the view, so the editor
updates in place and the selection maps through the change. The undo manager
does not track it. The disk mirror treats it as remote and writes it through
`scheduleWrite`, on open and closed files alike. That is the path every phone
edit already takes, and it means a note closed before the debounce fires still
reaches disk instead of sitting in the CRDT as a future conflict.

**Born-empty.** The vault `create` handler in `src/main.ts` records paths whose
`stat.size` is 0 in a session-local set on the stamper. Renames move the entry
(the rename handler already exists). Any other create, including Longform
templates, imports and conflict artifacts, is not born-empty.

**Off switch.** With the toggle off, `noteUserEdit` is a no-op and nothing is
recorded.

## Files

- `src/sync/timestampStamper.ts`: `computeTimestampEdit` (pure) and
  `TimestampStamper` (debounce, born-empty set, apply).
- `src/sync/origins.ts`: add `ORIGIN_TIMESTAMP` with a comment saying why it
  is not local.
- `src/sync/editorBinding.ts`: call `noteUserEdit` from the live update
  listener.
- `src/main.ts`: construct the stamper, record born-empty on create, forward
  renames.
- `src/settings/settingsStore.ts`, `settingsTab.ts`: the toggle.

## Known limitation

Two devices stamping the same note inside one 2 s window both replace the same
value range; Yjs keeps both inserts and the line reads as two concatenated
timestamps. The next stamp on either device rewrites the whole value, so it
self-heals. No lock.

## Testing

- `tests/client/timestamp-stamper-edit.ts`: `computeTimestampEdit` for no
  frontmatter, block without `modified`, block with `modified`, `created`
  requested and present, `created` requested and absent, malformed block,
  CRLF line endings, value range only (surrounding text untouched).
- `tests/client/timestamp-stamper.ts`: debounce collapses a burst to one
  stamp; a stamp does not re-trigger itself; remote-origin changes do not
  stamp; born-empty path gets `created` once; toggle off is inert.
- `tests/client/disk-mirror-origin-classification.ts`: `ORIGIN_TIMESTAMP` is
  classified as not local.
- Field: type on the Mac and watch `modified` change on the phone within a few
  seconds; reverse; create a note on each device and confirm `created`;
  confirm no `bound-file-*-divergence` lines in the boot log while typing.

## Rollout

Release as `2.1.1-og.8`. Disable and remove Front Matter Timestamps in the
vault on every device before enabling the build. The seven existing conflict
artifacts are cleaned up by hand.
