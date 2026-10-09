# Headless inbox peer

A vault device with no Obsidian. It joins the vault's Durable Object room the
same way the plugin does, watches `inbox/` for request notes, runs the named
llm-orc ensemble, and writes the answer to `results/<name>.md`.

## Contract

The peer only creates notes. It never edits or deletes an existing one. A
request is done when `results/<name>.md` exists, so deleting the result is how
you ask for a rerun.

A request is a note under `inbox/` whose frontmatter has `agent: <ensemble>`:

```markdown
---
agent: vault-gardener
---
Summarize what changed this week.
```

The body (trimmed) is sent as `{"input": ...}` to
`POST ${LLM_ORC_URL}/api/ensembles/<ensemble>/execute`.

Rules the loop follows:

- A note with `runner: <name>` is only taken by the peer whose `OG_DEVICE` is
  `<name>`. Without `runner:` any peer takes it.
- Notes tagged `agent`, and anything under `results/`, are never requests.
  Result notes carry that tag, so results cannot feed the loop.
- A failed run (llm-orc error, timeout, invalid frontmatter) produces a result
  note with `status: error`. It is not retried.
- A request already in flight is not started twice, including after a
  reconnect.
- SIGTERM or SIGINT waits up to 10 s for in-flight results before
  disconnecting.

## Result notes

Frontmatter is dumped from an object with js-yaml, never written by hand. The
plugin's frontmatter guard quarantines a note whose YAML does not parse, and
an early hand-built result (`tags:` followed by `- agent` on the next line,
with bad indentation) was quarantined on the laptop. The tests pin that the
result frontmatter round-trips through `yaml.load`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `OG_HOST` | required | Worker host, from the plugin's `data.json` |
| `OG_VAULT_ID` | required | Vault id, from `data.json` |
| `OG_TOKEN` | required | Sync token, from `data.json` |
| `OG_DEVICE` | `headless-inbox` | Device name in file metadata and `runner:` matching |
| `LLM_ORC_URL` | `http://127.0.0.1:8765` | llm-orc serve |
| `INBOX_DIR` | `inbox` | Request folder |
| `RESULTS_DIR` | `results` | Result folder |
| `RUN_TIMEOUT_MS` | `1800000` | Per-request timeout |
| `GARDEN_HOUR` | unset | Local hour (0-23) for the nightly request |
| `GARDEN_ENSEMBLE` | `vault-gardener` | Ensemble the nightly request names |

### Nightly gardener

With `GARDEN_HOUR` set, the peer writes `inbox/garden-<YYYY-MM-DD>.md` once a
day at that hour. The body lists every live markdown note edited in the last
24 h (path, then the first 1500 characters), separated by `---` lines, and
skips `inbox/`, `results/` and agent-tagged notes. If that day's note exists
or nothing changed, it writes nothing. The normal loop then runs it like any
request.

## Run

Needs Node 22 and no build step. The directory is self-contained, so it can be
copied to another machine.

```sh
cd headless
npm install
OG_HOST=... OG_VAULT_ID=... OG_TOKEN=... OG_DEVICE=mini node inbox.mjs
```

## Layout

- `inbox.mjs`: env, provider, signals. The wiring.
- `lib/`: the testable parts (`frontmatter`, `paths`, `resultNote`, `vault`,
  `llmOrc`, `inbox`, `gardener`, `shutdown`). None of them open a socket.
- `probe.mjs`, `create-probe.mjs`: protocol probes, not part of the peer.
  `probe.mjs` joins the room and prints the file list. `create-probe.mjs`
  creates one markdown file the way `VaultSync.ensureFile` does. They document
  how a non-Obsidian client talks to the room. Run them only on purpose: the
  second one writes to the vault.

## Tests

`tests/client/headless-inbox.ts` runs in the regular suite
(`npm run test:regressions`) on in-memory Y.Docs with stubbed runs. It needs
no socket and no token.
