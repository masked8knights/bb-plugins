# bb-plugin-ds4 — DwarfStar

Configure a local **DwarfStar** (`antirez/ds4`, a.k.a. ds4.c) inference
server for BB. Once the setup is complete, choose its model in BB's model
picker: the plugin starts `ds4-server` for matching turns and stops it after
the configured idle grace period.

Requires a DS4 checkout with a built `ds4-server` binary and a downloaded
model (see the [ds4 README](https://github.com/antirez/ds4#readme)):

```sh
git clone https://github.com/antirez/ds4 ~/workingdir/ds4
cd ~/workingdir/ds4 && make
./download_model.sh ds4f-q2      # or another target for your hardware
./download_model.sh dspark-support
```

## Install

```sh
cd bb-plugin-ds4
bb plugin install .
bb plugin build      # optional: precompile the frontend
```

## What you get

- **DwarfStar setup** (Settings → Plugins → DwarfStar): checkout/model paths,
  BB model selector, optional provider filter, idle grace period, runtime
  tuning, and optional external-agent configuration.
- **Demand-driven supervision**: the local server starts when BB resolves a
  matching model for a turn, stays warm while matching turns are active, and
  stops after the last one is idle. It stops as part of plugin reload/disable
  and BB shutdown as well.
- **Lifecycle feedback**: BB shows a host toast for lifecycle transitions and
  a host-framed status banner above the composer while DwarfStar is starting,
  stopping, or unavailable. It also confirms when the server becomes ready.
  Startup feedback is especially useful because loading a large GGUF can take
  several seconds.
- **`bb ds4` diagnostics** (kept for troubleshooting):
  - `bb ds4 status` — state, pid, uptime, health, served models
  - `bb ds4 start | stop | restart`
  - `bb ds4 logs [-n N]` — recent process output (also persisted to
    `~/.bb/plugins/ds4/process.log`, rotated at 50 MB)
  - `bb ds4 agents [status|apply [pi|opencode|codex …]]`
  - `bb ds4 agent` — launch the interactive `ds4-agent` TUI in a BB terminal
  - `bb ds4 complete <prompt>` — one-shot completion against the local server
- **Agent tools** (available to every BB agent): `ds4_status` and
  `ds4_complete` — BB agents can check the server and run prompts on the local
  DeepSeek V4 Flash model directly.
- **Agent connections**: write/merge provider configs so external agents can
  reach the server:
  - Pi/BB → `~/.pi/agent/models.json` (provider `ds4`, model
    `deepseek-v4-flash`)
  - opencode → `~/.config/opencode/opencode.json` (provider `ds4`, agent
    `ds4`)
  - Codex CLI → `~/.codex/config.toml` (`[model_providers.ds4]`, Responses
    wire API)
  Existing files are merged (never clobbered) and a timestamped
  `.ds4bak-<ts>` copy is kept before each write.

## Supervision behavior

A background `supervisor` service:

- starts the server when BB resolves a selected model matching
  **`modelSelector`** for a turn,
- restarts after a crash while a matching turn still needs it when
  **`restartOnCrash`** is on (exponential backoff
  2 s → 30 s, reset after a healthy run),
- restarts automatically when settings that affect the command line change
  (port, ctx, model, backend, …), so you never need a manual stop/start,
- polls `/v1/models` every 2 s and flips the status to **ready** (green) once
  the HTTP API answers, showing "loading model…" while a big GGUF is still
  being read,
- stops after `idleTimeoutSeconds` with no active matching turn,
- stops the server cleanly (SIGTERM → SIGKILL after 12 s) on plugin
  reload/disable and BB shutdown.

The first matching turn starts the process asynchronously; subsequent turns
reuse it while it is warm. BB surfaces the brief model-loading window with a
toast and composer banner so it is clear that the local server is working. The
local provider/client should tolerate the brief model-loading window just like
any other local model server.

## Settings (`bb plugin config ds4`)

| Key | Default | Meaning |
| --- | --- | --- |
| `ds4Dir` | `""` | DS4 checkout dir. Empty = auto-detect (`DS4_DIR`, `~/workingdir/ds4`, `~/ds4`, …) |
| `modelPath` | `""` | GGUF path; absolute or relative to `ds4Dir`. Empty = `ds4flash.gguf` |
| `modelSelector` | `ds4/` | Exact model id or namespace from BB's model picker; matches `ds4/deepseek-v4-flash` by default |
| `providerId` | `""` | Optional exact BB provider id filter; empty matches the model across providers |
| `idleTimeoutSeconds` | `300` | How long to keep the server warm after the last matching turn |
| `backend` | `auto` | `metal` \| `cuda` \| `cpu` |
| `host` | `127.0.0.1` | Bind address |
| `port` | `8000` | Bind port |
| `ctx` | `100000` | Context tokens (`-c`) |
| `kvDiskDir` | `/tmp/ds4-kv` | Disk KV cache dir; empty disables it |
| `kvDiskSpaceMb` | `8192` | KV cache disk budget |
| `power` | `""` | GPU duty cycle (`--power 1..100`) |
| `extraArgs` | `""` | Extra flags appended to the command line |
| `dspark` | `true` | Enable DSpark speculative decoding; requires the support GGUF |
| `dsparkSupportPath` | `""` | Absolute or DS4-relative support GGUF path; empty auto-detects `gguf/DeepSeek-V4-Flash-DSpark-support.gguf` |
| `dsparkConfidence` | `0.9` | DSpark confidence pruning threshold (`0..1`) |
| `restartOnCrash` | `true` | Restart after a crash (backoff) |
| `configurePi` / `configureOpencode` / `configureCodex` | `true`/`false`/`false` | Which agent configs `bb ds4 agents apply` writes by default |

## Notes

- The plugin manages **`ds4-server`** (the OpenAI/Anthropic/Responses HTTP
  server). The interactive **`ds4-agent`** TUI is launched into a BB terminal
  (`bb ds4 agent`) where you drive it directly — sessions save under
  `~/.ds4/kvcache` via `/save`.
- DSpark is enabled by default for both `ds4-server` and `ds4-agent`, using
  `--mtp <support.gguf> --dspark`. Download the support model with
  `./download_model.sh dspark-support`; the plugin refuses to start while the
  configured support file is missing so it cannot silently fall back to a
  non-DSpark run. Set `dspark=false` for an explicit baseline or unsupported
  model.
- The plugin runs on the machine that runs the BB server (full-trust plugin
  code); it spawns the process locally and writes agent configs on the same
  host.
- Start is refused with an actionable error when the model file is missing
  (e.g. while `download_model.sh` is still running).
