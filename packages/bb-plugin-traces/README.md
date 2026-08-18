# Traces

Traces is a local-only session and trajectory explorer for BB. It replaces the
hosted-dashboard wrapper with a durable SQLite index over the session files already
written by the local agent harnesses.

## What it detects

By default the indexer checks:

- Codex rollout JSONL and archived rollout JSONL under `~/.codex`.
- Claude project JSONL under `~/.claude/projects`.
- Pi session JSONL under `~/.pi/agent/sessions`.
- OMP session JSONL under `~/.omp/agent/sessions`.
- DeepSeek Harness compressed JSONL under `~/.dsh/sessions`.
- BB thread storage and personal workspaces for decision, plan, checkpoint,
  handoff, review, state, and agent artifacts.

Additional JSONL roots and workspace roots can be added in plugin settings, one
absolute path per line.

The scanner is append-aware for JSONL and periodically refreshes while BB is
running. Original files are never rewritten, uploaded, or forwarded. The
plugin database contains normalized metadata, searchable summaries, and bounded
payload previews; the source files remain the complete record.

## UI model

The explorer borrows the useful interaction model from DeepSeek Harness's
open-source trajectory UI: a source-filterable session ledger, timing overview,
nested tool rows, live-index state, and a payload inspector. The Decisions tab
keeps planning and checkpoint artifacts beside sessions without mixing them into
the trace timeline.

Reference: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/client/ui-trajectory
