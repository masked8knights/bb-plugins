// bb-plugin-agent-plugins — backend entry (full activation)
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import * as yaml from "js-yaml";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { AgentPluginsStore } from "./src/store.js";
import { validateManifest, validateMcpEnvelope, validateMcpServer, validateSkillFrontmatter, expandPlaceholders } from "./src/loader.js";
import { McpGateway } from "./src/gateway.js";
import { parseSource, fetchSource } from "./src/source.js";
import { materializeSkill, unmaterializeSkill } from "./src/skills-impl.js";
import { ensureDir, hashDirectory, rimraf, safeCopyDir, stagingDir, atomicRename, LIMITS } from "./src/safe-fs.js";
import type { CatalogTool } from "./src/types.js";

const jsonRecordSchema = z.record(z.string(), z.unknown());

const snapshotSchema = z.object({
  plugins: z.array(z.record(z.string(), z.unknown())),
  skills: z.array(z.record(z.string(), z.unknown())),
  mcpServers: z.array(z.record(z.string(), z.unknown())),
  dataDir: z.string().nullable(),
}).strict();

const toolSchema = z.object({
  opaqueId: z.string(),
  pluginId: z.string(),
  pluginName: z.string(),
  serverId: z.string(),
  serverType: z.string(),
  name: z.string(),
  description: z.string(),
  inputSchema: jsonRecordSchema,
  status: z.enum(["ready", "error"]),
  error: z.string().optional(),
}).strict();

export const rpcContract = defineRpcContract({
  snapshot: { input: z.null(), output: snapshotSchema },
  listTools: { input: z.null(), output: z.object({ tools: z.array(toolSchema) }).strict() },
  callTool: { input: z.object({ opaqueId: z.string().min(1), args: jsonRecordSchema.default({}) }).strict(), output: z.object({ content: z.array(jsonRecordSchema), isError: z.boolean().optional() }).strict() },
  install: { input: z.object({ source: z.string().min(1), tagPrefix: z.string().optional() }).strict(), output: z.object({ id: z.string(), name: z.string().nullable() }).strict() },
  remove: { input: z.object({ id: z.string().min(1), purgeData: z.boolean().optional() }).strict(), output: z.object({ deleted: z.boolean() }).strict() },
  refresh: { input: z.object({ id: z.string().min(1) }).strict(), output: z.object({ id: z.string(), name: z.string().nullable() }).strict() },
  approve: { input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(), output: z.object({ approved: z.boolean() }).strict() },
});

function errorText(e: unknown): string { return e instanceof Error ? e.message : String(e); }

function randomId(): string { return crypto.randomUUID(); }

async function readJsonLimited(filePath: string): Promise<unknown> {
  const stat = await fsp.stat(filePath);
  if (stat.size > LIMITS.maxJsonBytes) throw new Error(`JSON too large: ${filePath} ${stat.size} > ${LIMITS.maxJsonBytes}`);
  const text = await fsp.readFile(filePath, "utf8");
  if (text.length > LIMITS.maxJsonBytes) throw new Error(`JSON too large`);
  return JSON.parse(text);
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("[agent-plugins] loading");

  // dataDir via system.config()
  let dataDir: string | null = null;
  try {
    const cfg = await bb.sdk.system.config() as unknown as { dataDir?: string };
    if (typeof cfg.dataDir === "string") dataDir = cfg.dataDir;
  } catch {}
  if (!dataDir) {
    // Fallback: try to infer from plugin storage location via env? Use os tmp but still need skillsRoot
    // We'll lazy-resolve inside handlers and error if missing
    bb.log.warn("[agent-plugins] dataDir not resolved at load; will resolve lazily");
  }

  const getDataDir = async (): Promise<string> => {
    if (dataDir) return dataDir;
    const cfg = await bb.sdk.system.config() as unknown as { dataDir?: string };
    if (typeof cfg.dataDir === "string" && cfg.dataDir) {
      dataDir = cfg.dataDir;
      return cfg.dataDir;
    }
    throw new Error("dataDir unavailable");
  };

  const store = new AgentPluginsStore(bb.storage.database(), (db, s) => bb.storage.migrate(db, s));
  const gateway = new McpGateway(store, bb.log);
  const installLocks = new Set<string>();

  function redactMcpConfigJson(raw: string): string {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const redacted: Record<string, unknown> = { ...obj };
      if (obj.headers && typeof obj.headers === "object") {
        const h: Record<string, string> = {};
        for (const k of Object.keys(obj.headers as Record<string, unknown>)) h[k] = "***";
        redacted.headers = h;
      }
      if (obj.env && typeof obj.env === "object") {
        const e: Record<string, string> = {};
        for (const k of Object.keys(obj.env as Record<string, unknown>)) e[k] = "***";
        redacted.env = e;
      }
      return JSON.stringify(redacted);
    } catch { return raw; }
  }

  const buildSnapshot = async () => {
    const s = store.snapshot();
    let dd: string | null = null;
    try { dd = await getDataDir(); } catch {}
    // Redact sensitive config for snapshot (headers/env values)
    const redactedMcp = s.mcpServers.map(m => ({ ...m, configJson: redactMcpConfigJson(m.configJson) }));
    return { plugins: s.plugins as unknown as Record<string, unknown>[], skills: s.skills as unknown as Record<string, unknown>[], mcpServers: redactedMcp as unknown as Record<string, unknown>[], dataDir: dd };
  };

  // Static bridge
  bb.agents.registerTool({
    name: "agent_plugins_list_tools",
    description: "List MCP tools exposed by installed Agent Plugins (provider-neutral bridge).",
    instructions: "Call agent_plugins_list_tools first to discover opaque tool IDs and schemas before calling.",
    experimental_statusLabels: { pending: "Listing Agent Plugins tools", completed: "Tools listed" },
    parameters: z.object({}).strict(),
    async execute() { return JSON.stringify({ tools: await gateway.listTools() }, null, 2); },
  });
  bb.agents.registerTool({
    name: "agent_plugins_call",
    description: "Call one Agent Plugin MCP tool by opaque ID through the static bridge.",
    instructions: "Use opaqueId exactly as returned by agent_plugins_list_tools; do not invent tool names.",
    experimental_statusLabels: { pending: "Calling Agent Plugin tool", completed: "Tool completed" },
    parameters: z.object({ opaqueId: z.string().min(1), args: jsonRecordSchema.default({}) }).strict(),
    async execute(input, ctx) {
      try { return JSON.stringify(await gateway.call(input.opaqueId, input.args as Record<string, unknown>, ctx.signal), null, 2); }
      catch (e) { return JSON.stringify({ isError: true, error: errorText(e) }); }
    },
  });
  let catalogSize = 0;
  gateway.listTools().then(t => catalogSize = t.length).catch(() => {});
  bb.agents.configure(() => ({
    tools: ["agent_plugins_list_tools", "agent_plugins_call"],
    skills: [],
    instructions: catalogSize > 0 ? `Agent Plugins bridge: ${catalogSize} MCP tool(s) available via agent_plugins_list_tools → agent_plugins_call.` : "Agent Plugins bridge ready — use agent_plugins_list_tools to discover MCP tools after plugins are installed.",
  }));

  // -------------------------------------------------------------------------
  // Core install logic — transactional staging → validation → atomic activation
  // -------------------------------------------------------------------------
  async function doInstall(sourceInput: string, tagPrefix?: string): Promise<{ id: string; name: string | null }> {
    const dd = await getDataDir();
    const parsed = parseSource(sourceInput, tagPrefix);
    const lockKey = parsed.normalized;
    if (installLocks.has(lockKey)) throw new Error(`An install for ${lockKey} is already running — please wait for it to finish. If it seems stuck, run bb plugin reload agent-plugins to clear it.`);
    installLocks.add(lockKey);
    let fetchRes: { stagingPath: string; resolved: string; contentHash: string } | null = null;
    let pluginRoot: string | null = null;
    let installId: string | null = null;
    let cleanupStaging = true;
    let stagingPath: string | null = null;
    try {
      const stagingBase = path.join(dd, "plugins", "agent-plugins", "staging");
      await ensureDir(stagingBase);
      fetchRes = await fetchSource(parsed, stagingBase);
      stagingPath = fetchRes.stagingPath;
      // Validate manifest
      const pluginJsonPath = path.join(stagingPath!, "plugin.json");
      let manifestRaw: unknown;
      try { manifestRaw = await readJsonLimited(pluginJsonPath); } catch (e) { throw new Error(`plugin.json missing or invalid: ${errorText(e)}`); }
      const mRes = validateManifest(manifestRaw);
      if (mRes.fatal) throw new Error(`plugin.json invalid: ${mRes.errors.join("; ")}${mRes.warnings.length ? ` (warnings: ${mRes.warnings.join("; ")})` : ""}`);
      const name = mRes.name!;
      const specVersion = mRes.specVersion!;
      // Check duplicate name
      const existingByName = store.getPluginByName(name);
      if (existingByName) throw new Error(`plugin already installed as ${existingByName.id} (name: ${name}); remove or update instead`);

      // Content hash for generation
      const contentHash = await hashDirectory(stagingPath!);

      // Determine persistent paths — stable installId
      installId = randomId();
      const pluginsRootBase = path.join(dd, "plugins", "agent-plugins", "plugins");
      const dataBase = path.join(dd, "plugins", "agent-plugins", "data");
      pluginRoot = path.join(pluginsRootBase, installId, `v1`);
      const pluginData = path.join(dataBase, installId);
      await ensureDir(path.dirname(pluginRoot));
      await ensureDir(pluginData);

      // Discover skills
      const skillsRootInStaging = path.join(stagingPath!, "skills");
      const discoveredSkills: { dirName: string; srcDir: string; frontmatter: unknown; bodyHash: string; valid: boolean; errors: string[] }[] = [];
      let skillsDisabled = false;
      try {
        const stat = await fsp.stat(skillsRootInStaging);
        if (!stat.isDirectory()) throw new Error("skills is not directory");
        const entries = await fsp.readdir(skillsRootInStaging, { withFileTypes: true });
        if (entries.length > LIMITS.maxSkillCount) throw new Error(`too many skills: ${entries.length} > ${LIMITS.maxSkillCount}`);
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const dirName = e.name;
          const srcDir = path.join(skillsRootInStaging, dirName);
          const skillMdPath = path.join(srcDir, "SKILL.md");
          let valid = true; let errors: string[] = []; let frontmatter: unknown = null; let bodyHash = "";
          try {
            const text = await fsp.readFile(skillMdPath, "utf8");
            if (text.length > LIMITS.maxSkillMdBytes) throw new Error(`SKILL.md too large`);
            bodyHash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
            const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
            if (!fmMatch) { valid = false; errors.push("Missing frontmatter --- block"); }
            else {
              try { frontmatter = yaml.load(fmMatch[1]); } catch (ye) { valid = false; errors.push(`YAML parse error: ${errorText(ye)}`); }
              if (frontmatter) {
                const v = validateSkillFrontmatter(frontmatter, dirName);
                if (!v.valid) { valid = false; errors.push(...v.errors); }
              }
            }
          } catch (err) {
            valid = false; errors.push(errorText(err));
          }
          discoveredSkills.push({ dirName, srcDir, frontmatter, bodyHash, valid, errors });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // No skills — not an error
        } else {
          // Per spec: bad skills root → disable skills only, not fatal
          skillsDisabled = true;
          bb.log.warn(`[agent-plugins] skills disabled for ${name}: ${errorText(err)}`);
        }
      }

      // Validate MCP envelope + per-server
      const mcpJsonPath = path.join(stagingPath!, "mcp.json");
      let mcpServers: { id: string; raw: unknown; valid: boolean; errors: string[]; type: string | null }[] = [];
      let mcpDisabled = false;
      let mcpEnvelopeValid = true;
      let mcpWarnings: string[] = [];
      try {
        const hasMcp = await fsp.stat(mcpJsonPath).then(() => true).catch(() => false);
        if (hasMcp) {
          const mcpRaw = await readJsonLimited(mcpJsonPath);
          const envelope = validateMcpEnvelope(mcpRaw, specVersion);
          mcpEnvelopeValid = envelope.valid;
          mcpWarnings = envelope.warnings;
          if (!envelope.valid) {
            mcpDisabled = true;
            bb.log.warn(`[agent-plugins] mcp disabled for ${name}: ${envelope.envelopeErrors.join("; ")}`);
          } else {
            if (Object.keys(envelope.servers).length > LIMITS.maxMcpServerCount) throw new Error(`too many mcp servers`);
            for (const [sid, raw] of Object.entries(envelope.servers)) {
              const r = validateMcpServer(sid, raw);
              mcpServers.push({ id: sid, raw, valid: r.valid, errors: r.errors, type: r.type });
            }
          }
        }
      } catch (err) {
        mcpDisabled = true;
        bb.log.warn(`[agent-plugins] mcp disabled for ${name}: ${errorText(err)}`);
      }

      // Atomic promotion: move staging to pluginRoot
      await ensureDir(path.dirname(pluginRoot));
      // If pluginRoot exists (shouldn't), remove
      await rimraf(pluginRoot).catch(() => {});
      await atomicRename(stagingPath!, pluginRoot!);
      cleanupStaging = false; // now owned

      // Materialize skills (full-tree, owned, collision-safe)
      const skillResults: { name: string; status: string; error: string | null; materializedPath: string | null }[] = [];
      if (!skillsDisabled) {
        for (const s of discoveredSkills) {
          if (!s.valid) {
            skillResults.push({ name: s.dirName, status: "skipped", error: s.errors.join("; "), materializedPath: null });
            continue;
          }
          const res = await materializeSkill({ installId: installId!, pluginName: name, skillName: s.dirName, srcDir: path.join(pluginRoot!, "skills", s.dirName), dataDir: dd, specVersion, bodyHash: s.bodyHash });
          skillResults.push({ name: s.dirName, status: res.status, error: res.error, materializedPath: res.materializedPath });
        }
      }

      // DB commit — generations + plugins + skills + mcp
      const now = Date.now();
      const pluginVersion = (mRes.manifest as { version?: string } | null)?.version ?? null;
      const pluginDescription = mRes.description ?? null;
      const pluginRecord = {
        id: installId!,
        name,
        version: typeof pluginVersion === "string" ? pluginVersion : null,
        description: typeof pluginDescription === "string" ? pluginDescription : null,
        specVersion,
        sourceType: parsed.type,
        sourceIntent: parsed.intent,
        sourceResolved: fetchRes!.resolved,
        sourceRef: parsed.gitRef ?? parsed.npmSpec ?? null,
        tagPrefix: parsed.tagPrefix ?? null,
        pluginRoot: pluginRoot!,
        pluginData,
        activeGen: 1,
        status: "needs-approval" as const,
        approval: "pending" as const,
        lastError: null,
        contentHash,
        installedAt: now,
        updatedAt: now,
      };
      store.transaction(() => {
        store.upsertPlugin(pluginRecord as unknown as import("./src/types.js").PluginRecord);
        store.db.prepare(`INSERT OR REPLACE INTO generations (pluginId, gen, pluginRoot, contentHash, createdAt) VALUES (?,?,?,?,?)`).run(installId!, 1, pluginRoot!, contentHash, now);
        for (const s of discoveredSkills) {
          const mr = skillResults.find(r => r.name === s.dirName);
          store.upsertSkill({
            pluginId: installId!,
            skillName: s.dirName,
            skillDir: `skills/${s.dirName}`,
            frontmatterJson: JSON.stringify(s.frontmatter ?? {}),
            bodyHash: s.bodyHash,
            materializedPath: mr?.materializedPath ?? null,
            status: (mr?.status as unknown as "active" | "conflicted" | "skipped" | "error") ?? (s.valid ? "active" : "skipped"),
            lastError: mr?.error ?? (s.valid ? null : s.errors.join("; ")),
          });
        }
        for (const srv of mcpServers) {
          store.upsertMcpServer({
            pluginId: installId!,
            serverId: srv.id,
            type: (srv.type as "stdio" | "streamable-http" | "sse") ?? "stdio",
            configJson: JSON.stringify(srv.raw),
            status: srv.valid ? "idle" : "error",
            lastError: srv.valid ? null : srv.errors.join("; "),
            approved: 0,
          });
        }
      });

      await bb.realtime.publish("agent-plugins-changed", { kind: "install", id: installId! });
      return { id: installId!, name };
    } catch (e) {
      // Transactional cleanup: remove promoted pluginRoot and any materialized skills if DB failed
      try { if (pluginRoot) { await rimraf(pluginRoot).catch(() => {}); await rimraf(path.dirname(pluginRoot)).catch(() => {}); } } catch {}
      try {
        if (installId) {
          const partialSkills = store.listSkills(installId);
          for (const s of partialSkills) if (s.materializedPath) await unmaterializeSkill({ installId: installId!, skillName: s.skillName, dataDir: dd }).catch(() => {});
        }
      } catch {}
      throw e;
    } finally {
      installLocks.delete(lockKey);
      if (cleanupStaging && fetchRes) await rimraf(fetchRes.stagingPath).catch(() => {});
    }
  }

  // RPC registrations
  bb.rpc.register(rpcContract, {
    async snapshot() { return await buildSnapshot() as unknown as { plugins: Record<string, unknown>[]; skills: Record<string, unknown>[]; mcpServers: Record<string, unknown>[]; dataDir: string | null }; },
    async listTools() { return { tools: await gateway.listTools() }; },
    async callTool({ opaqueId, args }) { return gateway.call(opaqueId, args as Record<string, unknown>); },
    async install({ source, tagPrefix }) { return doInstall(source, tagPrefix); },
    async remove({ id, purgeData }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) return { deleted: false };
      // Unmaterialize owned skills
      let dd: string | null = null;
      try { dd = await getDataDir(); } catch {}
      if (dd) {
        const skills = store.listSkills(p.id);
        for (const s of skills) {
          if (s.materializedPath) {
            try { await unmaterializeSkill({ installId: p.id, skillName: s.skillName, dataDir: dd }); } catch (e) { bb.log.warn(`[agent-plugins] unmaterialize ${s.skillName}: ${errorText(e)}`); }
          }
        }
        // Close MCP servers
        for (const srv of store.listMcpServers(p.id)) {
          try { await gateway.closeServer(p.id, srv.serverId); } catch {}
        }
        if (purgeData) await rimraf(p.pluginData).catch(() => {});
        else bb.log.info(`[agent-plugins] preserve pluginData ${p.pluginData} (use --purge-data to delete)`);
        // Remove pluginRoot generation dir's parent (the installId dir)
        await rimraf(path.dirname(p.pluginRoot)).catch(() => {});
      }
      const deleted = store.deletePlugin(p.id);
      await bb.realtime.publish("agent-plugins-changed", { kind: "remove", id: p.id });
      return { deleted };
    },
    async refresh({ id }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) throw new Error(`not found: ${id}`);
      // For v0 refresh just returns; future will re-validate staged tree
      return { id: p.id, name: p.name };
    },
    async approve({ id, serverId }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) throw new Error(`not found: ${id}`);
      const srv = store.listMcpServers(p.id).find(s => s.serverId === serverId);
      if (!srv) throw new Error(`server not found: ${serverId}`);
      store.transaction(() => {
        store.upsertMcpServer({ ...srv, approved: 1, status: "idle", lastError: null });
        // If plugin was pending, move to active after first approval
        if (p.approval === "pending" || p.status === "needs-approval") {
          store.upsertPlugin({ ...p, status: "active", approval: "approved", updatedAt: Date.now() } as import("./src/types.js").PluginRecord);
        }
      });
      return { approved: true };
    },
  });

  // CLI — delegate to RPC where possible, but install is now real
  bb.cli.register({
    name: "agent-plugins",
    summary: "Install Agent Plugins (skills + MCP) once; flow to every provider",
    commands: [
      { name: "list", summary: "List installed Agent Plugins", usage: "bb agent-plugins list [--json]" },
      { name: "show", summary: "Show one plugin", usage: "bb agent-plugins show <id> [--json]" },
      { name: "install", summary: "Install from path/git/npm", usage: "bb agent-plugins install <path|git:url|npm:spec> [--tag-prefix <p>] [--json]" },
      { name: "remove", summary: "Remove a plugin", usage: "bb agent-plugins remove <id> [--purge-data] [--json]" },
      { name: "tools", summary: "List MCP tools via bridge", usage: "bb agent-plugins tools [--json]" },
      { name: "call", summary: "Call an MCP tool by opaqueId", usage: "bb agent-plugins call <opaqueId> <json> [--json]" },
      { name: "skills", summary: "List materialized skills", usage: "bb agent-plugins skills [--json]" },
      { name: "approve", summary: "Approve an MCP server", usage: "bb agent-plugins approve <id> <serverId> [--json]" },
    ],
    async run(argv, _ctx) {
      const [cmd = "list", ...rest] = argv;
      const asJson = rest.includes("--json");
      const snap = store.snapshot();
      if (cmd === "list") {
        const out = snap.plugins;
        return { exitCode: 0, stdout: (asJson ? JSON.stringify(out, null, 2) : out.map(p => `${p.id} ${p.name}@${p.specVersion} [${p.status}] ${p.sourceType}:${p.sourceIntent}`).join("\n")) + "\n" };
      }
      if (cmd === "show") {
        const id = rest[0];
        if (!id || id === "--json") return { exitCode: 2, stderr: "Usage: bb agent-plugins show <id> [--json]\n" };
        const p = store.getPlugin(id) ?? store.getPluginByName(id);
        if (!p) return { exitCode: 1, stderr: `not found: ${id}\n` };
        const rawMcp = store.listMcpServers(p.id);
        const redactedMcp = rawMcp.map(m => ({ ...m, configJson: redactMcpConfigJson(m.configJson) }));
        const detail = { plugin: p, skills: store.listSkills(p.id), mcpServers: redactedMcp };
        return { exitCode: 0, stdout: JSON.stringify(detail, null, 2) + "\n" };
      }
      if (cmd === "install") {
        const source = rest[0];
        if (!source || source === "--json") return { exitCode: 2, stderr: "Usage: bb agent-plugins install <path|git:url|npm:spec> [--json]\n" };
        const tagPrefixIdx = rest.indexOf("--tag-prefix");
        const tagPrefix = tagPrefixIdx !== -1 ? rest[tagPrefixIdx + 1] : undefined;
        try {
          const res = await doInstall(source, tagPrefix);
          return { exitCode: 0, stdout: (asJson ? JSON.stringify(res, null, 2) : `Installed ${res.name} as ${res.id}\n`) };
        } catch (e) {
          return { exitCode: 1, stderr: `${errorText(e)}\n` };
        }
      }
      if (cmd === "remove") {
        const id = rest[0];
        if (!id || id === "--json") return { exitCode: 2, stderr: "Usage: bb agent-plugins remove <id> [--json]\n" };
        const purge = rest.includes("--purge-data");
        const p = store.getPlugin(id) ?? store.getPluginByName(id);
        if (!p) return { exitCode: 1, stderr: `not found: ${id}\n` };
        let dd: string | null = null; try { dd = await getDataDir(); } catch {}
        if (dd) {
          for (const s of store.listSkills(p.id)) if (s.materializedPath) await unmaterializeSkill({ installId: p.id, skillName: s.skillName, dataDir: dd }).catch(() => {});
          for (const srv of store.listMcpServers(p.id)) await gateway.closeServer(p.id, srv.serverId).catch(() => {});
          if (purge) await rimraf(p.pluginData).catch(() => {});
          await rimraf(path.dirname(p.pluginRoot)).catch(() => {});
        }
        const deleted = store.deletePlugin(p.id);
        await bb.realtime.publish("agent-plugins-changed", { kind: "remove", id: p.id });
        return { exitCode: deleted ? 0 : 1, stdout: (asJson ? JSON.stringify({ deleted }) : deleted ? `Removed ${id}\n` : `Not found: ${id}\n`) };
      }
      if (cmd === "tools") {
        const tools = await gateway.listTools();
        return { exitCode: 0, stdout: (asJson ? JSON.stringify({ tools }, null, 2) : tools.map((t: CatalogTool) => `${t.opaqueId} — ${t.description} [${t.serverType}]`).join("\n")) + "\n" };
      }
      if (cmd === "call") {
        const opaqueId = rest[0]; const rawArgs = rest[1];
        if (!opaqueId || opaqueId === "--json" || !rawArgs) return { exitCode: 2, stderr: "Usage: bb agent-plugins call <opaqueId> <json> [--json]\n" };
        try {
          const args = JSON.parse(rawArgs) as Record<string, unknown>;
          const result = await gateway.call(opaqueId, args);
          return { exitCode: result.isError ? 1 : 0, stdout: JSON.stringify(result, null, 2) + "\n" };
        } catch (e) { return { exitCode: 2, stderr: `Invalid JSON args: ${errorText(e)}\n` }; }
      }
      if (cmd === "skills") {
        return { exitCode: 0, stdout: (asJson ? JSON.stringify(snap.skills, null, 2) : snap.skills.map(s => `${s.skillName} [${s.status}] ${s.pluginId}`).join("\n")) + "\n" };
      }
      if (cmd === "approve") {
        const id = rest[0]; const serverId = rest[1];
        if (!id || !serverId || serverId === "--json") return { exitCode: 2, stderr: "Usage: bb agent-plugins approve <id> <serverId> [--json]\n" };
        const p = store.getPlugin(id) ?? store.getPluginByName(id);
        if (!p) return { exitCode: 1, stderr: `not found: ${id}\n` };
        const srv = store.listMcpServers(p.id).find(s => s.serverId === serverId);
        if (!srv) return { exitCode: 1, stderr: `server not found: ${serverId}\n` };
        store.transaction(() => {
          store.upsertMcpServer({ ...srv, approved: 1, status: "idle", lastError: null });
          if (p.approval === "pending" || p.status === "needs-approval") {
            store.upsertPlugin({ ...p, status: "active", approval: "approved", updatedAt: Date.now() } as import("./src/types.js").PluginRecord);
          }
        });
        return { exitCode: 0, stdout: (asJson ? JSON.stringify({ approved: true }) : `Approved ${serverId}\n`) };
      }
      return { exitCode: 2, stderr: "Usage: bb agent-plugins <list|show|install|remove|tools|call|skills|approve> …\n" };
    },
  });

  bb.log.info("[agent-plugins] ready");
  bb.onDispose(async () => { await gateway.close().catch(() => {}); bb.log.info("[agent-plugins] disposed"); });
}
