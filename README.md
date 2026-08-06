# BB plugins

Plugins for [bb](https://github.com/patleeman/bb).

## Packages

- [`bb-plugin-ds4`](packages/bb-plugin-ds4/) — run and administer a local
  DwarfStar (`ds4`) inference server from bb.
- [`bb-plugin-excalidraw`](packages/bb-plugin-excalidraw/) — create, edit, and
  attach Excalidraw drawings in conversations.
- [`bb-plugin-prime-agent`](packages/bb-plugin-prime-agent/) — register
  Prime Agent as an ACP-based bb provider (`acp-prime-agent`).

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
