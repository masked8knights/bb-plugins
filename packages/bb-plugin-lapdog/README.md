# Lapdog

This plugin runs the official local Lapdog agent and opens Datadog's official
Lapdog interface inside BB. It intentionally does not reimplement the
dashboard or maintain a second trace store.

## Install

Install the official Lapdog CLI first:

```sh
pipx install ddapm-test-agent
```

Then install the BB plugin from the repository root:

```sh
bb plugin install ./packages/bb-plugin-lapdog --yes
bb plugin reload lapdog
```

The plugin starts `lapdog start` automatically by default. It uses the
standard local ports: APM `8126`, OTLP HTTP `4318`, and OTLP gRPC `4317`.

It also starts Datadog's official `lapdog.codex_watcher` alongside the agent.
That watcher tails BB's local `~/.codex/sessions/**/*.jsonl` files and posts
the records to the local agent's `/codex/hooks` endpoint. It includes sessions
from every workspace, keeps a durable cursor at
`~/.lapdog/bb-codex-cursor.json`, and replays the last hour by default so a
recent test thread appears after startup. No session data is sent to Datadog
unless forwarding is explicitly enabled.

The **Forward LLM Observability data to Datadog** setting is off by default.
When enabled, the plugin starts the official CLI with `--forward` and inherits
`DD_API_KEY` and `DD_SITE` from the BB server environment. Restart Lapdog after
changing this setting.

The **Capture BB Codex sessions locally** setting controls this watcher. Set
**Replay recent Codex sessions (seconds)** higher if an older test thread needs
to be imported; `0` only captures new records. This integration covers BB's
Codex provider directly. Claude and Pi need their official Lapdog launchers or
their corresponding hook integrations because they write different session
formats.

The panel embeds <https://lapdog.datadoghq.com> and also provides a direct
new-tab link. The hosted dashboard intentionally uses its light theme when it
is embedded in an iframe; use the new-tab link when the dark theme is needed.
For non-default APM ports it passes Lapdog's `portOverride` parameter to the
official dashboard.
