# bb-plugin-plannotator

This is a thin BB adapter around the official [Plannotator](https://github.com/backnotprop/plannotator) binary. Plannotator owns the review experience; BB only launches its plan-review bridge, embeds the real app in the thread's right panel, and returns the upstream approval or feedback to the agent.

## Install

Install the upstream standalone binary first using its official installer:

```sh
curl -fsSL https://plannotator.ai/install.sh | bash -s -- --minimal
```

Then install this BB plugin:

```sh
bb plugin install /Users/patrick/workingdir/bb-plugins/packages/bb-plugin-plannotator --yes
bb plugin reload plannotator
```

The adapter searches `PATH` and `~/.local/bin/plannotator`. If the binary is elsewhere, set **Plannotator binary** under BB → Extensions → Plannotator, or set `PLANNOTATOR_BIN` for the BB server.

Start a new agent session after installing or reloading. When the agent calls `plannotator_review_plan`, the upstream UI opens in the right panel. Approve or annotate there; the upstream decision is then bridged back to the waiting tool call.

## Boundary

BB does not intercept arbitrary provider text. The bundled `plan-review` skill and the `plannotator_review_plan` tool are the approval boundary, so providers must call the tool before making implementation changes.

The upstream binary can also be used on its own. Updating it is independent of the BB adapter, so upstream UI and workflow improvements arrive without copying the interface into BB.
