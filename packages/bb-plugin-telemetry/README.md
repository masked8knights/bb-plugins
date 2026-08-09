# bb-plugin-telemetry

Telemetry compares provider sessions with native bb thread telemetry.
The default view keeps Codex, Claude Code, Pi, opencode, and omp separate.

## What it indexes

- Codex, Claude Code, Pi / Prime Agent, opencode, and omp stores.
- Native bb threads and their event streams.
- Turns, tools, token snapshots, context signals, failures, and evidence
  references when the source provides them.

Provider stores remain the canonical session source. bb data enriches a
provider session only when a conservative link exists. Unified counts exclude
accepted links from the bb-only side, so one logical session is not counted
twice.

Telemetry stores redacted metrics only. It does not retain prompts, assistant
messages, command text, tool arguments or results, file contents, or raw
provider payloads. Cost remains unavailable until a verified price table is
configured.

## Install

```sh
# Run from the repository root.
bb plugin install ./packages/bb-plugin-telemetry --yes
bb plugin reload telemetry
```

The sidebar entry is **Telemetry**. Native thread panels expose
**Analyze thread**.

## CLI

```sh
bb telemetry status
bb telemetry providers --json
bb telemetry reindex [--full] [--provider codex] [--machine <hostId>]
bb telemetry summary --view provider --range 7d
bb telemetry findings --severity warning
bb telemetry session <source-record-id>
bb telemetry thread <thread-id>
```

## Source settings

Use `bb plugin config telemetry set <key> <value>` to change settings.
Each provider has an enable toggle, a source path, and an optional host id.
Leave the host id empty to use the primary host.

CodexBar sessions are excluded by default. The `excludeCodexBar` setting
matches CodexBar in a provider file path or parsed working directory.

Codex scans both `~/.codex/sessions` and `~/.codex/archived_sessions`. Sessions
found under the archive path are marked archived and respond to the dashboard's
Include archived filter.

JSONL stores use bb's host-aware file API. SQLite provider stores are read
locally in the first release. Remote SQLite sources fail closed with a visible
unsupported status.
