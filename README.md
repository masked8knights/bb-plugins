# BB plugins

Plugins for [bb](https://github.com/patleeman/bb).

## Packages

- [`bb-plugin-telemetry`](packages/bb-plugin-telemetry/) — compare
  Codex, Claude Code, Pi, opencode, and omp sessions with native bb thread
  telemetry and evidence-backed findings.
- [`bb-plugin-grove`](packages/bb-plugin-grove/) — bind Markdown documents to
  visible owner agents, queue dictation, and shape it with SHA-protected edits.
- [`bb-plugin-agent-checklists`](packages/bb-plugin-agent-checklists/) — attach
  persisted structured checklists to threads, update them with agent tools,
  and continue incomplete work automatically.
- [`bb-plugin-plannotator`](packages/bb-plugin-plannotator/) — embed the upstream
  Plannotator plan-review app in BB's right panel and bridge its decisions back
  to agents.
- [`bb-plugin-cobalt2`](packages/bb-plugin-cobalt2/) — contribute the Cobalt2
  color palette to bb.
- [`bb-plugin-auto-new-tab`](packages/bb-plugin-auto-new-tab/) — open the
  New Tab page automatically when the workspace panel has no tabs, instead
  of the default Info page.
- [`bb-plugin-ds4`](packages/bb-plugin-ds4/) — run and administer a local
  DwarfStar (`ds4`) inference server from bb.
- [`bb-plugin-excalidraw`](packages/bb-plugin-excalidraw/) — create, edit, and
  attach Excalidraw drawings in conversations.
- [`bb-plugin-omp`](packages/bb-plugin-omp/) — register Oh My Pi (`omp`) as an
  ACP-based bb provider (`acp-omp`).
- [`bb-plugin-prime-agent`](packages/bb-plugin-prime-agent/) — register
  Prime Agent as an ACP-based bb provider (`acp-prime-agent`).
- [`bb-plugin-sessions`](packages/bb-plugin-sessions/) — index Codex, Claude
  Code, and Pi (prime-agent) sessions on this machine, search them from a
  sidebar panel, and rehydrate any session into a BB thread.
- [`bb-plugin-toolbox`](packages/bb-plugin-toolbox/) — manage MCP servers and
  declared CLI operations through one provider-neutral agent bridge and
  aggregated MCP endpoint.
- [`bb-plugin-emoji-react`](packages/bb-plugin-emoji-react/) — emoji reactions
  in the assistant-message text-selection menu; the reaction list is
  configurable in plugin settings.

## Development

This is a pnpm workspace. Build or typecheck all packages with:

```sh
pnpm install
pnpm typecheck
pnpm build
```

Each package README documents its installation and runtime requirements.

## Installing every plugin

Install all packages as bb plugins (idempotent — safe to re-run):

```sh
pnpm plugins:install      # or: bash scripts/install-all.sh
```

This runs `bb plugin install <path> --yes` for every `packages/bb-plugin-*`
and prints the resulting installed list. To install just one, use its path:

```sh
bb plugin install ./packages/bb-plugin-prime-agent
```
