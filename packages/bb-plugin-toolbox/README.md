# bb-plugin-toolbox

Toolbox keeps MCP servers, raw CLI sources, and optional typed CLI operations in
one repository. Enabled entries appear in a provider-neutral BB agent bridge and
an aggregated MCP endpoint.

## Install

```sh
bb plugin install ./packages/bb-plugin-toolbox --yes
bb plugin reload toolbox
```

Open **Toolbox** in the plugin panel to add sources.

## MCP servers

Toolbox supports:

- Streamable HTTP MCP servers, configured with a URL and optional headers.
- Local stdio MCP servers, configured with a command, arguments, working
  directory, and optional environment.

Tool names are namespaced as `mcp_<source-id>__<tool-name>_<stable-suffix>` so
two servers can expose the same underlying name without colliding. The suffix
also keeps remote names such as `foo.bar` and `foo_bar` distinct after
sanitization.

The proxy route is:

```text
/api/v1/plugins/toolbox/http/mcp
```

The route uses the Toolbox plugin token. Get one with:

```sh
bb plugin token toolbox
```

Pass it as `x-bb-plugin-token` when configuring an MCP client.

The first version proxies tools. Resources, prompts, subscriptions, OAuth, and
remote-host stdio execution are follow-up work.

## CLI sources

A CLI source exposes an executable as-is. Agents pass its subcommand and flags
as an `argv` array, so adding `bird` does not require adding separate entries
for `search`, `read`, `reply`, and every other subcommand.

Toolbox runs the configured executable directly. It does not invoke a shell.
Each call is limited by the configured timeout and output limit, and the agent
cannot change the executable, working directory, or environment.

The native agent tool is `toolbox_run_cli`:

```json
{
  "sourceId": "cli_source_…",
  "argv": ["search", "from:OpenAI", "--json"]
}
```

Use `toolbox_list_sources` first to find the source id. The same source appears
as one `argv`-based tool in the MCP proxy.

## Curated CLI tools

Curated CLI entries are still useful when a stable, typed operation is better
than exposing a whole executable. Each entry includes:

- a binary, such as `gh` or `jq`;
- a JSON input schema;
- an argument template;
- an optional working directory and environment.

Templates use `{{name}}` for one value, `{{json:name}}` for JSON encoding, and
`{{args:name}}` to expand a string array into multiple arguments. For example:

```json
[
  "pr",
  "view",
  "{{number}}",
  "--json",
  "title"
]
```

Toolbox validates the input with the declared JSON schema and starts the binary
without a shell. It enforces the configured timeout and output limit.

Curated CLI operation names are exposed as `cli_<entry-id>__<entry-name>_<stable-suffix>`.
Raw CLI sources appear as one `argv`-based catalog tool per source.

## Agent tools

BB agents receive native tools for both use and administration:

- `toolbox_list_tools` — list the current catalog and schemas;
- `toolbox_run_cli` — run a raw CLI source with direct argv arguments.
- `toolbox_call` — call one exposed MCP or CLI tool.
- `toolbox_list_sources` — list configured sources without credential values;
- `toolbox_save_mcp` / `toolbox_delete_mcp` / `toolbox_refresh_mcp` — manage MCP servers;
- `toolbox_save_cli` / `toolbox_delete_cli` — manage curated CLI operations.
- `toolbox_save_cli_source` / `toolbox_delete_cli_source` — manage raw CLI sources.

This bridge gives providers the same catalog even when they do not have native
MCP configuration. Management tools should only be used when the user asks the
agent to administer Toolbox. When editing an existing source, omit `headers`
and `env` to preserve the stored values.

The command line supports the same management workflow with JSON objects:

```sh
bb toolbox list --json
bb toolbox tools --json
bb toolbox call <tool-name> '{"number":42}'
bb toolbox refresh <mcp-source-id> --json
bb toolbox save-mcp '{"name":"GitHub MCP","transport":"http","url":"https://example.com/mcp"}'
bb toolbox delete-mcp <mcp-source-id>
bb toolbox save-cli '{"name":"github_pr_view","command":"gh","argsTemplate":["pr","view","{{number}}"]}'
bb toolbox delete-cli <cli-tool-id>
bb toolbox save-cli-source '{"name":"Bird","command":"bird","description":"Twitter CLI"}'
bb toolbox delete-cli-source <cli-source-id>
```

The command-line administration surface also supports `save-cli-source` and
`delete-cli-source` for raw executables.

`save-mcp` and `save-cli` upsert when an `id` is supplied, and otherwise create
new entries. JSON inputs may include `headers` and `env`, but prefer the UI or
an explicitly supplied user credential for secrets; command arguments can be
recorded by the invoking shell or agent host.

## Security notes

Toolbox is full-trust plugin code. A declared MCP server or CLI binary can read
and write anything available to the BB server process. Review commands and
credentials before enabling them.

The current UI stores configured headers and environment values in the plugin's
SQLite database. The UI redacts those values after saving, but the database is
not a per-field secret vault yet.
