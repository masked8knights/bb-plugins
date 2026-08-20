# bb-plugin-agent-plugins — Revised Plan (post Terra ultra review)

## Verdict from review: sound direction, not implementation-ready without these corrections.
Blocking changes adopted below: static MCP bridge, transactional activation + approval, hardened skills materialization, corrected spec boundaries, explicit server-host scope.

---

## 0. Context

bb (`https://github.com/patleeman/bb`) plugin that makes bb a conformant [Agent Plugins](https://agent-plugins.org) client (spec 1.0.0 published, 1.1.0 draft). User installs an Agent Plugin once in bb; its Skills + MCP flow to all providers (Codex, Claude, Pi). Reference: spec repo `agentplugins/agent-plugins-spec`, `agentskills.io/specification`, local `bb-plugin-sdk` 0.4.6 + `packages/bb-plugin-toolbox`.

User decisions baked in:
- flow-through install → skills+MCP to providers, single source of truth
- sources day-1: `path:` + `git:` + `npm:`
- skills: **A copy-to-files** (virtual via `bb.agents.configure` cannot inject dynamic skills — only static manifest names per SDK `configure` contract)
- MCP: own gateway, not Toolbox
- accept both `$schema` 1.0.0 + 1.1.0 (1.1 as vendored preview, not “identical”)
- ignore client extensions v0 (reserve `app.getbb`)
- UI: `settingsSection` + `navPanel` at `/plugins/agent-plugins`

---

## 1. Plugin identity

```
packages/bb-plugin-agent-plugins/
  package.json: { name:"bb-plugin-agent-plugins", version:"0.1.0", type:"module",
    engines:{ bb:">=0.37", bbPluginSdk:"^0.4.6" },
    bb:{ name:"Agent Plugins", description:"Install Agent Plugins (skills + MCP) once; flow to every provider.", branding:{icon:"Blocks"}, server:"./server.ts", app:"./app.tsx" } }
  server.ts, app.tsx, src/*, tsconfig, build via `bb plugin build`
```

Icon/branding validated via manifest schema — do not assume `bb.icon`.

---

## 2. Storage — SQLite append-only migrations

```sql
-- v1
CREATE TABLE plugins(
  id TEXT PRIMARY KEY, -- opaque ulid/uuid stable installId
  name TEXT NOT NULL, -- manifest name at install
  version TEXT, description TEXT, specVersion TEXT NOT NULL,
  sourceType TEXT NOT NULL CHECK(sourceType IN ('path','git','npm')),
  sourceIntent TEXT NOT NULL, -- raw input
  sourceResolved TEXT, -- e.g. git commit, npm version+integrity
  sourceRef TEXT, tagPrefix TEXT,
  pluginRoot TEXT NOT NULL, -- <dataDir>/plugins/agent-plugins/plugins/<id>/v<gen>/
  pluginData TEXT NOT NULL, -- <dataDir>/plugins/agent-plugins/data/<id>/ (stable per installId, preserved across updates)
  activeGen INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK(status IN ('active','error','needs-approval')),
  approval TEXT NOT NULL CHECK(approval IN ('pending','approved','disabled')),
  lastError TEXT, contentHash TEXT, installedAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE TABLE plugin_skills(
  pluginId TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  skillName TEXT NOT NULL, skillDir TEXT NOT NULL,
  frontmatterJson TEXT NOT NULL, bodyHash TEXT NOT NULL,
  materializedPath TEXT, status TEXT NOT NULL, lastError TEXT,
  PRIMARY KEY(pluginId, skillName)
);
CREATE TABLE mcp_servers(
  pluginId TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  serverId TEXT NOT NULL, type TEXT NOT NULL,
  configJson TEXT NOT NULL, status TEXT NOT NULL, lastError TEXT,
  approved INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(pluginId, serverId)
);
CREATE TABLE generations(
  pluginId TEXT NOT NULL, gen INTEGER NOT NULL,
  pluginRoot TEXT NOT NULL, contentHash TEXT NOT NULL, createdAt INTEGER NOT NULL,
  PRIMARY KEY(pluginId, gen)
);
```

`bb.storage.migrate(db, [ ... ])` — never reorder.

---

## 3. Loader — pure, vendored schemas, fixture-tested

- Vendor `schemas/1.0.0/plugin.schema.json`, `mcp.schema.json` + `schemas/1.1.0/...` locally. Never fetch `$schema` URLs. Version registry selects locally.
- `plugin.json` closed-schema but tolerant exactly per spec:
  1. unknown top-level fields → report+ignore (non-fatal)
  2. non-object `extensions` → report+ignore (non-fatal)
  3. each unimplemented extension namespace → ignore without validating its value
  4. then strict validate core fields; any other violation → fatal reject plugin.
- Validate `name` regex, but metadata (`version`, `homepage`, `license` etc) only by JSON type — do not over-validate URL/SPDX/SemVer semantics.
- Fix boundaries:

| condition | scope |
|---|---|
| invalid/missing/unsupported `plugin.json` | reject plugin |
| bad `skills/` root kind | disable skills only |
| invalid individual `SKILL.md` | skip skill only |
| bad `mcp.json` envelope or `$schema` mismatch vs `plugin.json` | disable MCP only |
| invalid server entry | skip server only |
| handshake/auth/runtime | keep other servers/skills |
| path escape | deny access, narrow scope |

- Validate `SKILL.md` frontmatter full constraints: `name` matches dirname, 1-64 `^[a-z0-9]+(-[a-z0-9]+)*$`, `description` 1-1024 non-empty, optional `compatibility` ≤500, `allowed-tools`, `metadata` string→string, YAML limits (size/alias/nesting/custom-tag).
- MCP rules (spec-correct):
  - `command` single bare token or `./` relative, never expanded, never shelled, resolved via trusted PATH first then overlay
  - placeholders `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` expanded exactly once only in `args` values, `env` values, `cwd`; never in command/URL/headers/keys/paths
  - only exact `PLUGIN_ROOT`/`PLUGIN_DATA` env keys rejected (platform case rules), forced last after overlay
  - `cwd` must be `./…` | `${PLUGIN_ROOT}…` | `${PLUGIN_DATA}…` → expand then prove containment under pluginRoot or pluginData separately
  - headers case-insensitive duplicate → invalid (no dedup), reject CRLF/invalid syntax, never forward to redirect/SSE cross-origin
  - URLs absolute `http`/`https`, no userinfo/fragment, `http` only for exact `localhost`/loopback literal
  - use null-prototype Maps for `mcpServers`/headers/env (`__proto__` safety), enforce counts/limits

---

## 4. Filesystem & source primitives (no execution yet)

- Staging: every fetch/copy/extract into sibling `…/staging-<uuid>/`, validate, then atomic `rename`. Keep prior active gen until success.
- Containment: `fs.realpath` + `path.relative` check for any plugin-supplied path. Reject absolute/`..`/special files/symlinks/hardlinks in archives v0 (or prove contained).
- Limits: JSON size, skill count, MCP server count, file count, path length, archive size — explicit caps, reported.
- Hashes: content hash for plugin tree + per-skill tree for ownership.
- Sources:
  - `path:` → snapshot copy of original dir to staging, never execute from mutable source
  - `git:` → argv-only `git clone` detached commit, no submodules/prompts, reject unsafe schemes/userinfo, allow HTTPS (+ optional SSH via server SSH agent), `--tag-prefix` for semver tag resolution
  - `npm:` → only `registry name + version/range/dist-tag` grammar; reject `file:`, aliases, tarball URLs, etc. Do not `npm pack` arbitrary text with lifecycle; do registry tarball download + integrity verify or `npm --ignore-scripts`. Record `sourceIntent` vs `sourceResolved` (commit/integrity).

---

## 5. Skills materialization — full-tree, owned, collision-safe (A)

- Read `dataDir` via `await bb.sdk.system.config()` → `dataDir/skills` (not `~/.bb` hardcode). `dataDir/skills` is already staged to host daemons, so v0 already covers remote sessions at next safe runtime boundary — no warning skip.
- Copy **whole skill directory** (all files) preserving exec mode, retain original `SKILL.md` frontmatter.
- Ownership: marker file `.bb-agent-plugins.json` in each materialized skill dir `{ installId, pluginName, skillName, contentHash, specVersion }`.
- Preflight: if `dataDir/skills/<skillName>` exists and marker not matching this installId+hash → mark incoming skill `conflicted`, keep existing, report in diagnostics. Do not prefix/rename (no longer faithful). Do not rely on BB’s “both dropped” — we prevent overwrite.
- Atomic: stage skill trees to sibling staging dirs, then rename. On update, only mutate paths where marker still matches. On remove, delete only owned paths.
- Do not use `nativeSkillRoots` — internal, not public. Long-term ask BB core for dynamic managed skill-root API.

---

## 6. MCP gateway — static bridge, not per-tool registration

- **Surface:** `agent_plugins_list_tools` (catalog: opaqueId, plugin, server, description, inputSchema, status), `agent_plugins_call` (opaqueId + json args), optionally `agent_plugins_status`. No dynamic `registerTool` per remote tool.
- Runtime abstraction: internal `McpRuntime { listTools(), call(), startServer(), stopServer(), status() }` → v0 implementation is server-host only; later host worker swaps in.
- stdio: server-host `child_process` via `McpGateway`, minimal base env, trusted PATH resolution before overlay, `PLUGIN_ROOT`/`PLUGIN_DATA` forced, timeout/output byte caps (`PLUGIN_CLI_OUTPUT_MAX_BYTES` mind), single-flight, bounded reconnect/backoff, circuit breaker, cancellation via `ctx.signal`. Redact headers/env values in snapshots/logs.
- streamable-http: strict validation above, redirect → failure, SSRF-aware, isolated failures. SSE: declare unsupported in v0.
- Approval gate: install stages with `approval=pending` + `approved=0` per server; UI/CLI `approve` shows exe/args/cwd/env keys/endpoint host/placement before enabling. Restart only approved affected servers on activation.

---

## 7. Activation — transactional generations + approval

1. parse intent, acquire per-plugin lock
2. fetch/copy/extract to staging tree
3. validate manifest/skills/mcp + source identity (vendored schemas)
4. preflight skill ownership/collisions
5. prepare materialized skill staging trees
6. stop only affected approved MCP servers
7. atomically switch package + owned skill trees (rename)
8. commit DB generation (`activeGen`++, `generations` row, `contentHash`)
9. restart only approved affected servers
10. realtime `agent-plugins-changed` + notifications

On any failure: retain prior package, materialized skills, DB gen, and `pluginData`.

---

## 8. CLI / RPC / App

CLI (bounded, `--json` clean):
```
bb agent-plugins install <path|git-url|npm:spec> [--tag-prefix <p>] [--json]
bb agent-plugins list [--json]
bb agent-plugins show <id> [--json]
bb agent-plugins update [id|--all] [--json]
bb agent-plugins remove <id> [--purge-data] [--json]
bb agent-plugins refresh <id> [--json]
bb agent-plugins approve <id> --server <serverId> [--json]
bb agent-plugins tools [--json]
bb agent-plugins call <opaqueId> '<json>' [--json]
bb agent-plugins skills [--json]
bb agent-plugins logs <id> [-n]
```

RPC (`defineRpcContract` + zod):
`snapshot`, `install`, `remove`, `update`, `refresh`, `approve`, `listTools`, `callTool`, `skills`.

App (`app.tsx`):
- `settingsSection` (health, spec versions, pending approvals, last error)
- `navPanel` at `/plugins/agent-plugins/<subPath>` (no duplicate pluginId path): install form, plugin cards, per-plugin skill/MCP tables with redacted diagnostics, approval flow, logs, realtime refresh via `useRealtime("agent-plugins-changed")`.

---

## 9. Security

- `fs.realpath` containment, null-prototype maps, no shell invocation, argv-only git, registry tarball verify, `__proto__` guard, CRLF/header injection reject, no header forward, no `$schema` fetch, no secret logging.
- `bb.log` + per-plugin `logs/plugin.log` (5MB rot) redacted.
- CLI output capped at `PLUGIN_CLI_OUTPUT_MAX_BYTES`.

---

## 10. Implementation order

1. loader + vendored schemas + fixture suite (boundaries, symlink, header/env/cwd/placeholder cases, version mismatch)
2. safe FS/source primitives (staging, contained reads, safe extract, limits/hashes/atomic promote)
3. storage + generations (installId, intent/resolution, contentHash, approval, diagnostics)
4. skill materialization (full-tree, collision preflight, marker, atomic swap)
5. stdio MCP static bridge (approval-gated, lifecycle, bounds)
6. streamable-http (strict URL/header/redirect) — SSE omitted until tested
7. CLI/RPC/App (snapshot-first, redacted, realtime)
8. hardening (rollback, moved npm tag, integrity mismatch, modified owned skill, shutdown, stale catalog)
9. multi-host runtime design separately (post host-entry SDK contract proof)

---

## 11. Answers to earlier open questions

- A vs native injection: A is correct v0; long-term propose BB core dynamic skill-root API.
- Collision: preserve names, preflight, mark conflicted, never prefix/overwrite.
- Git/npm host: server-host once, using server credential managers/SSH agent; never relay creds.
- Toolbox multi-host: server-only today — keep same scope, document plainly.
- Marketplace: do not reuse `skills.sh` — it's standalone-skill registry.
- Keepalive: demand-driven with bounded reconnect; background only if transport needs it.
- External `/http/mcp`: omit v0 (adds auth/rate-limit/token surface).

