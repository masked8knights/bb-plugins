# bb-plugin-telemetry

Telemetry compares provider sessions with native bb thread telemetry.
The default view keeps Codex, Claude Code, Pi, Prime Agent, opencode, and omp
separate.

## What it indexes

- Codex, Claude Code, Pi, Prime Agent, opencode, and omp stores.
- Native bb threads and their event streams.
- Turns, tools, token snapshots, context signals, failures, and evidence
  references when the source provides them.

Provider stores remain the canonical session source. bb data enriches a
provider session only when a conservative link exists. Unified counts exclude
accepted links from the bb-only side, so one logical session is not counted
twice.

Telemetry stores redacted metrics only. It does not retain prompts, assistant
messages, command text, tool arguments or results, file contents, or raw
provider payloads. Costs are estimated from token counts at read time (never
stored) using the built-in model price table; see **Cost estimation** below.

## Cost estimation

Session and turn costs are derived from indexed token counts using USD list
prices per 1M tokens. Price-table estimates are computed on read and are
never stored; provider-reported costs (see below) are stored verbatim like
token counts.

- Prices are sourced from [models.dev](https://models.dev) (`api.json`),
  fetched by the background indexer and cached in the plugin database for a
  week. While offline or before the first fetch, a bundled snapshot of the
  most common models is used. When several providers list the same model,
  the home provider (openai, anthropic, google, deepseek, xai) wins, then
  dedicated-SDK providers, then the majority price among resellers.
- Sessions whose model resolves in the active table are priced exactly.
  Sessions with an unknown or missing model use a mid-range per-provider
  fallback price and are marked **estimated** (an `*` in the UI).
- When the harness reports its own billing (Pi/omp per-message `usage.cost`,
  hermes `actual/estimated_cost_usd`, opencode per-message `cost`), that
  provider-reported figure is used directly instead of the price table and is
  never marked estimated.
- Cached input is billed at the cache rate (`cache_read`; falls back to the
  input rate when a provider does not report one). Because providers disagree
  about whether the input count includes cached tokens, the estimator treats
  the counts as inclusive when input ≥ cached and as additive otherwise.
- Reasoning tokens are billed at the output rate.

The dashboard shows an **Estimated cost** metric and per-harness costs; the
session view shows total and per-turn costs.

```sh
bb telemetry prices                     # source, fallbacks, and model count
bb telemetry prices --refresh           # re-fetch from models.dev now
bb telemetry prices --model gpt-5       # look up one model
bb telemetry prices --json              # full effective table
```

To correct list-price drift or add models, set verified prices (USD per 1M
tokens) with the `priceTable` setting — a JSON object keyed by provider, then
model id. Overrides win over models.dev entries:

```sh
bb plugin config telemetry set priceTable '{"codex": {"gpt-5": {"inputPerM": 1.25, "cachedInputPerM": 0.125, "outputPerM": 10}}}'
```

Overrides are matched case-insensitively after stripping `-latest` and dated
suffixes (`-20250929`), and apply to dashboards, session detail, and CLI
output immediately — no reindex needed.

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
bb telemetry reindex [--full] [--clear] [--provider codex] [--machine <hostId>]
bb telemetry summary --view provider --range 7d
bb telemetry prices
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

## Pi and Prime Agent

Pi and Prime Agent are separate telemetry sources. Pi (`pi`) covers the `pi`
and `acp-hermes-agent` bb providers and owns the `~/.prime/agent/sessions`
JSONL store plus the hermes daemon database `~/.hermes/state.db`. Prime Agent
(`prime`) covers the `acp-prime-agent` bb provider and defaults to the same
JSONL directory, because Prime Agent writes sessions there too. Identical
session files are indexed only once — Prime Agent yields to Pi, which owns the
shared store. If you keep Prime Agent sessions in a dedicated directory, point
the `primePath` setting at it to keep the two fully separate.

No migration machinery is kept in the plugin. If you upgrade from an older
release and want a clean slate, use the **Clear &amp; rescan** button in the
dashboard header (or `bb telemetry reindex --clear`): it wipes all indexed
sessions, sources, links, and findings, then reindexes every provider store
and bb thread from scratch.
