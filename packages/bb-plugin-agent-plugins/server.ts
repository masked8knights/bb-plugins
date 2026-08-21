// bb-plugin-agent-plugins — backend entry (full activation)
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as yaml from "js-yaml";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { AgentPluginsStore } from "./src/store.js";
import { validateManifest, validateMcpEnvelope, validateMcpServer, validateSkillFrontmatter } from "./src/loader.js";
import { McpGateway } from "./src/gateway.js";
import { DeferredOAuthCredentialStore, McpOAuthProvider, type OAuthCredentialRecord } from "./src/oauth.js";
import { parseSource, fetchSource } from "./src/source.js";
import { materializeSkill, unmaterializeSkill } from "./src/skills-impl.js";
import { ensureDir, hashDirectory, rimraf, atomicRename, LIMITS } from "./src/safe-fs.js";
import type { CatalogPrompt, CatalogResource, CatalogResourceTemplate, CatalogTool } from "./src/types.js";

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
  outputSchema: jsonRecordSchema.optional(),
  annotations: jsonRecordSchema.optional(),
  execution: jsonRecordSchema.optional(),
  icons: z.array(jsonRecordSchema).optional(),
  _meta: jsonRecordSchema.optional(),
  status: z.enum(["ready", "error"]),
  error: z.string().optional(),
}).strict();

const promptSchema = z.object({
  opaqueId: z.string(), pluginId: z.string(), pluginName: z.string(), serverId: z.string(), serverType: z.string(),
  name: z.string(), title: z.string().optional(), description: z.string().optional(), arguments: z.array(jsonRecordSchema).optional(),
  icons: z.array(jsonRecordSchema).optional(), _meta: jsonRecordSchema.optional(), status: z.enum(["ready", "error"]), error: z.string().optional(),
}).strict();

const resourceSchema = z.object({
  opaqueId: z.string(), pluginId: z.string(), pluginName: z.string(), serverId: z.string(), serverType: z.string(),
  uri: z.string(), name: z.string(), title: z.string().optional(), description: z.string().optional(), mimeType: z.string().optional(),
  icons: z.array(jsonRecordSchema).optional(), _meta: jsonRecordSchema.optional(), status: z.enum(["ready", "error"]), error: z.string().optional(),
}).strict();

const resourceTemplateSchema = z.object({
  opaqueId: z.string(), pluginId: z.string(), pluginName: z.string(), serverId: z.string(), serverType: z.string(),
  uriTemplate: z.string(), name: z.string(), title: z.string().optional(), description: z.string().optional(), mimeType: z.string().optional(),
  icons: z.array(jsonRecordSchema).optional(), _meta: jsonRecordSchema.optional(), status: z.enum(["ready", "error"]), error: z.string().optional(),
}).strict();

const authActionOutput = z.object({ url: z.string().nullable(), status: z.string() }).strict();

export const rpcContract = defineRpcContract({
  snapshot: { input: z.null(), output: snapshotSchema },
  listTools: { input: z.null(), output: z.object({ tools: z.array(toolSchema) }).strict() },
  callTool: { input: z.object({ opaqueId: z.string().min(1), args: jsonRecordSchema.default({}) }).strict(), output: z.object({ content: z.array(jsonRecordSchema), isError: z.boolean().optional(), structuredContent: z.unknown().optional(), _meta: jsonRecordSchema.optional() }).strict() },
  listPrompts: { input: z.null(), output: z.object({ prompts: z.array(promptSchema) }).strict() },
  getPrompt: { input: z.object({ opaqueId: z.string().min(1), args: jsonRecordSchema.default({}) }).strict(), output: jsonRecordSchema },
  listResources: { input: z.null(), output: z.object({ resources: z.array(resourceSchema) }).strict() },
  listResourceTemplates: { input: z.null(), output: z.object({ resourceTemplates: z.array(resourceTemplateSchema) }).strict() },
  readResource: { input: z.object({ opaqueId: z.string().min(1) }).strict(), output: jsonRecordSchema },
  complete: { input: z.object({ ref: jsonRecordSchema, argument: jsonRecordSchema }).strict(), output: jsonRecordSchema },
  subscribeResource: { input: z.object({ opaqueId: z.string().min(1) }).strict(), output: z.object({ subscribed: z.boolean() }).strict() },
  unsubscribeResource: { input: z.object({ opaqueId: z.string().min(1) }).strict(), output: z.object({ unsubscribed: z.boolean() }).strict() },
  setLoggingLevel: { input: z.object({ level: z.string().min(1) }).strict(), output: z.object({ updated: z.boolean() }).strict() },
  install: { input: z.object({ source: z.string().min(1), tagPrefix: z.string().optional() }).strict(), output: z.object({ id: z.string(), name: z.string().nullable() }).strict() },
  remove: { input: z.object({ id: z.string().min(1), purgeData: z.boolean().optional() }).strict(), output: z.object({ deleted: z.boolean() }).strict() },
  refresh: { input: z.object({ id: z.string().min(1) }).strict(), output: z.object({ id: z.string(), name: z.string().nullable() }).strict() },
  approve: { input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(), output: z.object({ approved: z.boolean() }).strict() },
  setSkillEnabled: { input: z.object({ id: z.string().min(1), skillName: z.string().min(1), enabled: z.boolean() }).strict(), output: z.object({ enabled: z.boolean(), status: z.string(), lastError: z.string().nullable() }).strict() },
  setMcpEnabled: { input: z.object({ id: z.string().min(1), serverId: z.string().min(1), enabled: z.boolean() }).strict(), output: z.object({ enabled: z.boolean(), status: z.string(), lastError: z.string().nullable() }).strict() },
  authenticate: { input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(), output: z.object({ url: z.string().nullable(), status: z.string() }).strict() },
  reconnect: { input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(), output: authActionOutput },
  reauthorize: { input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(), output: authActionOutput },
  authStatus: { input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(), output: z.object({ status: z.string() }).strict() },
  finishAuthentication: { input: z.object({ id: z.string().min(1), serverId: z.string().min(1), callbackUrl: z.string().url() }).strict(), output: z.object({ authenticated: z.boolean() }).strict() },
  clearAuthentication: { input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(), output: z.object({ cleared: z.boolean() }).strict() },
  pickFolder: { input: z.null(), output: z.object({ path: z.string().nullable() }).strict() },
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

  async function publishChanged(payload: Record<string, unknown>): Promise<void> {
    try {
      await bb.realtime.publish("agent-plugins-changed", payload);
    } catch (e) {
      // Realtime is an observation channel; it must not turn a committed
      // install or approval into a failed operation.
      bb.log.warn(`[agent-plugins] realtime publish failed: ${errorText(e)}`);
    }
  }

  const store = new AgentPluginsStore(bb.storage.database(), (db, s) => bb.storage.migrate(db, s));
  const oauthSettings = bb.settings.define({
    oauthCredentials: {
      type: "string",
      label: "MCP OAuth credentials",
      description: "Managed automatically by Agent Plugins; stored as a BB secret.",
      secret: true,
      default: "",
    },
  });
  const oauthCredentialStore = new DeferredOAuthCredentialStore({
    async load(): Promise<Record<string, OAuthCredentialRecord>> {
      const settings = await oauthSettings.get();
      const raw = settings.oauthCredentials;
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, OAuthCredentialRecord>;
      } catch (e) { bb.log.warn(`[agent-plugins] OAuth secret store is invalid: ${errorText(e)}`); }
      return {};
    },
    async save(next: Record<string, OAuthCredentialRecord>): Promise<void> {
      await bb.sdk.plugins.updateSettings({ pluginId: bb.pluginId, values: { oauthCredentials: JSON.stringify(next) } });
    },
  }, (error) => bb.log.warn(`[agent-plugins] OAuth secret persistence failed: ${errorText(error)}`));
  async function withDeferredOAuthPersistence<T>(operation: () => Promise<T>): Promise<T> {
    const release = oauthCredentialStore.deferPersistence();
    try { return await operation(); }
    finally { release(); }
  }
  async function deleteOAuthCredentials(pluginId: string, serverId: string): Promise<void> {
    try {
      await oauthCredentialStore.delete(`${pluginId}:${serverId}`);
    } catch (e) {
      throw new Error(`Could not delete OAuth credentials for ${pluginId}:${serverId}: ${errorText(e)}`, { cause: e });
    }
  }
  const gateway = new McpGateway(store, bb.log, {
    onChanged: () => publishChanged({ kind: "mcp-runtime" }),
    oauth: {
      async getProvider(pluginId, serverId, serverUrl) {
        const redirect = new URL(`/api/v1/plugins/${encodeURIComponent(bb.pluginId)}/http/oauth/callback`, bb.server.loopbackBaseUrl);
        redirect.search = new URLSearchParams({ pluginId, serverId }).toString();
        return new McpOAuthProvider(`${pluginId}:${serverId}`, serverUrl, redirect, oauthCredentialStore);
      },
    },
  });
  const installLocks = new Set<string>();

  bb.http.route("GET", "/oauth/callback", async (context) => {
    const url = new URL(context.req.url);
    const pluginId = url.searchParams.get("pluginId");
    const serverId = url.searchParams.get("serverId");
    if (!pluginId || !serverId) return new Response("Missing Agent Plugins OAuth callback context", { status: 400 });
    try {
      await withDeferredOAuthPersistence(() => gateway.finishAuth(pluginId, serverId, url.searchParams));
      await publishChanged({ kind: "oauth", id: pluginId, serverId });
      return new Response("<p>Authentication completed. You can close this window.</p>", { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch (e) {
      bb.log.warn(`[agent-plugins] OAuth callback failed for ${serverId}: ${errorText(e)}`);
      return new Response("<p>Authentication failed. Return to BB and try again.</p>", { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
    }
  });

  async function approveServer(id: string, serverId: string): Promise<void> {
    const p = store.getPlugin(id) ?? store.getPluginByName(id);
    if (!p) throw new Error(`not found: ${id}`);
    const srv = store.listMcpServers(p.id).find((s) => s.serverId === serverId);
    if (!srv) throw new Error(`server not found: ${serverId}`);
    if (srv.enabled !== 1) throw new Error(`Enable MCP server ${serverId} before approving it`);

    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(srv.configJson) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`Cannot approve invalid server ${serverId}: ${errorText(e)}`);
    }
    const validation = validateMcpServer(serverId, cfg);
    if (!validation.valid) throw new Error(`Cannot approve invalid server ${serverId}: ${validation.errors.join("; ")}`);
    store.transaction(() => {
      store.upsertMcpServer({ ...srv, approved: 1, status: "idle", lastError: null });
      if (p.approval === "pending" || p.status === "needs-approval") {
        store.upsertPlugin({ ...p, status: "active", approval: "approved", updatedAt: Date.now() } as import("./src/types.js").PluginRecord);
      }
    });

    // Approval is durable even when the first connection attempt fails. The
    // gateway records that failure and can retry on a later tools request.
    await gateway.closeServer(p.id, serverId);
    try {
      await gateway.startServer(p.id, serverId);
    } catch (e) {
      const message = errorText(e);
      const failed = store.listMcpServers(p.id).find((s) => s.serverId === serverId);
      // The gateway has already persisted `needs-auth` when the official SDK
      // starts an OAuth flow. Preserve that state so the UI can offer
      // Authenticate instead of turning a normal consent step into a retry
      // error.
      if (failed && failed.status !== "needs-auth") store.upsertMcpServer({ ...failed, status: "error", lastError: message });
      bb.log.warn(`[agent-plugins] approve start failed for ${serverId}: ${message}`);
    }
    await publishChanged({ kind: "approve", id: p.id, serverId });
  }

  async function pathExists(filePath: string): Promise<boolean> {
    try {
      await fsp.stat(filePath);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }

  async function setSkillEnabled(id: string, skillName: string, enabled: boolean) {
    const p = store.getPlugin(id) ?? store.getPluginByName(id);
    if (!p) throw new Error(`not found: ${id}`);
    const skill = store.listSkills(p.id).find((s) => s.skillName === skillName);
    if (!skill) throw new Error(`skill not found: ${skillName}`);

    if (!enabled) {
      if (skill.materializedPath) {
        const removed = await unmaterializeSkill({ installId: p.id, skillName, dataDir: await getDataDir() });
        if (!removed && await pathExists(skill.materializedPath)) {
          throw new Error(`Cannot disable skill ${skillName}: it was modified outside Agent Plugins. Resolve the conflict before disabling it.`);
        }
      }
      store.upsertSkill({
        ...skill,
        enabled: 0,
        materializedPath: null,
        status: "skipped",
        lastError: skill.status === "active" ? null : skill.lastError,
      });
    } else {
      const result = await materializeSkill({
        installId: p.id,
        pluginName: p.name,
        skillName,
        srcDir: path.join(p.pluginRoot, skill.skillDir),
        dataDir: await getDataDir(),
        specVersion: p.specVersion,
      });
      store.upsertSkill({
        ...skill,
        enabled: 1,
        materializedPath: result.materializedPath,
        status: result.status,
        lastError: result.error,
      });
    }

    const updated = store.listSkills(p.id).find((s) => s.skillName === skillName);
    if (!updated) throw new Error(`skill disappeared while updating: ${skillName}`);
    await publishChanged({ kind: "skill-toggle", id: p.id, skillName, enabled });
    return { enabled: updated.enabled === 1, status: updated.status, lastError: updated.lastError };
  }

  async function setMcpEnabled(id: string, serverId: string, enabled: boolean) {
    const p = store.getPlugin(id) ?? store.getPluginByName(id);
    if (!p) throw new Error(`not found: ${id}`);
    const srv = store.listMcpServers(p.id).find((s) => s.serverId === serverId);
    if (!srv) throw new Error(`server not found: ${serverId}`);

    if (!enabled) {
      store.upsertMcpServer({ ...srv, enabled: 0, status: "disabled", lastError: null });
      await gateway.closeServer(p.id, serverId);
    } else {
      let cfg: Record<string, unknown>;
      try {
        cfg = JSON.parse(srv.configJson) as Record<string, unknown>;
      } catch (e) {
        throw new Error(`Cannot enable invalid server ${serverId}: ${errorText(e)}`);
      }
      const validation = validateMcpServer(serverId, cfg);
      if (!validation.valid) throw new Error(`Cannot enable invalid server ${serverId}: ${validation.errors.join("; ")}`);
      store.upsertMcpServer({ ...srv, enabled: 1, status: "idle", lastError: null });
      if (srv.approved === 1) {
        try {
          await gateway.startServer(p.id, serverId);
        } catch (e) {
          const message = errorText(e);
          const failed = store.listMcpServers(p.id).find((s) => s.serverId === serverId);
          if (failed && failed.status !== "needs-auth") store.upsertMcpServer({ ...failed, status: "error", lastError: message });
          bb.log.warn(`[agent-plugins] enable start failed for ${serverId}: ${message}`);
        }
      }
    }

    const updated = store.listMcpServers(p.id).find((s) => s.serverId === serverId);
    if (!updated) throw new Error(`server disappeared while updating: ${serverId}`);
    await publishChanged({ kind: "mcp-toggle", id: p.id, serverId, enabled });
    return { enabled: updated.enabled === 1, status: updated.status, lastError: updated.lastError };
  }

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
    const skills = s.skills.map((skill) => ({ ...skill, enabled: skill.enabled === 1 }));
    const redactedMcp = await Promise.all(s.mcpServers.map(async (m) => {
      let authStatus = "not-applicable";
      if (m.type !== "stdio") {
        try { authStatus = await gateway.authStatus(m.pluginId, m.serverId); }
        catch { authStatus = "unknown"; }
      }
      return { ...m, enabled: m.enabled === 1, authStatus, configJson: redactMcpConfigJson(m.configJson) };
    }));
    return { plugins: s.plugins as unknown as Record<string, unknown>[], skills: skills as unknown as Record<string, unknown>[], mcpServers: redactedMcp as unknown as Record<string, unknown>[], dataDir: dd };
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
  bb.agents.registerTool({
    name: "agent_plugins_list_prompts",
    description: "List MCP prompts exposed by installed Agent Plugins.",
    instructions: "Call agent_plugins_list_prompts first to discover opaque prompt IDs before calling agent_plugins_get_prompt.",
    experimental_statusLabels: { pending: "Listing Agent Plugins prompts", completed: "Prompts listed" },
    parameters: z.object({}).strict(),
    async execute() { return JSON.stringify({ prompts: await gateway.listPrompts() }, null, 2); },
  });
  bb.agents.registerTool({
    name: "agent_plugins_get_prompt",
    description: "Get one Agent Plugin MCP prompt by opaque ID.",
    instructions: "Use opaqueId exactly as returned by agent_plugins_list_prompts; do not invent prompt names.",
    experimental_statusLabels: { pending: "Getting Agent Plugins prompt", completed: "Prompt returned" },
    parameters: z.object({ opaqueId: z.string().min(1), args: jsonRecordSchema.default({}) }).strict(),
    async execute(input, ctx) { return JSON.stringify(await gateway.getPrompt(input.opaqueId, input.args as Record<string, unknown>, ctx.signal), null, 2); },
  });
  bb.agents.registerTool({
    name: "agent_plugins_list_resources",
    description: "List MCP resources and resource templates exposed by installed Agent Plugins.",
    instructions: "Call agent_plugins_list_resources first to discover opaque resource IDs before calling agent_plugins_read_resource.",
    experimental_statusLabels: { pending: "Listing Agent Plugins resources", completed: "Resources listed" },
    parameters: z.object({}).strict(),
    async execute() { return JSON.stringify({ resources: await gateway.listResources(), resourceTemplates: await gateway.listResourceTemplates() }, null, 2); },
  });
  bb.agents.registerTool({
    name: "agent_plugins_read_resource",
    description: "Read one Agent Plugin MCP resource by opaque ID.",
    instructions: "Use opaqueId exactly as returned by agent_plugins_list_resources; do not invent resource URIs.",
    experimental_statusLabels: { pending: "Reading Agent Plugins resource", completed: "Resource returned" },
    parameters: z.object({ opaqueId: z.string().min(1) }).strict(),
    async execute(input, ctx) { return JSON.stringify(await gateway.readResource(input.opaqueId, ctx.signal), null, 2); },
  });
  bb.agents.configure(() => ({
    tools: ["agent_plugins_list_tools", "agent_plugins_call", "agent_plugins_list_prompts", "agent_plugins_get_prompt", "agent_plugins_list_resources", "agent_plugins_read_resource"],
    skills: [],
    instructions: "Agent Plugins bridge ready — use agent_plugins_list_tools to discover MCP tools after plugins are installed.",
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
    let pluginDataPath: string | null = null;
    let cleanupStaging = true;
    let stagingPath: string | null = null;
    const materializedSkillNames: string[] = [];
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
      pluginDataPath = pluginData;
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
      try {
        const hasMcp = await fsp.stat(mcpJsonPath).then(() => true).catch(() => false);
        if (hasMcp) {
          const mcpRaw = await readJsonLimited(mcpJsonPath);
          const envelope = validateMcpEnvelope(mcpRaw, specVersion);
          if (!envelope.valid) {
            bb.log.warn(`[agent-plugins] mcp disabled for ${name}: ${envelope.envelopeErrors.join("; ")}`);
          } else {
            if (Object.keys(envelope.servers).length > LIMITS.maxMcpServerCount) throw new Error(`too many mcp servers`);
            for (const [sid, raw] of Object.entries(envelope.servers)) {
              const r = validateMcpServer(sid, raw);
              mcpServers.push({
                id: sid,
                raw,
                valid: r.valid,
                errors: r.errors,
                type: r.type,
              });
            }
          }
        }
      } catch (err) {
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
          const res = await materializeSkill({ installId: installId!, pluginName: name, skillName: s.dirName, srcDir: path.join(pluginRoot!, "skills", s.dirName), dataDir: dd, specVersion });
          skillResults.push({ name: s.dirName, status: res.status, error: res.error, materializedPath: res.materializedPath });
          if (res.materializedPath) materializedSkillNames.push(s.dirName);
        }
      }

      // DB commit — generations + plugins + skills + mcp
      const now = Date.now();
      const pluginVersion = (mRes.manifest as { version?: string } | null)?.version ?? null;
      const pluginDescription = mRes.description ?? null;
      const hasValidMcp = mcpServers.some((s) => s.valid);
      const pluginStatus: "active" | "needs-approval" = hasValidMcp ? "needs-approval" : "active";
      const pluginApproval: "pending" | "approved" = hasValidMcp ? "pending" : "approved";
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
        status: pluginStatus,
        approval: pluginApproval,
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
            enabled: 1,
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
            enabled: 1,
          });
        }
      });

      await publishChanged({ kind: "install", id: installId! });
      return { id: installId!, name };
    } catch (e) {
      // Transactional cleanup: remove promoted pluginRoot and any materialized skills if DB failed
      try { if (pluginRoot) { await rimraf(pluginRoot).catch(() => {}); await rimraf(path.dirname(pluginRoot)).catch(() => {}); } } catch {}
      if (installId) {
        for (const skillName of materializedSkillNames) {
          await unmaterializeSkill({ installId, skillName, dataDir: dd }).catch(() => {});
        }
      }
      if (pluginDataPath) await rimraf(pluginDataPath).catch(() => {});
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
    async listPrompts() { return { prompts: await gateway.listPrompts() }; },
    async getPrompt({ opaqueId, args }) { return gateway.getPrompt(opaqueId, args as Record<string, unknown>); },
    async listResources() { return { resources: await gateway.listResources() }; },
    async listResourceTemplates() { return { resourceTemplates: await gateway.listResourceTemplates() }; },
    async readResource({ opaqueId }) { return gateway.readResource(opaqueId); },
    async complete({ ref, argument }) { return gateway.complete(ref as Record<string, unknown>, argument as Record<string, unknown>); },
    async subscribeResource({ opaqueId }) { await gateway.subscribeResource(opaqueId); return { subscribed: true }; },
    async unsubscribeResource({ opaqueId }) { await gateway.unsubscribeResource(opaqueId); return { unsubscribed: true }; },
    async setLoggingLevel({ level }) { await gateway.setLoggingLevel(level); return { updated: true }; },
    async install({ source, tagPrefix }) { return doInstall(source, tagPrefix); },
    async remove({ id, purgeData }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) return { deleted: false };
      // Unmaterialize owned skills
      const dd = await getDataDir();
      const skills = store.listSkills(p.id);
      for (const s of skills) {
        if (s.materializedPath) {
          try { await unmaterializeSkill({ installId: p.id, skillName: s.skillName, dataDir: dd }); } catch (e) { bb.log.warn(`[agent-plugins] unmaterialize ${s.skillName}: ${errorText(e)}`); }
        }
      }
      // Close MCP servers
      for (const srv of store.listMcpServers(p.id)) {
        try { await gateway.closeServer(p.id, srv.serverId); } catch {}
        await deleteOAuthCredentials(p.id, srv.serverId);
      }
      if (purgeData) await rimraf(p.pluginData).catch(() => {});
      else bb.log.info(`[agent-plugins] preserve pluginData ${p.pluginData} (use --purge-data to delete)`);
      // Remove pluginRoot generation dir's parent (the installId dir)
      await rimraf(path.dirname(p.pluginRoot)).catch(() => {});
      const deleted = store.deletePlugin(p.id);
      await publishChanged({ kind: "remove", id: p.id });
      return { deleted };
    },
    async refresh({ id }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) throw new Error(`not found: ${id}`);
      // Compatibility endpoint retained for older Agent Plugins clients.
      return { id: p.id, name: p.name };
    },
    async approve({ id, serverId }) {
      await approveServer(id, serverId);
      return { approved: true };
    },
    async setSkillEnabled({ id, skillName, enabled }) {
      return setSkillEnabled(id, skillName, enabled);
    },
    async setMcpEnabled({ id, serverId, enabled }) {
      return setMcpEnabled(id, serverId, enabled);
    },
    async authenticate({ id, serverId }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) throw new Error(`not found: ${id}`);
      const url = await gateway.authUrl(p.id, serverId);
      return { url, status: await gateway.authStatus(p.id, serverId) };
    },
    async reconnect({ id, serverId }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) throw new Error(`not found: ${id}`);
      const url = await gateway.reconnectServer(p.id, serverId);
      const status = await gateway.authStatus(p.id, serverId);
      await publishChanged({ kind: "mcp-reconnect", id: p.id, serverId });
      return { url, status };
    },
    async reauthorize({ id, serverId }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) throw new Error(`not found: ${id}`);
      const result = await withDeferredOAuthPersistence(async () => {
        await gateway.clearAuthentication(p.id, serverId);
        const url = await gateway.authUrl(p.id, serverId);
        return { url, status: await gateway.authStatus(p.id, serverId) };
      });
      await publishChanged({ kind: "mcp-reauthorize", id: p.id, serverId });
      return result;
    },
    async authStatus({ id, serverId }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) throw new Error(`not found: ${id}`);
      return { status: await gateway.authStatus(p.id, serverId) };
    },
    async finishAuthentication({ id, serverId, callbackUrl }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) throw new Error(`not found: ${id}`);
      const callback = new URL(callbackUrl);
      await withDeferredOAuthPersistence(() => gateway.finishAuth(p.id, serverId, callback.searchParams));
      await publishChanged({ kind: "oauth", id: p.id, serverId });
      return { authenticated: true };
    },
    async clearAuthentication({ id, serverId }) {
      const p = store.getPlugin(id) ?? store.getPluginByName(id);
      if (!p) throw new Error(`not found: ${id}`);
      await withDeferredOAuthPersistence(() => gateway.clearAuthentication(p.id, serverId));
      return { cleared: true };
    },
    async pickFolder() {
      try {
        const cfg = (await bb.sdk.system.config()) as unknown as { primaryHostId?: string | null };
        let hostId: string | null = cfg.primaryHostId ?? null;
        if (!hostId) {
          try {
            const hosts = await bb.sdk.hosts.list();
            hostId = hosts[0]?.id ?? null;
          } catch {}
        }
        if (!hostId) throw new Error("No host available for folder picker");
        const res = await bb.sdk.hosts.pickFolder({ hostId, clientHostId: hostId });
        const picked = res.path ?? null;
        return { path: typeof picked === "string" ? picked : null };
      } catch (e) {
        throw new Error(`Folder picker failed: ${errorText(e)}`);
      }
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
      { name: "prompts", summary: "List MCP prompts via bridge", usage: "bb agent-plugins prompts [--json]" },
      { name: "resources", summary: "List MCP resources via bridge", usage: "bb agent-plugins resources [--json]" },
      { name: "skills", summary: "List materialized skills", usage: "bb agent-plugins skills [--json]" },
      { name: "approve", summary: "Approve an MCP server", usage: "bb agent-plugins approve <id> <serverId> [--json]" },
      { name: "auth", summary: "Start or inspect MCP OAuth", usage: "bb agent-plugins auth <id> <serverId> [--json]" },
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
        try {
          const dd = await getDataDir();
          for (const s of store.listSkills(p.id)) if (s.materializedPath) await unmaterializeSkill({ installId: p.id, skillName: s.skillName, dataDir: dd }).catch(() => {});
          for (const srv of store.listMcpServers(p.id)) {
            await gateway.closeServer(p.id, srv.serverId).catch(() => {});
            await deleteOAuthCredentials(p.id, srv.serverId);
          }
          if (purge) await rimraf(p.pluginData).catch(() => {});
          await rimraf(path.dirname(p.pluginRoot)).catch(() => {});
        } catch (e) {
          return { exitCode: 1, stderr: `${errorText(e)}\n` };
        }
        const deleted = store.deletePlugin(p.id);
        await publishChanged({ kind: "remove", id: p.id });
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
      if (cmd === "prompts") {
        const prompts = await gateway.listPrompts();
        return { exitCode: 0, stdout: (asJson ? JSON.stringify({ prompts }, null, 2) : prompts.map((p: CatalogPrompt) => `${p.opaqueId} — ${p.description ?? p.name} [${p.serverType}]`).join("\n")) + "\n" };
      }
      if (cmd === "resources") {
        const resources = await gateway.listResources();
        const resourceTemplates = await gateway.listResourceTemplates();
        return { exitCode: 0, stdout: (asJson ? JSON.stringify({ resources, resourceTemplates }, null, 2) : [...resources.map((r: CatalogResource) => `${r.opaqueId} — ${r.uri}`), ...resourceTemplates.map((r: CatalogResourceTemplate) => `${r.opaqueId} — ${r.uriTemplate}`)].join("\n")) + "\n" };
      }
      if (cmd === "skills") {
        return { exitCode: 0, stdout: (asJson ? JSON.stringify(snap.skills, null, 2) : snap.skills.map(s => `${s.skillName} [${s.status}] ${s.pluginId}`).join("\n")) + "\n" };
      }
      if (cmd === "approve") {
        const id = rest[0]; const serverId = rest[1];
        if (!id || !serverId || serverId === "--json") return { exitCode: 2, stderr: "Usage: bb agent-plugins approve <id> <serverId> [--json]\n" };
        try {
          await approveServer(id, serverId);
          return { exitCode: 0, stdout: (asJson ? JSON.stringify({ approved: true }) : `Approved ${serverId}\n`) };
        } catch (e) {
          return { exitCode: 1, stderr: `${errorText(e)}\n` };
        }
      }
      if (cmd === "auth") {
        const id = rest[0]; const serverId = rest[1];
        if (!id || !serverId || serverId === "--json") return { exitCode: 2, stderr: "Usage: bb agent-plugins auth <id> <serverId> [--json]\n" };
        try {
          const p = store.getPlugin(id) ?? store.getPluginByName(id);
          if (!p) throw new Error(`not found: ${id}`);
          const url = await gateway.authUrl(p.id, serverId);
          const status = await gateway.authStatus(p.id, serverId);
          return { exitCode: 0, stdout: asJson ? JSON.stringify({ url, status }, null, 2) + "\n" : `${status}${url ? ` — authorize at ${url}` : ""}\n` };
        } catch (e) { return { exitCode: 1, stderr: `${errorText(e)}\n` }; }
      }
      return { exitCode: 2, stderr: "Usage: bb agent-plugins <list|show|install|remove|tools|call|prompts|resources|skills|approve|auth> …\n" };
    },
  });

  bb.log.info("[agent-plugins] ready");
  bb.onDispose(async () => { await gateway.close().catch(() => {}); bb.log.info("[agent-plugins] disposed"); });
}
