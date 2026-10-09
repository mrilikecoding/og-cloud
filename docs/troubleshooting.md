# Troubleshooting

How to find out what this plugin actually did, written from the September 2026 incidents. Every command here has been run against the live Svalbard vault. Paths assume that vault; `OG_CLOUD_VAULT` overrides it for the scripts.

Open work lives in `BACKLOG.md`, not here. This document is for diagnosis.

## Establish what is running, first

Version confusion wasted hours before the build stamp existed.

- `cat "$VAULT/.obsidian/plugins/og-cloud/.patched"` names the upstream base, fork branch, commit and build time of the installed bundle.
- Settings → OG-cloud → Plugin version reads `2.1.1 (build <commit>, <branch>, <time> UTC)` from og.20 onward. `manifest.json` stays at upstream's `2.1.1` on every build, so the version alone tells you nothing.
- **An installed build is not a running build.** `build.sh` and `obsidian-profile sync` only put files on disk; the plugin keeps running the old code until it is reloaded. og.23 sat installed but unloaded on the Mac for two days (2026-10-07 to 10-09) while the bug it fixed kept firing. Check whether the current session predates the install:

  ```sh
  V=~/Vaults/Svalbard
  built=$(sed -n 's/^built=//p' "$V/.obsidian/plugins/og-cloud/.patched")
  boot=$(ls -t "$V/.obsidian/plugins/og-cloud/logs"/2026-*/boot-*[!e].ndjson | head -1 | xargs basename | sed 's/\.ndjson//')
  started=$(ls "$V/.obsidian/plugins/og-cloud/logs"/2026-*/$boot.ndjson | sort | head -1 | xargs head -1 | grep -o '"ts":"[^"]*"' | cut -d'"' -f4)
  echo "installed $built, running since $started"
  [[ "$started" > "$built" ]] && echo OK || echo "STALE: reload the plugin"
  ```

- **A device's plugin version cannot be determined from another device.** It is only a local IndexedDB scope key and never enters the shared document; `sys` holds only `schemaVersion`, `schemaUpdatedAt`, `schemaUpdatedBy`, `initialized`, `lastSync`. Read it on the device in question.

## The five-minute sweep

Run these in order. They have caught every incident so far.

```sh
V=~/Vaults/Svalbard

# 1. Conflict artifacts. Any hit is a real event with a timestamp in its name.
find "$V" -name "*YAOS conflict*" -not -path "*/.trash/*"

# 2. Signal events in the last two days of plain logs.
cat "$V/.obsidian/plugins/og-cloud/logs"/2026-*/*.ndjson | grep -ohE \
  "conflict-artifact-created|bound-file-[a-z-]*divergence|meta-remote-active-removed|\
binding-target-gave-up|collab-suspended|Folder already exists|crdt-file-missing-on-disk|\
amplification-quarantined" | sort | uniq -c

# 3. Is the mirror writing under a live editor? A stamp is a local user edit,
#    so a "closed file" line for the same path right before it means the
#    mirror lost track that the note is open. Prints the number of such stamps.
cat "$V/.obsidian/plugins/og-cloud/logs"/2026-*/*.ndjson | grep -o \
  '"msg":"\(afterTxn: remote content change to closed file\|stamper: stamped\) [^(]*' \
  | awk '/closed file/ { sub(/.*closed file /, ""); sub(/",.*/, ""); prev = $0; next }
         { sub(/.*stamped /, ""); sub(/ $/, ""); if ($0 == prev) n++; prev = "" }
         END { print n + 0 }'

# 4. Does the CRDT agree with itself?
cd ~/.cache/obsidian-profile/og-cloud && node scripts/crdt-health.mjs

# 5. Is the vault still being backed up?
grep -E "^== |^!!" ~/Library/Logs/vault-backup.log | tail -6
```

A clean result looks like: no artifacts, no `conflict-artifact-created`, zero stamps on a "closed" file, zero duplicate paths and zero `activeWithoutText` from the health scan, and a backup run ending in `done` with no `!!`.

## Where the evidence lives

All under `$VAULT/.obsidian/plugins/og-cloud/`:

| Path | Contents | Retention |
|---|---|---|
| `logs/<date>/boot-*.ndjson` | Human-readable event stream, one line per event | 7 days or 100 MB, whichever binds |
| `logs/<date>/boot-*-state.ndjson` | Periodic full state snapshots, 16 MB cap per boot | same |
| `logs/current-state.json` | Latest state snapshot | overwritten |
| `logs/last-crash.json` | Most recent window error or unhandled rejection | overwritten |
| `flight-logs/<date>/` | Structured product events, paths as `p:` pseudonyms | 7 days or 100 MB |

Two things to know. **Debug mode is per device and off by default**, so a device with it off has no logs at all. And at roughly 27 MB/day the 100 MB cap binds long before the 7-day cutoff, so expect about two days of plain logs, not seven. Receipt chatter is about 83% of that volume (see `COST-01`).

The two roots prune on independent schedules, so `flight-logs/` often still holds a day that `logs/` has dropped. That is how the 09-17 conflict decisions were recovered after the plain logs were pruned.

### Getting logs off a phone

The files live inside `.obsidian/`, which iOS Files hides. Do not go looking for a cable:

1. On the phone, run the command **OG-cloud: Export debug trace**.
2. It writes to `og-cloud-logs/` at the vault root, which blob-syncs to the Mac within seconds.
3. Resolve the pseudonyms locally: `node scripts/resolve-path-ids.mjs "<trace>" [--rewrite]`.

Always use the plain (redacted) export, never the with-filenames variant. The redacted file carries no real paths, so it stays safe to share, and the salt is derived from the vault id, so it is fully readable at home anyway.

## Symptom to first look

| Symptom | Look here | Usually |
|---|---|---|
| `(YAOS conflict - …)` files appear | `conflict-artifact-created` details, then the `divergence` line just before it | See the reason field, then `xxd` both artifacts. For `bound-file-ambiguous-divergence` on a new note, a leading `0a` on the disk side that the CRDT side lacks is `SYNC-03`: text typed while the editor had no binding |
| A note is stale on one device | `scripts/compare-crdt-to-disk.mjs "<path>"` | If they match, the CRDT is fine and the question is the editor or the disk write |
| A CRDT entry vanished | `meta-remote-active-removed` trace | Another device's orphan GC; the trace names the creating device and whether the path is still on disk |
| `Folder already exists.` on write | `disk.write.failed` in flight logs | Fixed in og.21. If it returns, something is reading the vault index before it is loaded |
| Text typed on the phone vanishes and comes back | Mac log: `syncFileFromDisk: applying diff` on a closed note within seconds of the Mac's own `flushWrite` for it | `SYNC-04`, fixed in og.23: the mirror's own write echo arrived after the suppression window and was imported as an external edit |
| Typed text vanishes and comes back | `flushWrite: updated` on the note being typed in, with `afterTxn: remote content change to closed file` before it | The mirror lost track that the note is open and is writing under the editor. Was the note renamed while open? Fixed in 985eb99 |
| Sync says disconnected but works | nothing; check the status bar instead | The settings row was a snapshot before og.20; it is live now |
| Version row looks wrong | `.patched` versus the build stamp | A build installed without a reload, or a device never updated |
| Backup looks incomplete | `~/Library/Logs/vault-backup.log` | See the Proton rules below; `du` understates size by design |

## Scripts

All read-only, all connect exactly as the plugin does, none write to the document, none print the token.

- **`scripts/crdt-health.mjs`** — whole-vault scan: active versus tombstoned entries, per-device counts, paths claimed by more than one live entry, active entries with no `Y.Text`, conflict artifacts that leaked into the CRDT.
- **`scripts/compare-crdt-to-disk.mjs <path>…`** — compares CRDT text against the file on disk. This is the tool that answers "did we lose anything". A `MISSING IN CRDT` result usually means the note was renamed, so check the current path before concluding anything.
- **`scripts/resolve-path-ids.mjs <trace> [--rewrite]`** — turns `p:` pseudonyms in a redacted trace back into vault paths. Pinned against `PathIdentityResolver` by `tests/client/resolve-path-ids.ts`, because a drift would silently resolve nothing.

## Rules that cost hours

**The vault index is a cache; the adapter is the filesystem.** `getAbstractFileByPath` reads Obsidian's in-memory index, which is empty early in boot. `createFolder` and friends act on the real filesystem. Trusting the index during boot produced both the `Folder already exists.` writes and 20 bogus `crdt-file-missing-on-disk` verdicts. Use `vault.adapter.exists` for existence, and gate anything that reads the vault on `workspace.onLayoutReady`.

**Exclude patterns are prefix-only.** `isExcluded` is `normalizedPath.startsWith(prefix)`. There is no glob and no extension matching, so excluding a file type means first relocating those files under one prefix.

**`compareSemver` returns `null` for any prerelease.** `2.1.1-og.21` cannot be ordered, so update recommendations and the manifest-fed compatibility guard both no-op rather than compare wrongly. That fails safe, but do not expect version comparisons to fire.

**Searching logs for another device's name finds nothing.** Every line is stamped with the logging device's `deviceName`. To see remote activity, grep `afterTxn: remote content change to closed file` and `observer: remote blob ref`.

**Back up plugin data before editing it, and reload before the plugin writes.** Plugin settings are held in memory; a running plugin will overwrite your file edit on its next save. Edit, then reload, then interact.

### The Proton Drive volume

Three separate failures came from treating `~/Library/CloudStorage/ProtonDrive-…` as an ordinary disk. It is a File Provider mount whose files can be evicted to placeholders at any time.

- **Never read from it in a script.** A read-modify-write of the change log failed with `awk: can't open file` at 03:30 and, under `set -e`, took the whole backup with it.
- **Never overwrite a file in place.** `cp` onto an existing file fails with `Operation not permitted` at 03:30. Write a temp file and rename.
- **Never let rsync use it as a delta basis.** `--whole-file` is mandatory. Without it, `mmap: Resource deadlock avoided` kills the run once the local cache is evicted, which broke five consecutive nights in September and October.
- **`du` understates the mirror.** It reports only locally cached blocks. 9.3 GB of content showed as 3.0G, then 16K after an eviction. The backup summary prints content size and cached size separately for this reason.

Keep anything authoritative on local disk and push copies outward. The change log is assembled at `~/Library/Logs/vault-backup-changes.md` and copied to Proton, so a failed publish is self-healing on the next run.

### Testing destructive paths

rsync and `cp` both resist naive sabotage, which makes failure injection harder than it looks. `rsync -a` resets a destination directory's mode and writes via temp file, so a read-only directory or a mode-000 target still succeeds. `cp` writes *into* a directory of the same name and overwrites an existing file even in a read-only parent. To force a failure, remove the target and restrict the parent, or put a stub earlier on `PATH`.

## Looks alarming, is not

- `binding-health-failed` and `bind: repairing unhealthy binding (issues=missing-sync-facet)` on every note open. Obsidian drops the collab facet while loading the document; the retry scheduler reattaches it within about 40 ms.
- `Auth rejected (unauthorized) — assuming stale socket ticket`. Recovers in under a second; the ticket refresh is working.
- `syncFileFromDisk: skipping … (editor-bound, disk lag)` in the hundreds. Normal while typing.
- Empty `logs/<date>/` directories. Retention deletes files; the `rmdir` is best-effort and leaves 0-byte shells.
- `binding-repair-after-recovery` with `healthyBeforeRecovery: true`. Deliberate since a9db183: recovery suspends collab around its diff, so the binding always needs reattaching afterwards.

## State as of 2026-10-03

Running `2.1.1-og.23` (`5f1db4e`) on the Mac. Open items, with detail in `BACKLOG.md`:

- **`SYNC-03`** — conflict artifacts while typing into a new note. Fixed in og.22, awaiting field confirmation.
- **`SYNC-04`** — late write echoes re-imported, deleting the phone's keystrokes. Fixed in og.23, awaiting field confirmation.
- **`SYNC-05`** — stale editor typed into after a restart with the note open (Orphan.md, 10-07). Open; the next thing to pick up.
- **`COST-01`** — Durable Object stays resident despite `hibernate: true`; about 58% of the included duration allowance, driven by a message floor of roughly one per minute through idle hours.
- The three `closed-file-*` artifacts of 09-17 were never explained. The plain logs for that day are long pruned; the flight logs recorded `both-changed` and `missing-baseline` verdicts during a day of repeated plugin rebuilds.
- Upstream carries the stale-seed bug fixed here in 7808be6 and the folder-creation bug fixed in 5b04c84. No patch has been offered upstream.
