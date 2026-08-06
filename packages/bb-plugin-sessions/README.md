# bb-plugin-sessions

Search the coding-agent sessions already stored on this machine from a BB
sidebar panel, and rehydrate any of them into a BB thread so you can keep
working in BB.

## Auto-discovery, not hard-coded providers

The provider set is **discovered**, not hard-coded. Each registered source
knows where its session store may live on disk; at status/index time the
plugin probes those locations and only indexes the providers actually present
on the machine. It also cross-checks BB's own provider registry so a source is
only offered for rehydration when BB can actually run it.

Currently registered sources:

| Source | Store | Format |
|---|---|---|
| **Codex** | `~/.codex/sessions/**/*.jsonl` | rollout event streams |
| **Claude Code** | `~/.claude/projects/**/*.jsonl` | per-project session JSONL |
| **Pi / prime-agent** | `~/.prime/agent/sessions/**/*.jsonl` **and** `~/.hermes/state.db` | JSONL + SQLite |
| **opencode** | `~/.local/share/opencode/opencode.db` | SQLite (session/message/part) |
| **omp** | `~/.omp/agent/sessions/<cwd>/*.jsonl` | event streams |

To add a provider, register a source in `src/sources.ts` (store locations,
parser dispatch, BB provider mapping) — it is then auto-discovered, indexed,
searchable, and rehydratable.

## What it does

- **Indexes** discovered provider session stores into the plugin's SQLite
  database (with FTS5 full-text search).
- **Main page = recent feed**: opening the panel shows the latest ~30
  sessions across *all* discovered providers, newest first. Type to run a
  full-text search over titles, transcripts, and working directories (with
  a match count); provider filters are built from discovery, and a ✕ clears
  the search back to the recent feed.
- **Rehydrates**: creates a new BB thread whose first message contains the
  full (or condensed) conversation transcript plus session metadata, spawned
  in the project that matches the session's `cwd` (or the project you pick),
  at the original working directory when it still exists. You can choose the
  BB provider (defaults to the source's provider mapping, e.g. Codex →
  `codex`, Claude → `claude-code`, Pi → `pi`, opencode → `acp-opencode`,
  omp → `acp-omp`).

A background service keeps the index fresh (incremental — only new/changed
files are re-parsed) and publishes progress over realtime.

## Install

```sh
bb plugin install /Users/patrick/workingdir/bb-plugins/packages/bb-plugin-sessions --yes
bb plugin reload sessions   # if it was already installed
```

The panel appears in the sidebar as **Session Search** (icon: History).

## CLI

```sh
bb sessions status
bb sessions reindex [--full] [codex|claude|prime|opencode|omp]
bb sessions search "neon pilot" [--provider codex] [--limit 20]
bb sessions get <session-id>
bb sessions rehydrate <session-id> [--project <id>] [--provider <id>] [--condensed|--full]
```

Session ids are provider-qualified (`codex:<id>`, `claude:<id>`, `prime:<id>`);
`bb sessions search --json` prints them.

## Settings

`bb plugin config sessions set <key> <value>`:

- `codexEnabled` / `claudeEnabled` / `primeEnabled` — enable each source
- `codexPath`, `claudePath`, `primePath` — custom session directories
- `primeDbPath` — hermes `state.db` path (empty disables it)

## Notes

- Rehydration uses `bb.sdk.threads.spawn`: BB has no history-injection API,
  so the transcript becomes the new thread's first prompt. The thread opens
  in the project matched from the session's `cwd` (deepest matching project
  source), using an unmanaged workspace at that `cwd` when it still exists,
  falling back to the project's default environment.
- Transcripts are capped at ~300 KB for storage; the rehydrate prompt is
  capped at ~120 KB (full mode) so large sessions stay inside context.
