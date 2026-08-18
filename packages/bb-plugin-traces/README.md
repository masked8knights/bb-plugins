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
- BB thread storage for decision, plan, checkpoint, handoff, review, state, and
  agent artifacts. Additional workspace roots are opt-in so a large personal
  workspace tree cannot hold session indexing hostage.

Additional JSONL roots and workspace roots can be added in plugin settings, one
absolute path per line.

The scanner is append-aware for JSONL and keeps normalized sessions in a durable
SQLite database. Completed files are skipped from the parser; a metadata-only
touch is checked with a persisted SHA-256 fingerprint, and filesystem changes
trigger a debounced refresh. A slower safety sweep hashes fingerprinted files
without reparsing them, catching changes that the platform watcher cannot
report. Files from an older index without a fingerprint are parsed once to
establish a trustworthy baseline. Original files are never rewritten, uploaded,
or forwarded. The plugin database contains normalized metadata, searchable
summaries, and bounded payload previews; the source files remain the complete
record.

## UI model

The explorer borrows the useful interaction model from DeepSeek Harness's
open-source trajectory UI: a source-filterable session ledger, compact single-line
rows, timing overview, nested tool rows, live-index state, and a payload inspector.
The collection is intentionally focused on model, message, and tool telemetry;
opening a session takes you to its full trajectory view.

Reference: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/client/ui-trajectory
