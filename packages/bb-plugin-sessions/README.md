# bb-plugin-sessions

Observability is the single local surface for understanding, inspecting,
searching, and rehydrating coding-agent traces. It owns one SQLite index and
one incremental background scanner. Overview metrics, provider aggregates,
and trace inspection are views over the same rows, not separate pipelines.

## Canonical providers

The canonical provider families are deliberately separate:

| Provider | Store | BB provider |
|---|---|---|
| **Pi** | `~/.pi/agent/sessions/**/*.jsonl` | `pi` |
| **Prime Agent** | `~/.prime/agent/sessions/**/*.jsonl` | `acp-prime-agent` |
| **Oh My Pi** | `~/.omp/agent/sessions/**/*.jsonl` | `acp-omp` |
| **Hermes** | `~/.hermes/state.db` (`sessions` + `messages`) | `acp-hermes-agent` |
| **Codex** | `~/.codex/sessions/**/*.jsonl` + `~/.codex/archived_sessions/**/*.jsonl` | `codex` |
| **Claude Code** | `~/.claude/projects/**/*.jsonl` | `claude-code` |

Pi and Prime Agent use the same historical Pi-format JSONL, but their normal
installations use separate roots. If an explicit configuration points both at
one directory, those files do not carry reliable harness provenance; the
shared path is therefore attributed to Pi. Hermes is never attributed to Pi.

The old opencode SQLite adapter remains readable as a legacy compatibility
source. When it has indexed history, the observability views show it with a
historical/unavailable label rather than presenting it as an active harness.

## Features

- Streaming JSONL ingestion using the proven Telemetry parser. There is no
  old 24 MiB file cutoff.
- Full user/assistant conversation text stored locally in the Sessions DB and
  indexed with SQLite FTS5 Porter/Unicode tokenization and BM25 ranking.
  Tool calls, usage, errors, context, compactions, and costs are projected as
  structured telemetry from the same scan.
- An Overview view with range filters, source health, totals, findings, and
  recent activity.
- A Provider aggregates view with reliability, tool-error, usage, and cost
  comparisons across harnesses.
- A Traces view with full-text search, provider filters, and a trace inspector
  that lets users select user, assistant, and tool entries individually.
- The SQLite store keeps the full searchable transcript plus a bounded
  `trace_json` event projection keyed to each session. The inspector reads
  that canonical projection; old redundant trace-table data is ignored.
- Agent-facing `sessions_search`, `sessions_get`, and `sessions_telemetry`
  tools so provider-backed agents can search the local corpus themselves.
  `sessions_get` returns event-level tool evidence only when `includeTrace` is
  requested.
- A 60-second incremental background scan. Unchanged JSONL files are skipped
  by path/size/mtime fingerprints; the search index is updated transactionally.
- CodexBar Claude probe sessions are ignored by default. Their source files
  remain on disk, but synthetic probe conversations do not pollute Sessions.

## Install

```sh
bb plugin install /Users/patrick/workingdir/bb-plugins/packages/bb-plugin-sessions --yes
bb plugin reload sessions
```

The sidebar entry is **Observability** (icon: History). Overview, Providers,
and Traces are views inside that panel.

## CLI

```sh
bb sessions status
bb sessions reindex [--full] [pi|prime|omp|hermes|codex|claude]
bb sessions search "neon pilot" [--provider codex] [--limit 20]
bb sessions get <session-id>
bb sessions rehydrate <session-id> [--project <id>] [--provider <id>] [--condensed|--full]
bb sessions telemetry [--range 24h|7d|30d|lifetime] [--provider <id>]
```

Session ids are provider-qualified (`codex:<id>`, `claude:<id>`,
`pi:<id>`, `hermes:<id>`). Use `--json` on the read commands for structured
output.

## Settings

`bb plugin config sessions set <key> <value>`:

- `<provider>Enabled` toggles `pi`, `prime`, `omp`, `hermes`, `codex`,
  `claude`, or the legacy `opencode` source.
- `<provider>Path` overrides a provider store path.
- `hermesPath` overrides Hermes' SQLite database path.

Transcripts are stored in full for local search. UI previews, trace projections,
agent responses, and rehydration prompts are bounded separately so a single
enormous conversation cannot make a BB response unusable.
