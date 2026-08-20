# Agent Plugins for BB

Install [Agent Plugins](https://agent-plugins.org) once in BB and use them everywhere — skills become `/skill` commands and MCP tools flow to Codex, Claude, and Pi via a static bridge.

Supports local paths, Git, and npm. Server-host only v0.

## Install

```sh
# from the bb-plugins workspace
pnpm install
bb plugin build packages/bb-plugin-agent-plugins
bb plugin install ./packages/bb-plugin-agent-plugins --yes
```

Or install directly from git:

```sh
bb plugin install git:https://github.com/patleeman/bb-plugins.git --subdirectory packages/bb-plugin-agent-plugins --yes
```

## Use

- **UI:** Open **Agent Plugins** in the sidebar → paste a location (`/abs/path`, `https://github.com/acme/my-plugin`, `npm:my-plugin@^1.0`) or **Browse…** for a local folder → **Install**. Skills appear next session; MCP servers need **Approve & start**.
- **CLI:** `bb agent-plugins list --json` · `bb agent-plugins show <id> --json` · `bb agent-plugins tools --json` · `bb agent-plugins call <opaqueId> '{"text":"hello"}'`

Updates keep `pluginData` — reinstall the same location and the plugin swaps atomically.

## Spec

Implements Agent Plugins 1.0.0 + 1.1.0 draft (tolerant closed `plugin.json`, per-server `mcp.json` isolation, `skills/` discovery, `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` single-pass, `cwd` containment, header/CRLF checks). Vendored schemas in `schemas/`.

## Development

```sh
pnpm --filter bb-plugin-agent-plugins typecheck
pnpm --filter bb-plugin-agent-plugins test
bb plugin build packages/bb-plugin-agent-plugins
```
