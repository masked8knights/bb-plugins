# bb-plugin-omp

Registers [Oh My Pi](https://github.com/patleeman/omp) (`omp`) as an ACP-based
provider in bb (`acp-omp`).

## Install

```bash
bb plugin install ./packages/bb-plugin-omp
bb omp setup
```

`setup` is idempotent: it rewrites the shim/logo, reconciles the
`customAcpAgents` entry, and reloads the running server config. Run it again
any time to repair or refresh the integration.

## Distribution

Path installs are the supported route (same as the other packages in this
repo). bb's `git:` source requires the plugin manifest at the repo root, so
monorepo packages cannot be installed via `git:<url>`; if managed installs
are ever needed, publish the package to npm and install with
`bb plugin install npm:bb-plugin-omp` (ship `dist/` in the npm tarball, not in
git).

## What it does

bb's plugin SDK has no provider-registration API (`bb.sdk.providers` is
read-only), so this plugin provisions the supported data-dir mechanism:

1. Writes the ACP shim to `<dataDir>/bin/omp-acp.sh`
2. Writes the provider logo to `<dataDir>/logos/oh-my-pi.svg`
3. Merges a `customAcpAgents` entry into `<dataDir>/config.json`
   (never clobbers other entries or config keys)
4. POSTs `/api/v1/system/config/reload` to apply it to the running server

## Why the shim is needed

Unlike prime-agent, omp needs almost no adaptation:

- `omp acp` is a native ACP server over stdio, so launch args pass straight
  through the shim (`exec omp "$@"`).
- `omp --model <provider>/<model>` resolves the provider-qualified selector
  natively (no `--provider` translation required), so model ids from the
  picker work as-is.
- `omp models --json` prints the full catalog to stdout. The shim's
  `model-list` mode reformats it into bb's `id - name` lines (a pure-awk
  fallback parses the human-readable table when `python3` is unavailable).

The shim also embeds the absolute path to the `omp` binary resolved at
`setup` time, so it works even when bb's GUI process doesn't have
`~/.local/bin` on `PATH`.

## Usage

```bash
bb omp setup    # install/repair shim + logo + config entry, reload
bb omp status   # show config/asset/provider registration state
bb provider list        # acp-omp should appear
bb provider models acp-omp
bb thread spawn --provider acp-omp --model <provider>/<model> --prompt "..."
```

## Notes

- Requires the `omp` CLI on PATH (or the embedded absolute path from `setup`)
  and the provider credentials you intend to use (`omp` handles auth under
  `~/.omp`).
- The provider's model picker lists everything in omp's catalog; only models
  from providers you've authenticated with will actually run.
- `omp acp` reports `loadSession: true`, so bb threads resume into omp
  sessions across turns.

## License

MIT
