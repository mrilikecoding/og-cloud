# Main backlog

Canonical list of unfinished work inherited by `main` before the feature branches. This excludes `.obsidian` sync, headless CLI, Docker, multivault/collaboration, auth rewrite, sharded note bodies, and recovery-v2 feature work.

Each item names current evidence, required work, and closure evidence. Historical discussion remains in Git history.

## Priority definitions

- **P0:** known correctness/data-preservation or current user incident.
- **P1:** required evidence or hardening for a confidence-heavy release.
- **P2:** bounded engineering debt; carry only if its owning code survives feature integration.
- **External:** closure depends on a reporter or real device/deployment unavailable to CI.

## P0 correctness and user incidents

### SYNC-01 — offline local delete is resurrected on re-enable

**State:** Known failing behavior hidden as an expected failure.

**Evidence:** `qa/controllers/two-device.ts`, scenario `issue-22-disable-reenable-local-delete-remote-unchanged`, explicitly logs a known issue and does not fail. When the file is absent on disk but still present in CRDT, `VaultSync.reconcileVault()` places it in `createdOnDisk`; `ReconciliationController` writes it back. The implementation cannot distinguish a file missing because this device has never materialized it from a file that this device previously indexed and deleted while YAOS was disabled.

**Required work:**

1. Convert the existing scenario into a hard failing regression; no warning-only acceptance.
2. Define startup classification using the persisted disk index: known indexed path now absent versus path never materialized locally.
3. Ensure unreadable/skipped paths cannot be mistaken for confirmed deletion.
4. Propagate a proven offline delete without allowing a stale device to delete a genuinely new remote file.
5. Preserve conflicting remote edits according to the delete/conflict contract.

**Closure:** Focused regression fails before the fix and passes after it; re-enable keeps the file absent on the deleting device; the remote device observes the intended delete or an explicitly preserved conflict; unreadable-path and new-device materialization cases remain safe.

### SYNC-09 — a device replaces a note with its own stale disk copy after a blocked write

**State:** Fixed in bccc008a (og.27), awaiting field confirmation. Second section of the vault note `Notes/docs/og-cloud-blob-startup-overwrite.md`.

**Evidence:** 2026-10-22T03:44:01Z, Mac boot `L3-M05Hgw-i9N7`: `afterTxn: remote content change to closed file` for `Notes/Genealogy/Places/Chautauqua County, New York.md` and `Notes/Genealogy/Paternal/AKIN/John J. Akin.md`, then `flushWrite: updated` with 3,221 and 5,625 chars. Both are the 19 Oct texts, byte for byte; the 21 Oct texts (34,660 and 9,669 B, written on the Mac at 23:38Z and 23:44Z on the 21st) were gone with nothing merged. A clean replacement means the sending device's Y.Text already held the 21 Oct text and was overwritten whole (`forceReplaceYText`), which is what `import-disk-to-crdt` does. In the same minute the phone's blob reconcile set 15 `.edtz` refs back to their 10-21 hashes (`b0bd4d`, `831f62`, `7416f9`, …): its stale sidecars uploaded as "changed offline", the blob side of the same stale-disk problem. Edit History on the Mac gives John J. Akin's frontmatter as 128 chars on 19 Oct and 503 on 21 Oct; `validateFrontmatterTransition(19Oct, 21Oct)` returns `block` (`frontmatter-growth-burst`) and the reverse returns `ok`. The Mac has never logged `frontmatter write blocked`; the phone's logs were not retrieved.

**Cause:** `runReconciliation` wrote the CRDT to disk for `apply-remote-to-disk` paths with `await diskMirror.flushWrite(path)` and then set `settledHashes[path] = crdtHash` without checking that a write happened. `flushWrite` returned `void` and has silent exits: no Y.Text, open-editor deferral, `shouldBlockFrontmatterWrite`, and a caught write error. On the phone's first boot after the Mac's edits, disk was at the 19 Oct baseline and the CRDT ahead, so the planner correctly chose `apply-remote-to-disk`; the flush for John J. Akin was blocked by the growth rule (Chautauqua's exit is unknown, its transition is `ok`), and the baseline advanced to the 21 Oct hash anyway. On the next boot the planner saw `crdt == baseline, disk != baseline` and chose `import-disk-to-crdt` (`closed-file-disk-wins-clean`), replacing the CRDT with the 19 Oct text. Upstream YAOS code in both places.

**Fix:** `flushWrite` returns `FlushWriteOutcome` (`written | unchanged | no-ytext | deferred | blocked | failed`); both reconcile flush loops advance the baseline only on `written`/`unchanged` (`flushSettledDisk`) and trace `reconcile-baseline-held` with the outcome otherwise, so the baseline stays equal to disk and the next reconcile sees the same divergence. Regression: `tests/client/reconcile-baseline-follows-write.ts`, whose Test 2 reproduces the 03:44 replacement on the unfixed code.

**Left as is:** the growth rule itself. It is a defence against frontmatter duplication, and it will now block the phone's disk copy of John J. Akin at every boot (`frontmatter write blocked` + `reconcile-baseline-held`) until the note is opened there, when the editor binding writes the CRDT text through Obsidian's own save. Adding a dozen schema keys to a note with three is going to keep tripping it during the genealogy schema work. Decision for Nathan: raise the threshold, exempt reconcile writes, or live with it. Not touched: the blob side (stale `.edtz` uploaded as changed offline) needs the per-blob baseline noted under SYNC-08.

**Closure:** `reconcile-baseline-held` traces appear on the device with the blocked write, never followed by `closed-file-disk-wins-clean` for the same path on a later boot; no `remote content change to closed file` that shrinks a note to an older Edit History version.

### SYNC-08 — blob sync reverts non-Markdown files edited while Obsidian was closed

**State:** Fixed in f6f00bd2 (og.26), awaiting field confirmation. Reported in the vault note `Notes/docs/og-cloud-blob-startup-overwrite.md`, written by the Claude session whose edits were lost.

**Evidence:** 2026-10-21, boot `boot-NIWEjwWC7SsQOp`. Obsidian had been closed since about 02:08Z; a script session edited `Vault Maintenance/vocabulary.json`, `scripts/check_notes.py` and 19 `.md.edtz` sidecars on disk. At 23:19:53.52Z, before `IndexedDB loaded` (53.96) and before the provider connected (55.33), the pathToBlob observer logged `remote blob ref for …` for every blob in the vault (11,856; the log dropped most lines). Blob reconcile at 56.956 queued 25 uploads including those 21 paths. The gate opened at 56.977, `dropped 11835 stale queued downloads`, drained 21: every one was a path with an upload queued 35 ms earlier. Each got `download-overwrite-decision action=overwrite-existing` and was replaced by the server copy. The upload for `vocabulary.json` then completed and wrote `setBlobRef hash=c1fcc1a9… (1092 bytes)`: the local content's hash with the overwritten file's size. At 23:49 a modify-event upload deduped against R2 and set the ref back to the old hash, so no device kept the edit. Markdown notes were fine throughout (29 `import-disk-to-crdt` decisions, reason `crdt-at-baseline`).

**Cause:** three gaps that only bite together. (1) `startObservers` excluded only `ORIGIN_SEED`; y-indexeddb's `fetchUpdates` applies the stored doc in one transaction whose origin is the `IndexeddbPersistence` instance, so the replay read as a remote add of every blob. (2) `pruneSatisfiedQueuedDownloads` drops a queued download only when the hash cache, keyed by `{mtime,size}`, already holds the remote hash for the file's current stat; a file edited offline misses the cache and stays queued. (3) `processDownload` decided from disk hash vs remote hash alone, with no look at the upload queue, where the reconcile had just recorded the opposite decision for the same path. The code is upstream YAOS's, so stock 2.1.1 shares it.

**Fix:** both blob observers act only on provider-origin and `ORIGIN_RESTORE` transactions (`isLocalOrigin`), so the replay schedules nothing and this device's own `setBlobRef` and renames never did; a download for a path with an upload pending, in flight, or in the modify debounce keeps the local file and writes the remote bytes as a conflict artifact (`download-conflict-quarantined`, reason `local-upload-pending`); the ref after an upload carries the size of the hashed bytes. Regression: `tests/client/blob-startup-local-edit.ts`. Side effect worth knowing: tombstones no longer re-run `handleRemoteDelete` at every boot through the replay; a tombstone received while offline still arrives with provider origin.

**Not done:** a per-blob last-synced baseline (true three-way merge for blobs) and a safety brake on mass blob overwrites, both suggested in the report. The upload-pending guard covers the offline-edit case because the reconcile queues the upload before the gate opens; a baseline would also cover a remote change racing a local one when neither has queued yet.

**Closure:** after a start where blobs changed offline, `reconcile: N uploads queued` with no `download: started` for the same paths and no `download-overwrite-decision … overwrite-existing` within the first minute; `observer: remote blob ref` lines appear only after `Provider synced`. Sweep: `grep -c '"msg":"observer: remote blob ref' logs/<day>/boot-*.ndjson` should be small, not thousands, on a boot.

### SYNC-07 — sync stays offline after the Mac wakes from sleep

**State:** Fixed (og.25), awaiting field confirmation.

**Evidence:** 2026-10-19, boot `boot-k33XYFTRWrlARW`. Last server receipt 15:12Z; the Mac slept at about 15:13Z and Obsidian was foregrounded at 15:28:49Z (`Fast reconnect triggered (app-foregrounded)`). Exactly 60 s later, `Provider status=disconnected`, then nothing but `socket ticket refreshed in provider URL` every 4.5 min until a manual reconnect nine hours on. The status bar read `OG-cloud Unsent`. Earlier the same day four `Auth rejected (unauthorized)` cycles recovered in under 10 s each, because those went through the server.

**Cause:** `requestFastReconnect` called `provider.disconnect()` and 500 ms later checked `if (currentSync.connected || provider.wsconnecting) return;` before `provider.connect()`. y-partyserver's `disconnect()` sets `shouldConnect = false` and calls `ws.close()`, but `wsconnected` only clears in the socket's `close` event, and on a TCP connection that died during sleep Chromium waits out the close handshake (the 60 s). So `connected` still read true, `connect()` was skipped, and when the close finally fired the provider's backoff reconnect ran `setupWS`, whose first check is `shouldConnect`. The manual `reconnect()` path calls `disconnect(); connect();` back to back with no guard, which is why it recovers.

**Fix:** the fast path always calls `connect()` after the jitter. `connect()` sets `shouldConnect` and only opens a socket when `ws === null`, so with the old socket still closing it does nothing but restore the flag. Regression: `tests/client/fast-reconnect-zombie-socket.ts` (fake provider with a delayed close).

**Closure:** after a sleep/wake, `Fast reconnect triggered` is followed by `Provider status=connected` and a new `Connection generation` within about 70 s (the close handshake timeout plus backoff), never by a lone `status=disconnected`. Check with `grep -hE '"msg":"(Fast reconnect triggered|Provider status=|Connection generation)' logs/<day>/boot-*.ndjson`.

### SYNC-06 — an open note is rewritten every few seconds, changing only `modified:`

**State:** Fixed in 3f965d3c and ecba96d7 (og.24), awaiting field confirmation.

**Evidence:** `Notes/Genealogy/Paternal/PATTAT/Pierre Pattat.md` on 2026-10-15, 15:10 to 16:04Z and 17:39Z until the tab was closed at 18:38Z: 1,680 `timestamp-stamped` traces, one every 3.5 s, each cycle `stamper: stamped` → `flushWrite: updated` → `Suppressed modify event` → stamp. Consecutive disk copies differ only in the `modified:` seconds. `Alice Holloway.md` ran the same loop for 2,508 stamps on 10-13 and `Madeleine Taquelet.md` for 479. All three were open in the same tab (leaf `48a9099ab00e2113`) and all three had been written from outside Obsidian (Claude; file mode 600) while open, which is what started each loop. `current-state.json` mid-cycle showed editor == disk, editor ≠ CRDT, same length: the CRDT held the new stamp and the editor did not.

**Cause:** the tab's binding pushed editor changes into the Y.Text but no longer received the Y.Text's changes, and `inspectBindingHealth` could not tell: it checks that the ySync facet names the right Y.Text, not that the editor follows it. With the CRDT→editor direction dead, every stamp reached disk through the mirror, Obsidian reloaded the open editor from disk, y-codemirror pushed the reloaded `modified:` value back into the CRDT as a user edit, and the stamper stamped again. How that binding lost its observer is not proven. The log shows it breaking at 2026-10-13T23:20:42Z in a `live-update` repair: `bind: failed ... Calls to EditorView.update are not allowed while an update is in progress`, i.e. the repair dispatched a reconfigure from inside CodeMirror's own update; the rebind's `unbind` half failed the same way, silently, and a retry then reported `bind: bound`. Two code facts make a stale ySync instance possible in that neighbourhood: CodeMirror keeps a ViewPlugin instance across a reconfigure when the same spec is present before and after (`updatePlugins`), and y-codemirror's `ySync` is one module-level spec whose instance captured its `YSyncConfig` and Y.Text observer at construction, so `repair` going straight from `yCollab(old)` to `yCollab(new)` left the instance on the old config.

**Fix:** three parts.
1. The stamper remembers the body (text minus the `modified:` value) at its last stamp and skips a user transaction that leaves it unchanged (`timestamp-stamp-skipped`, reason `body-unchanged`). This ends the loop whatever broke the binding.
2. Each binding observes its Y.Text; after a non-editor transaction the editor must show the same text (y-codemirror applies synchronously and its observer runs first). A mismatch is traced as `binding-editor-missed-update`, adds the `editor-missed-update` health issue, and the binding is rebound. `suspendCollab` marks the binding so recovery's deliberate detach is not reported.
3. `live-update` health checks are deferred to the next task, and a repair that keeps the EditorView dispatches `reconfigure([])` before the new `yCollab`, so the ySync instance is rebuilt. Regression: `tests/client/binding-crdt-to-editor-health.ts`, `timestamp-stamper.ts` tests 16 and 17.

**Closure:** no path with more than a few `timestamp-stamped` traces per minute over a week of use; a `binding-editor-missed-update` trace, if one ever fires, followed by `binding-health-restored` and no loop. The sweep: `grep -h '"msg":"timestamp-stamped' logs/<day>/boot-*.ndjson | grep -oE '"path":"[^"]+' | sort | uniq -c | sort -rn | head`.

### SYNC-05 — a note opened with a stale disk copy is typed into before the editor sees the CRDT

**State:** Open, one incident with artifacts, fix not started.

**Evidence:** `Notes/Writing/Free Write/Orphan.md`, 2026-10-07T00:17:05Z, on og.22. The previous Mac session ended at 00:16:35 mid-typing (its last 15 characters reached the CRDT but not disk, Obsidian's autosave never ran). The new boot's reconcile correctly found `1 need disk update` for the open note and deferred the write because the note was open; `bind` then attached yCollab with the editor showing the stale disk text (5651) and the Y.Text 15 characters longer (5666). The user typed into that editor, yCollab applied the keystrokes at editor offsets into a longer Y.Text, and 7 s later the classifier saw editor ≠ disk ≠ CRDT and preserved both sides. The CRDT artifact carries `who my motmother and`, a garbled splice; the final note is intact only because the deferred write later replaced the editor text.

**Cause:** nothing brings the editor to the CRDT before yCollab attaches when the disk copy is behind. The open-file write path handles it eventually, but it is deferred 1.5 s after bind (`lastEditorChangeAtMs` is set to bind time) and relies on Obsidian reloading the editor from disk, which races with typing.

**Fix direction:** when reconcile schedules a CRDT-to-disk update for an open path, keep the disk snapshot it compared against. In `bind`, if the editor text equals that snapshot and differs from the Y.Text, dispatch the Y.Text content into the editor as one CM change before the collab extension is applied, so y-codemirror does not echo it back. If the editor already differs from the snapshot the user typed during startup; leave it to the local-only recovery. Touches reconciliation, DiskMirror and EditorBindingManager.

**Closure:** restart Obsidian mid-sentence with the note open, type immediately on reopen, no artifact and the sentence is intact on both devices.

### SYNC-04 — the mirror re-imported its own late disk writes and deleted the other device's keystrokes

**State:** Fixed in 5f1db4e (og.23), awaiting field confirmation.

**Evidence:** Mac log 2026-10-06T03:35:56 to 03:36:01 while the phone typed into `Notes/Rayna/Rayna Sleep Log.md`, closed on the Mac: `flushWrite: updated (483)`, 1.02 s later `syncFileFromDisk: applying diff (485 -> 483)`, then `flushWrite (485)`, `applying diff (484 -> 485)`, `flushWrite (484)`, four cycles. The phone trace for the same seconds shows `recovery.decision bound-file-local-only-divergence` repairing 485 -> 486 and `editor.repair.applied`. The user sees this as text that disappears and comes back.

**Cause:** write suppression was one entry per path expiring 500 ms after the write. Obsidian's modify event for the mirror's own write arrives 360 ms later at the median and 450 ms at p90 (10-03 to 10-06, 273 acknowledged writes), so the slow ones crossed the window and were imported as external edits of a closed file, diffing a stale copy into a CRDT the phone had moved on from. A second write to the same path also replaced the entry, so the first write's echo met the wrong fingerprint.

**Fix:** entries are a per-path list kept for 30 s and consumed by fingerprint match; an external edit in between no longer discards pending echoes. Regression: `tests/client/disk-mirror-write-echo.ts`.

### SYNC-03 — conflict artifacts while a new note is being typed

**State:** Fixed in 985eb99 and d0b01c3, not yet confirmed in the field.

**Evidence:** `Notes/Writing/Free Write/Snakes.md` on 2026-09-30T23:14:13Z and `Notes/Writing/Free Write/Freewrite.md` on 2026-10-03T18:50:33Z each produced a `crdt` and a `disk` conflict artifact, reason `bound-file-ambiguous-divergence`. Both notes were created as `Untitled` and renamed while open. In both incidents the disk artifact begins with a newline byte (`0a`) that the CRDT artifact lacks, so the editor and the disk held one character the CRDT never received. An earlier reading of this entry called it keystroke lag with no real divergence; the lengths looked that way (6/8, 23/23, 33/35, 47/46) only because typing continued on top of a one-character offset.

**Cause:** Two defects in the rename of an open note.

1. Obsidian updates `view.file.path` before the rename batch updates the path map. The binding audit saw `path-changed` and `ytext-mismatch` and forced an unbind and rebind, although the file id and `Y.Text` were unchanged. The rebind waited about 180 ms for the path map, and typing in that window missed the CRDT. `bind` never compared editor text with the `Y.Text` it attached to. The same gap exists after a create, while `bind` waits about 600 ms for the disk seed.
2. `layout-change` fires before the rename batch flushes and closed the old path in `EditorWorkspaceOrchestrator`, so `onRenameBatchFlushed` had nothing to move and the disk mirror treated the note as closed. Every timestamp stamp then wrote the note to disk under the live editor: 647 of 2,015 stamps between 09-26 and 10-03.

**Fix:** A rename of the bound `TFile` keeps its binding (`followRename`). A user edit made while `bind` waits for a `Y.Text` is diffed in before yCollab attaches, with origin `ORIGIN_EDITOR_UNBOUND_CARRY`. `onRenameBatchFlushed` reopens the new path when an earlier sweep closed the old one. Regressions: `tests/client/unbound-edits-and-rename-binding.ts`, `tests/client/rename-keeps-open-tracking.ts`.

**Not done:** Where the leading newline is typed was never observed directly; the likeliest source is the Enter that commits the inline title. The ambiguous branch of `handleBoundFileSyncGap` still has no recent-typing guard. Adding one before this cause was found would have hidden it, so it stays out until a case appears that the fixes above do not cover.

**Closure:** A week of creating and renaming notes on both devices with no artifact, no `binding-rename-in-flight` followed by an unbind, and zero stamps on a "closed" file in the sweep.

### SYNC-02 — bound-file re-enable can discard one changed side

**State:** Open correctness gap with real iPad trace history.

**Evidence:** `ReconciliationController.handleBoundFileSyncGap` has `localOnly`, `crdtOnly`, and ambiguous branches. If disk and CRDT both changed from the persisted baseline but the editor equals one side, the equality shortcut can select that side without invoking the full closed-file three-way classifier. A recorded ordering produced remote CRDT at the original path and discarded the local iPad edit without an artifact.

**Required work:**

1. Compute baseline, disk, and CRDT hashes before the local-only/CRDT-only shortcut.
2. When both sides differ from baseline and from each other, run the same preserve-conflict classification used for closed files.
3. Preserve the losing version before applying the winner.
4. Keep current `crdt-current-no-op` and recovery-lock skips.
5. Cover provider-sync-versus-reconcile ordering, not only the pure classifier.

**Closure:** Deterministic regression proves preservation and convergence; a real iPad re-enable run reproduces the relevant ordering and retains both versions.

### ISSUE-19 — `.base` rollback and bulk-clipping misses

**State:** Open GitHub issue from YAOS 1.6.0.

**Evidence:** User reports local `.base` layout changes later disappearing and one of several iOS Web Clipper-created Markdown files failing to reach desktop until renamed. `.base` currently uses the attachment plane; bulk-created Markdown uses ordinary file admission.

**Required investigation:** Treat these as two failure shapes until evidence joins them. Reproduce `.base` write/restart/reconnect through attachment hashing and download conflict policy. Reproduce a burst of iOS-created Markdown files and trace watcher admission, dirty-set draining, disk-index advancement, CRDT creation, provider receipt, and desktop materialization. Do not convert `.base` to Markdown character merging as a symptom fix.

**Closure:** Each shape has a focused failing reproduction, root-cause fix, regression, and reporter-facing build/result. Renaming must not be required to recover a missed create.

### ISSUE-23 — Canvas rollback and Excalidraw save freeze

**State:** Open GitHub issue from YAOS 1.6.1.

**Evidence:** User reports Canvas versions alternating after phone restarts and sporadic whole-Obsidian freezes when Excalidraw saves while YAOS is enabled. Both formats use the attachment plane; Excalidraw's own save behavior may contribute but does not explain a YAOS-only freeze.

**Required investigation:** Reproduce Canvas create/edit/restart across desktop and mobile while recording blob tombstones, hash cache, upload/download queue, and conflict decisions. Profile the Excalidraw save path for synchronous hashing, repeated watcher churn, queue loops, and plugin interaction. Preserve the exact file bytes and operation ordering; do not infer one root cause for both formats without evidence.

**Closure:** Focused reproductions identify the responsible path; Canvas no longer rolls backward/oscillates; Excalidraw save does not freeze Obsidian under the reproduced workload; attachment regressions cover the fixed transitions.

### ISSUE-68 — false receipt warning and idle auth rejection

**State:** Open against 2.1.0.

**Evidence:** Reporter traces show a candidate confirmed by one server echo and then reverted to `serverDominatesCandidate=false` by a later echo with the same encoded byte count. The status bar returns to “local state not yet received.” The same reporter observes `Auth rejected` after idle time and must reload the plugin.

**Required investigation:** Treat receipt state and idle authentication as separate until traces prove a connection. For receipts, reproduce the exact candidate/state-vector/persistence-generation sequence and determine whether remote or maintenance updates replace the candidate, whether a later non-dominating echo is allowed to revoke a valid latest-state receipt, or whether server/client documents diverge despite equal encoded lengths. For auth, capture ticket expiry, proactive refresh, patched provider URL, reconnect attempts, fatal frames, and HTTP ticket refresh result over real idle/sleep timing.

The existing local `ws-ticket-reconnect` suite proves URL patching and short-TTL reconnect under Wrangler; it does not invalidate the field report.

**Closure:** Issue-shaped traces no longer produce a false negative; status language remains exact; a real idle/sleep reconnect succeeds without plugin reload; regression coverage fails on the identified root cause.

## P1 validation and release confidence

### QA-01 — strict Linux+iPad+Android active-edit proof

**State:** Implemented scenario; never executed to its strict contract.

**Evidence:** Existing three-device evidence is passive agreement on a pre-existing hash. The two-desktop active-edit scenario passes, but it is not real mobile evidence.

**Required work and closure:** Execute the procedure in [QA](qa.md#qa-01-strict-three-device-active-edit). Preserve three untouched bundles, analyzer report, and human summary. Closure requires foreground iOS/Android, a distinct Linux local-edit target hash, both mobile devices settling that exact hash, and `summary.ok: true`.

### QA-02 — real-device conflict-artifact proof

**State:** Desktop proof exists; mobile/tablet proof absent.

**Required work and closure:** Execute [QA](qa.md#qa-02-real-device-conflict-artifact) on real devices. The local offline edit must survive at the original path, remote content must be preserved, artifact locality must match policy, and all original paths must converge.

### QA-03 — iPad missing-baseline/cold-relaunch proof

**State:** Desktop classifier and CDP coverage exist; mobile filesystem timing is unproven.

**Evidence:** The current heuristic gives disk the original path only when `diskMtime > lastDiskIndexPersistedAt`; otherwise CRDT wins while disk is preserved separately. The timestamp is global and may be coarse or preserved by external tools.

**Required work:** Kill/suspend Obsidian before disk-index persistence, edit locally, advance remote state, relaunch on iPad, and capture the decision fields (`missingBaselinePolicy`, mtimes, evidence, winner, artifact).

**Closure:** User-visible local work is not silently demoted or lost; the trace matches the documented policy; limitations remain explicit if the filesystem cannot provide decisive evidence.

### QA-04 — live provider/client sequential handoff

**State:** Storage-level and live Worker components exist; full product-visible proof is missing.

**Evidence:** Server persistence tests and Issue #24 experiments prove checkpoint/journal behavior. The missing claim is one layer above storage.

**Required work:** Device A edits through the client, receives the appropriate server receipt, and disconnects. Start Device B cold with A absent. Assert B's Yjs content and ordinary Obsidian file both match A's edit. Ensure the proof does not rely on simultaneous peer presence.

**Closure:** Reproducible integration evidence passes after a server cold-load/eviction boundary and fails if durable handoff is removed.

### QA-05 — real Node-filesystem watcher proof

**State:** Adapter-write and controller tests exist; OS watcher path unproven.

**Required work:** In a real debug-enabled Obsidian instance, modify an open/bound file through `qa/controllers/obsidian-client.ts::writeNodeFileAndWait`, not the vault adapter. Exercise tab-close/reconcile deferral and preserve the trace.

**Closure:** The OS event reaches the intended controller path, no wrong-authority overwrite occurs, and disk/editor/CRDT converge.

### QA-06 — original reporter validation for the #22 family

**State:** Internal fail/pass evidence exists; no reporter confirmation is recorded.

**Closure:** Reporter validates a fixed build or the project explicitly closes the external-validation requirement with a documented decision. Internal QA must not be relabeled as reporter evidence.

### QA-07 — blank workspace live acceptance

**State:** `qa:prepare` output is hermetically byte-tested but not accepted against a supported Obsidian runtime.

**Required work:** Prepare a fresh vault, open it in Obsidian, and use CDP to verify no Markdown leaf, recent file, or vault-specific path is restored.

**Closure:** Live acceptance records Obsidian version and observed empty workspace state.

### OPS-01 — duplicate-Yjs warning re-check

**State:** The old duplicate-import cause was fixed; at least one later live run reportedly still emitted the warning.

**Required work:** Run the current CI/live entrypoints from a clean checkout and identify the module paths if the warning appears. Distinguish stale generated JS, nested dependency copies, and runner aliasing.

**Closure:** Either reproduce and remove the second import or preserve a clean run proving the current entrypoints load one Yjs copy.

### OPS-02 — strict legacy-token-disable deployment smoke

**State:** Initial ticket and reconnect paths run in local integration; migration-closed deployment behavior remains a manual gate.

**Required work:** Deploy with `YAOS_DISABLE_LEGACY_WS_TOKEN=true`; connect a ticket-aware plugin; attempt an old `?token=` socket; verify 401 before vault-room wake and Worker-level rejection logging.

**Closure:** New client connects, old client fails closed, and no per-room mutation occurs for the rejection.

### OPS-03 — Cloudflare WebSocket upgrade coverage boundary

**State:** Node/Miniflare and local Wrangler cover most pre-auth and socket behavior; Cloudflare-specific upgrade handling is not completely represented in Node tests.

**Required work:** Identify the remaining production-only branch rather than adding another broad harness. Exercise it against a deployed Worker if it affects admission or rejection guarantees.

**Closure:** The exact branch has deployed evidence or is removed/refactored into tested platform-independent logic.

## P1 path, reconciliation, and diagnostics

### PATH-01 — NFC/NFD normalization across the full pipeline

**State:** Canonicalization exists at rename admission; storage/import/reconcile do not uniformly use it.

**Evidence:** `findCanonicalPathCollisions()` is tested but has no production caller. `main.ts` can emit a collision trace but explicitly does not resolve it. Case folding is intentionally undecided.

**Required work:** Define the invariant for Obsidian display paths versus CRDT identity keys. Exercise startup scan, create/import, rename, reconcile, and persisted disk index with NFC/NFD variants. Wire collision detection at an admission boundary or delete the unused vault-wide primitive. Do not add platform-dependent case folding without a separate product decision.

**Closure:** No two CRDT identities are created for canonically equivalent paths; collision behavior is deterministic and tested on relevant filesystems; unused detection code is absent.

### REC-01 — local repair must not round-trip as remote writeback

**State:** Representative #22 evidence exists; the exact invariant lacks a focused proof.

**Required work:** Drive a local repair through CRDT, editor binding, DiskMirror suppression, and the resulting watcher event. Assert that the repair-origin write is acknowledged/suppressed and does not return as external input or produce a second semantic update.

**Closure:** Focused test fails when origin/suppression is removed and passes through the real orchestration path.

### REC-02 — full recovery-controller orchestration proof

**State:** Policy and partial controller tests exist; complete orchestration remains uncovered.

**Required work:** In one realistic path prove: disk selected as sole authority when disk/CRDT/editor diverge; `EditorBinding.repair()` selected rather than `heal()` when health requires it; `flushWriteUnlocked` performs the intended disk I/O; suppression fingerprint is installed; second reconciliation pass is a no-op.

**Closure:** One behavioral test covers the complete sequence without replacing dependencies so aggressively that the disputed transitions cannot fail.

### TRACE-01 — direct throttle-summary recursion test

**State:** `recordTrace()` has an `isThrottleSummary` recursion guard; tests do not invoke the recursion shape directly.

**Required work:** Saturate trace throttling, force summary emission, and assert the summary does not recursively create another summary or affect room availability.

**Closure:** Behavioral server test fails if the guard is removed.

### TRACE-02 — structured path-bearing diagnostics

**State:** Safe redaction handles known structured path fields and seeded free-form paths, but product logs still interpolate paths into strings.

**Required work:** Move path values used by support-facing diagnostics into recognized structured fields. Extend event types and redaction tests with each migrated path. Avoid a mechanical logging rewrite unrelated to exported/support data.

**Closure:** Safe bundles contain no raw migrated paths and no longer depend on regex discovery for those events.

### TRACE-03 — explicit safe versus local-only diagnostics contract

**State:** `buildDebugInfo()` and exports carry overlapping safe/local values; the contract depends partly on caller expectations.

**Required work:** Define separate typed payloads or builders for safe export and explicitly confirmed filename-inclusive/local inspection. Server URL, vault ID, device name, tokens, and paths must not cross the safe boundary.

**Closure:** Compile-time separation and runtime leak tests reject insertion of sensitive fields into the safe payload.

### STATUS-01 — distinguish user edits from maintenance updates

**State:** `lastLocalUpdateAt` includes user edits, disk imports, restores, repairs, and maintenance writes.

**Required work:** If UI continues to imply user activity, capture user-edit origin separately. Otherwise rename/remove the claim. Do not infer authorship solely from “local” Yjs origin.

**Closure:** Status copy and source fact have matching semantics, with origin tests for user edit versus repair/restore.

## P2 debt subject to feature-branch survival

### ARCH-01 — planner/mutation split around `reconcileVault`

**State:** `mintAdmissionOpId` callback is a controller-shaped seam in `VaultSync.reconcileVault()` so a decision can be emitted before mutation.

**Decision:** Do not refactor `main` independently if the selected sharding/integration branch removes this code. If it survives, return a seed plan without mutation; let the controller mint IDs, emit decisions, and call `ensureFile`; migrate every caller in one cutover.

**Closure:** Callback and compatibility comments are removed, every caller uses the selected ownership boundary, and decision-before-mutation tests remain.

### ARCH-02 — complete or stop TraceSink migration

**State:** Some DiskMirror, provider, recovery, and path-scoped events bypass `FlightTraceSink`.

**Decision:** Enumerate bypasses that still serve a product/support contract. Route those through mapped typed events; delete incidental tracing rather than creating an abstraction solely for completeness.

**Closure:** The documented boundary matches imports/callers; no claim of full dependency inversion while bypasses remain.

### ARCH-03 — narrow telemetry mutable handles

**State:** Telemetry host access remains broader than its read-only sync-state intent, including concrete service handles and the Obsidian `App` for file output.

**Required work:** If the current telemetry runtime survives integration, define minimal read ports for DiskMirror/BlobSync and a narrow diagnostics file-output port. Preserve mobile adapter behavior.

**Closure:** Telemetry cannot call mutation-capable members through its types; tests cover required reads/exports.

### AUTH-01 — dedicated ticket signing secret

**State:** Ticket HMAC signing derives from existing auth material rather than a dedicated random server secret.

**Decision:** Resolve in the auth/control-plane integration, not as parallel main-only work. If the old model survives, generate/store a dedicated signing secret and define existing-deployment backfill.

**Closure:** Signing authority is independent of the bearer-token verifier; migration and ticket tests pass.

### AUTH-02 — auth material in diagnostics

**State:** Current safe exports test common sensitive fields; auth hardening remains an explicit requirement.

**Required work:** Audit URL, headers, fatal frames, ticket-fetch errors, setup links, and server traces for token/ticket persistence. Add exact leak fixtures for any uncovered carrier.

**Closure:** Safe/local diagnostic policies intentionally cover each carrier; no bearer token or ticket is persisted in room traces or safe exports.

### STORAGE-01 — decide journal previous-hash chaining

**State:** Checkpoint/journal payloads have individual hashes and strict sequence validation, but no cryptographic previous-segment chain. The old limits document listed this as future work without a concrete incident.

**Decision:** Either name a failure the chain detects that current sequence/hash validation does not, then implement and test it, or close the idea and remove it from planning. Do not carry an unowned “maybe harden” item indefinitely.

### CLEAN-01 — remove `redirectPendingCreate` transition alias

**State:** `ReconciliationController.redirectPendingCreate()` is deprecated in favor of `redirectPendingDirtyPath`; QA scenario names/comments still use the old term.

**Required work:** Migrate callers and QA language, remove the alias, retain the regression proving a pending modify is not lost across rename.

### CLEAN-02 — remove false-pass receipt wait API

**State:** `waitForMemoryReceipt()` is deprecated because it polls global current state and can satisfy a later action with an earlier receipt. It remains exposed through QA ports, API types, help text, and wrappers.

**Required work:** Migrate every scenario to action-bound `waitForReceiptAfter(timestamp)` or a candidate-bound equivalent, then delete the old method through all layers.

**Closure:** No deprecated API or help entry remains; receipt waits cannot pass on pre-action state.

### CLEAN-03 — choose snapshot compatibility cutoff

**State:** Client/server still carry `structureUnchanged`, `semanticUnchanged`, `stateVectorHash`, and `computeStateVectorHash` compatibility paths. Some are read-only aliases for old clients; state vectors are known to miss deletion-only changes.

**Decision:** Establish the oldest supported plugin/server pair. Remove aliases and tests only when that support window permits, or retain them with one explicit compatibility table. The recovery-v2 branch may supersede the entire surface.

**Closure:** No ambiguous deprecated field remains without an owned compatibility requirement.

### CLEAN-04 — delete historical issue narratives from source comments

**State:** Several production files carry long Issue #40/#22 histories and links to documents being removed.

**Required work:** Keep the invariant, failure consequence, and non-obvious reason adjacent to code. Move no history elsewhere; Git already preserves it. Update the few load-bearing references to this backlog/contract.

### CLEAN-05 — documentation cutover

**State:** This file is the only backlog after the approved documentation rewrite.

**Closure:** Root README and code comments link only to retained documents; no `docs/archive`, superseded RFC, old status ledger, orphan diagram, or ignored `qa-runs` path is presented as repository-verifiable current truth; total durable docs remain within the approved 2,000–3,000-line budget.

### COST-01 — Durable Object stays resident despite hibernation

**State:** Open efficiency gap, measured on the owlgourd deployment, no correctness impact observed.

**Evidence:** `VaultSyncServer` already sets `static options = { hibernate: true }` (`server/src/server.ts`), yet Durable Object wall time runs 12 to 30 hours per day. Cloudflare GraphQL analytics for account `8f3ffbbe…`, 2026-09-19 to 2026-09-23 (deliberately excluding 09-24/25, which were heavy manual testing): 17.3 hours per day mean, projecting to roughly 520 hours and 233,000 GB-s per month, about 58% of the 400,000 GB-s included on Workers Paid. 2026-09-20 recorded 29.6 hours of wall time against only 832 Worker requests, so duration tracks connection lifetime rather than request volume. Client trace counts for 2026-09-25 show a floor of about 60 `receipt-server-echo` events per hour across every idle hour with zero edit activity, rising to 9,079 in the busiest editing hour. A wake every 60 seconds plausibly prevents hibernation from ever taking effect; the emitting timer has not been identified and may belong to the y-partyserver provider keepalive or awareness rather than to this fork. R2 and Worker request volumes are 1% or less of their allowances, so duration is the only resource near a limit. On the Workers free plan the documented daily Durable Object duration allowance is near the 13,304 GB-s recorded on 09-20, which would throttle rather than bill.

**Required work:**

1. Identify what produces the idle message floor: this fork's receipt or sv-echo path, the provider's keepalive, or awareness.
2. Establish whether the Durable Object is genuinely hibernating between messages, and for how long it stays resident after each wake.
3. Decide whether idle confirmation needs a round trip at all, and if it does, whether its interval can be lengthened or made adaptive to editing state.
4. Reduce per-update echo volume during active editing if measurement shows it exceeds what durability confirmation requires.
5. Re-measure duration per day after any change, from the same analytics query, rather than inferring from request counts.

**Closure:** Measured Durable Object wall time per day falls materially below the current 12 to 30 hour band on a comparable usage week, with unchanged durability guarantees and no regression in the receipt suites; the idle message floor is either explained as necessary or removed.

## External issue closure

| Item | External dependency |
|---|---|
| ISSUE-19 | Reporter-shaped reproduction and preferably reporter validation |
| ISSUE-23 | Excalidraw/Canvas environment and reporter validation |
| ISSUE-68 | Real idle/sleep deployment behavior and reporter validation |
| QA-01/02/03 | Real iPad/Android hardware |
| QA-06 | Original reporter response |

External dependency does not excuse reachable work: build the reproduction, fix, regression, and release candidate first; record exactly what remains external.

## Deliberately excluded

Not backlog unless a new observed problem makes them necessary:

- generic soak/stress expansion;
- Phase 4 or awareness witness relay;
- automated mobile CDP;
- configurable cursor colors;
- native Windows support;
- feature-branch deliverables named at the top of this file;
- dependency-origin re-verification before the corresponding dependency is upgraded.
