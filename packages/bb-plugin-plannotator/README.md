# bb-plugin-plannotator

This is a thin BB adapter around the official [Plannotator](https://github.com/backnotprop/plannotator) runtime. Plannotator owns the review experience; BB only launches its plan-review bridge, embeds the real app in the thread's right panel, and returns the upstream approval or feedback to the agent.

## Install

```sh
bb plugin install /Users/patrick/workingdir/bb-plugins/packages/bb-plugin-plannotator --yes
bb plugin reload plannotator
```

There is no separate Plannotator installation. On the first review, the plugin downloads the pinned official Plannotator release for the current OS/CPU, verifies its SHA-256 digest, and caches it under BB's plugin data directory. Later reviews use the cached runtime.

For development, offline use, or an independently updated upstream build, set **Plannotator binary** under BB → Extensions → Plannotator or set `PLANNOTATOR_BIN` for the BB server. Use `bundled` to restore the default.

Start a new agent session after installing or reloading. When the agent calls `plannotator_review_plan`, the upstream UI opens in the right panel. Approve or annotate there; the upstream decision is then bridged back to the waiting tool call.

## Boundary

BB does not intercept arbitrary provider text. The bundled `plan-review` skill and the `plannotator_review_plan` tool are the approval boundary, so providers must call the tool before making implementation changes.

The default runtime is pinned to the release listed in `src/bridge.ts`; upstream updates arrive through a plugin update. The upstream project is dual-licensed under Apache-2.0 or MIT, and the plugin does not copy or reimplement its UI.

The large platform binaries are intentionally provisioned on first use instead of committed to this repository. This keeps the plugin source and BB's own plugin artifacts manageable while preserving a one-plugin installation experience.
