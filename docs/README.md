# YAOS documentation

Current `main` has six durable engineering documents. Git history and the separate engineering library preserve replaced RFCs, audits, incident reports, and implementation notes.

- [Architecture](architecture.md) — current structure plus rationale for runtime, storage, startup, and attachment choices.
- [Sync and conflict contract](sync-contract.md) — current behavior, preservation policy, and receipt semantics.
- [Operations](operations.md) — deployment, update, authentication, compatibility, and release decisions.
- [QA](qa.md) — supported gates, current evidence, and manual real-device procedures.
- [Troubleshooting](troubleshooting.md) — how to find out what the plugin did: the five-minute sweep, where logs live, how to read a phone's trace, and the environment rules that caused real incidents.
- [Backlog](BACKLOG.md) — the canonical list of pre-feature bugs, validation gaps, and cleanup debt.

The repository-root [README](../README.md) is the public product guide. Generated evidence belongs under ignored `qa-runs/`; workstation notes belong under ignored `notes/`.
