# Traces

Traces is a local-only session and trajectory explorer for BB. It builds a
durable SQLite index over session files already written by local agent
harnesses.

## Sources

The default roots cover:

- Codex rollout and archived rollout JSONL under `~/.codex`.
- Claude project JSONL under `~/.claude/projects`.
- Pi sessions under `~/.pi/agent/sessions`.
- OMP sessions under `~/.omp/agent/sessions`.
- DeepSeek Harness compressed JSONL under `~/.dsh/sessions`.

Open Settings → Extensions → Traces to see every built-in session directory and
its scan state. The Session directories section also lets you add or remove
custom roots; the same paths remain available in the host-rendered setting as
one absolute path per line.

## Indexing

The indexer keeps complete session files durable and parses only new JSONL
lines when the existing file prefix is unchanged. It stores a SHA-256 content
fingerprint for completed files, checks filesystem changes with a debounced
watcher, and runs a slower metadata sweep for changes the watcher cannot report.
Unstable reads are rejected and retried so a live session cannot leave stale
events in the index. Discovery is bounded at 50,000 session files and 32
directory levels as a safety guard for accidental broad custom roots; when a
root reaches the guard, cached rows are preserved and the root reports the
limit instead of silently deleting data.

Original session files are never rewritten, uploaded, or forwarded. The local
database contains normalized metadata, searchable summaries, and bounded event
payloads; the source files remain the complete record.

## UI model

The explorer borrows the useful interaction model from DeepSeek Harness's
open-source trajectory UI: a source-filterable session ledger, compact rows,
timing overview, nested tool rows, live index state, and a payload inspector.
The collection is focused on model, message, and tool telemetry. Opening a
session takes you to its full trajectory view.

Reference: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/client/ui-trajectory
