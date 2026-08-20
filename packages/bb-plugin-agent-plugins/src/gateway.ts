/**
 * MCP static bridge — server-host only v0, internal McpRuntime interface.
 * Real implementation for stdio + streamable-http, isolated failures,
 * placeholder expansion, containment, and approval gating.
 * Adapted from Toolbox gateway patterns.
 */
import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Client, StreamableHTTPClientTransport, type Tool } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { AgentPluginsStore } from "./store.js";
import type { CatalogTool, JsonRecord } from "./types.js";
import { expandPlaceholders } from "./loader.js";
import { isWithinRoot } from "./safe-fs.js";

export interface McpRuntime {
  listTools(): Promise<CatalogTool[]>;
  call(opaqueId: string, args: JsonRecord, signal?: AbortSignal): Promise<{ content: JsonRecord[]; isError?: boolean }>;
  startServer(pluginId: string, serverId: string): Promise<void>;
  stopServer(pluginId: string, serverId: string): Promise<void>;
  status(): Promise<Record<string, string>>;
  close(): Promise<void>;
  closeServer(pluginId: string, serverId: string): Promise<void>;
  // Called after store mutation to refresh catalog
  setCatalog?(tools: CatalogTool[]): void;
}

const MCP_CLIENT_INFO = { name: "bb-agent-plugins", version: "0.1.0" };
const CONNECT_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 2_000;
const RETRY_AFTER_MS = 5_000;

function errorText(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function slug(v: string): string { return v.toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "") || "tool"; }
function shortHash(v: string): string { return crypto.createHash("sha256").update(v).digest("hex").slice(0, 10); }

function exposedId(pluginId: string, serverId: string, toolName: string): string {
  return `${slug(pluginId)}__${slug(serverId)}__${slug(toolName)}_${shortHash(JSON.stringify([pluginId, serverId, toolName]))}`;
}

function toolSchema(tool: Tool): JsonRecord {
  const s: unknown = tool.inputSchema;
  if (s !== null && typeof s === "object" && !Array.isArray(s) && (s as { type?: string }).type === "object") return s as JsonRecord;
  return { type: "object", properties: {}, additionalProperties: true };
}

interface Connected {
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  tools: Tool[];
}

interface Failure { message: string; at: number; }

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function listTools(client: Client): Promise<Tool[]> {
  const r = await client.listTools();
  return r.tools;
}

interface ServerConfig {
  type: "stdio" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

function parseServerConfig(rawJson: string): ServerConfig | null {
  try {
    return JSON.parse(rawJson) as ServerConfig;
  } catch { return null; }
}

export class McpGateway implements McpRuntime {
  private readonly conns = new Map<string, Connected>(); // key = `${pluginId}:${serverId}`
  private readonly pending = new Map<string, Promise<Connected>>();
  private readonly failures = new Map<string, Failure>();
  private closed = false;

  constructor(
    private readonly store: AgentPluginsStore,
    private readonly log: { info(m: string): void; warn(m: string): void; error(m: string): void },
  ) {}

  private key(pluginId: string, serverId: string): string { return `${pluginId}:${serverId}`; }

  async close(): Promise<void> {
    this.closed = true;
    const pending = [...this.pending.values()];
    await Promise.allSettled(pending);
    const conns = [...this.conns.entries()];
    this.conns.clear();
    this.failures.clear();
    await Promise.all(conns.map(async ([k, c]) => {
      try { await c.client.close(); } catch (e) { this.log.warn(`close ${k}: ${errorText(e)}`); }
    }));
  }

  async closeServer(pluginId: string, serverId: string): Promise<void> {
    const k = this.key(pluginId, serverId);
    const pend = this.pending.get(k);
    if (pend) try { await pend; } catch {}
    const c = this.conns.get(k);
    this.conns.delete(k);
    this.failures.delete(k);
    if (!c) return;
    try { await c.client.close(); } catch (e) { this.log.warn(`close ${k}: ${errorText(e)}`); }
  }

  async startServer(pluginId: string, serverId: string): Promise<void> { await this.ensureServer(pluginId, serverId); }
  async stopServer(pluginId: string, serverId: string): Promise<void> { await this.closeServer(pluginId, serverId); }
  async status(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [k, f] of this.failures) out[k] = f.message;
    for (const [k, c] of this.conns) out[k] = `ready ${c.tools.length} tools`;
    return out;
  }

  private async ensureServer(pluginId: string, serverId: string): Promise<Connected | null> {
    if (this.closed) throw new Error("MCP gateway closed");
    const k = this.key(pluginId, serverId);
    const existing = this.conns.get(k);
    if (existing) return existing;
    const pend = this.pending.get(k);
    if (pend) return pend;
    const rec = this.store.listMcpServers(pluginId).find(s => s.serverId === serverId);
    if (!rec) return null;
    if (rec.approved !== 1) throw new Error(`MCP server ${serverId} not approved (approval gate)`);
    const fail = this.failures.get(k);
    if (fail && Date.now() - fail.at < RETRY_AFTER_MS) throw new Error(fail.message);
    const cfg = parseServerConfig(rec.configJson);
    if (!cfg) throw new Error(`invalid server config for ${serverId}`);
    // sse is unsupported in v0
    if (cfg.type === "sse") throw new Error(`sse transport not supported in v0 (server ${serverId})`);

    const p = this.connectServer(pluginId, serverId, rec.pluginId, cfg);
    this.pending.set(k, p);
    try { return await p; } finally { if (this.pending.get(k) === p) this.pending.delete(k); }
  }

  private async connectServer(pluginId: string, serverId: string, _storePluginId: string, cfg: ServerConfig): Promise<Connected> {
    const k = this.key(pluginId, serverId);
    // Resolve plugin paths for placeholders: pluginRoot/pluginData from store plugins table
    const plugin = this.store.getPlugin(pluginId);
    if (!plugin) throw new Error(`plugin not found: ${pluginId}`);
    const pluginRoot = plugin.pluginRoot;
    const pluginData = plugin.pluginData;

    let client: Client | undefined;
    try {
      client = new Client(MCP_CLIENT_INFO, { versionNegotiation: { mode: "auto" } });
      let transport: Connected["transport"];
      if (cfg.type === "streamable-http") {
        const url = cfg.url!;
        // Headers already validated; do not expand. Enforce no redirect header forwarding per spec.
        const redirectGuardFetch: typeof fetch = async (input, init) => {
          const res = await fetch(input as URL | RequestInfo, { ...(init as RequestInit), redirect: "manual" } as RequestInit);
          if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
            throw new Error(`redirect blocked for ${url}: ${res.headers.get("location")}`);
          }
          return res;
        };
        transport = new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: cfg.headers ?? {}, redirect: "manual" as RequestRedirect },
          // @ts-ignore — SDK types may not expose fetch yet, but runtime supports it
          fetch: redirectGuardFetch,
        } as unknown as ConstructorParameters<typeof StreamableHTTPClientTransport>[1]);
      } else {
        // stdio: expand placeholders exactly once in args/env values/cwd; command never expanded
        const command = cfg.command!;
        const args = (cfg.args ?? []).map(a => expandPlaceholders(a, pluginRoot, pluginData));
        const envOverlay: Record<string, string> = {};
        if (cfg.env) {
          for (const [ke, ve] of Object.entries(cfg.env)) {
            envOverlay[ke] = expandPlaceholders(ve, pluginRoot, pluginData);
          }
        }
        // Minimal base env + overlay + forced PLUGIN_* last (review)
        const baseEnv: Record<string, string> = {};
        // Use only essentials to avoid leaking secrets via process.env? For now copy PATH-like essentials.
        for (const key of ["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TMPDIR"]) {
          if (process.env[key]) baseEnv[key] = process.env[key]!;
        }
        const finalEnv: Record<string, string> = { ...baseEnv, ...envOverlay, PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: pluginData };

        // cwd: expand once then prove containment under PLUGIN_ROOT or PLUGIN_DATA anchor (spec §7.2.1). Loader only prefix-checks, so enforce here.
        let cwd: string | undefined = pluginRoot;
        if (cfg.cwd) {
          const original = cfg.cwd;
          const expanded = expandPlaceholders(original, pluginRoot, pluginData);
          let resolved: string;
          let anchor: string;
          if (original.startsWith("./")) { anchor = pluginRoot; resolved = path.resolve(pluginRoot, expanded.slice(2)); }
          else if (original === "${PLUGIN_ROOT}" || original.startsWith("${PLUGIN_ROOT}/")) { anchor = pluginRoot; resolved = path.resolve(expanded); }
          else if (original === "${PLUGIN_DATA}" || original.startsWith("${PLUGIN_DATA}/")) { anchor = pluginData; resolved = path.resolve(expanded); }
          else { anchor = pluginRoot; resolved = path.resolve(expanded); }
          if (!isWithinRoot(resolved, anchor)) throw new Error(`cwd escapes ${anchor === pluginRoot ? "PLUGIN_ROOT" : "PLUGIN_DATA"}: ${original} -> ${resolved}`);
          // Also verify realpath containment if path exists
          try { const real = await fsp.realpath(resolved).catch(() => resolved); if (!isWithinRoot(real, anchor)) throw new Error(`cwd realpath escapes: ${real}`); } catch (e) { if ((e as Error).message.includes("escapes")) throw e; }
          cwd = resolved;
        }
        // Also validate ./-prefixed command containment
        if (command.startsWith("./")) {
          const resolvedCmd = path.resolve(pluginRoot, command.slice(2));
          if (!isWithinRoot(resolvedCmd, pluginRoot)) throw new Error(`command escapes plugin root: ${command} -> ${resolvedCmd}`);
        }

        // Resolve bare command via PATH before overlay? For now let StdioClientTransport do it; we resolve with env PATH
        const stdio = new StdioClientTransport({
          command,
          args,
          cwd,
          env: finalEnv,
          stderr: "pipe",
        });
        stdio.stderr?.on("data", (chunk: Buffer) => {
          const msg = chunk.toString("utf8").trim();
          if (msg) this.log.warn(`MCP ${serverId} stderr: ${msg.slice(0, 2000)}`);
        });
        transport = stdio;
      }

      const conn: Connected = { client, transport, tools: [] };
      transport.onerror = (e) => this.log.warn(`MCP ${serverId} error: ${errorText(e)}`);
      transport.onclose = () => { if (this.conns.get(k)?.transport === transport) this.conns.delete(k); };

      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect ${serverId}`);
      conn.tools = await withTimeout(listTools(client), CONNECT_TIMEOUT_MS, `listTools ${serverId}`);
      if (this.closed) throw new Error("closed");
      this.conns.set(k, conn);
      this.failures.delete(k);
      this.log.info(`MCP connected ${pluginId}:${serverId} (${conn.tools.length} tools)`);
      return conn;
    } catch (e) {
      const msg = errorText(e);
      this.failures.set(k, { message: msg, at: Date.now() });
      if (client) try { await withTimeout(client.close(), CLOSE_TIMEOUT_MS, `close ${serverId}`); } catch {}
      this.conns.delete(k);
      throw new Error(msg);
    }
  }

  async listTools(): Promise<CatalogTool[]> {
    const out: CatalogTool[] = [];
    const allServers = this.store.listMcpServers();
    for (const rec of allServers) {
      if (rec.approved !== 1) continue;
      const cfg = parseServerConfig(rec.configJson);
      if (!cfg) continue;
      if (cfg.type === "sse") continue; // unsupported v0
      // Ensure connection if not yet (lazy) — but for list we try to ensure, isolated per-server
      const k = this.key(rec.pluginId, rec.serverId);
      let tools: Tool[] = [];
      const conn = this.conns.get(k);
      if (conn) tools = conn.tools;
      else {
        try {
          const c = await this.ensureServer(rec.pluginId, rec.serverId);
          tools = c?.tools ?? [];
        } catch (e) {
          this.log.warn(`listTools skip ${rec.serverId}: ${errorText(e)}`);
          out.push({
            opaqueId: exposedId(rec.pluginId, rec.serverId, "__error__"),
            pluginId: rec.pluginId,
            pluginName: this.store.getPlugin(rec.pluginId)?.name ?? rec.pluginId,
            serverId: rec.serverId,
            serverType: cfg.type,
            name: `__error_${rec.serverId}`,
            description: `MCP server ${rec.serverId} failed: ${errorText(e)}`,
            inputSchema: { type: "object", properties: {} },
            status: "error",
            error: errorText(e),
          });
          continue;
        }
      }
      const pluginName = this.store.getPlugin(rec.pluginId)?.name ?? rec.pluginId;
      for (const t of tools) {
        out.push({
          opaqueId: exposedId(rec.pluginId, rec.serverId, t.name),
          pluginId: rec.pluginId,
          pluginName,
          serverId: rec.serverId,
          serverType: cfg.type,
          name: t.name,
          description: t.description?.trim() || `Call ${t.name} on ${rec.serverId}`,
          inputSchema: toolSchema(t),
          status: "ready",
        });
      }
    }
    return out;
  }

  async call(opaqueId: string, args: JsonRecord, signal?: AbortSignal): Promise<{ content: JsonRecord[]; isError?: boolean }> {
    const tools = await this.listTools();
    const def = tools.find(t => t.opaqueId === opaqueId);
    if (!def) throw new Error(`Tool not found: ${opaqueId}`);
    if (def.status === "error") throw new Error(def.error ?? "tool in error state");
    const conn = await this.ensureServer(def.pluginId, def.serverId);
    if (!conn) throw new Error(`MCP server unavailable: ${def.serverId}`);
    const toolName = def.name;
    const result = await conn.client.callTool({ name: toolName, arguments: args as Record<string, unknown> }, signal ? { signal } : undefined);
    // Normalize CallToolResult to our shape
    const content = (result as { content?: JsonRecord[] }).content ?? [];
    const isError = (result as { isError?: boolean }).isError;
    return { content: content as JsonRecord[], isError };
  }
}

// Fallback in-memory for testing without MCP spawn
export class InMemoryMcpRuntime implements McpRuntime {
  private tools: CatalogTool[] = [];
  async listTools(): Promise<CatalogTool[]> { return this.tools; }
  async call(_opaqueId: string, _args: JsonRecord, _signal?: AbortSignal): Promise<{ content: JsonRecord[]; isError?: boolean }> {
    return { content: [{ type: "text", text: "MCP runtime not yet implemented (phase 5-6)" } as unknown as JsonRecord], isError: true };
  }
  async startServer(): Promise<void> {}
  async stopServer(): Promise<void> {}
  async status(): Promise<Record<string, string>> { return {}; }
  async close(): Promise<void> {}
  async closeServer(): Promise<void> {}
  setCatalog(tools: CatalogTool[]): void { this.tools = tools; }
}
