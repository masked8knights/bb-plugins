import { createHash } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import type { Context } from "hono";
import type { ToolboxStore } from "./store";
import { cliResultText, runCliSource, type CliRunResult } from "./cli-runner";
import type {
  CatalogTool,
  CliSourceRecord,
  JsonRecord,
  McpServerRecord,
  SourceSummary,
  ToolDefinition,
} from "./types";

const DEFAULT_INPUT_SCHEMA: JsonRecord = {
  type: "object",
  properties: {},
  additionalProperties: true,
};
const MCP_CLIENT_INFO = { name: "bb-toolbox", version: "0.1.0" };
const MCP_CONNECT_TIMEOUT_MS = 15_000;
const MCP_CLOSE_TIMEOUT_MS = 2_000;
const MCP_RETRY_AFTER_MS = 5_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "");
  return normalized || "tool";
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

export function exposedToolName(sourceId: string, toolName: string, kind: "mcp" | "cli-source"): string {
  return `${kind}_${slug(sourceId)}__${slug(toolName)}_${shortHash(JSON.stringify([kind, sourceId, toolName]))}`;
}

function toolSchema(tool: Tool): JsonRecord {
  return isRecord(tool.inputSchema) && tool.inputSchema.type === "object"
    ? tool.inputSchema
    : DEFAULT_INPUT_SCHEMA;
}

function toolDefinitionFromMcp(source: McpServerRecord, tool: Tool): CatalogTool {
  return {
    name: tool.name,
    remoteName: tool.name,
    exposedName: exposedToolName(source.id, tool.name, "mcp"),
    description: tool.description?.trim() || `Call ${tool.name} on ${source.name}`,
    inputSchema: toolSchema(tool),
    sourceId: source.id,
    sourceName: source.name,
    sourceKind: "mcp",
    status: "ready",
  };
}

const RAW_CLI_INPUT_SCHEMA: JsonRecord = {
  type: "object",
  properties: {
    argv: {
      type: "array",
      items: { type: "string" },
      maxItems: 128,
      description: "Arguments passed directly to the CLI. Do not include shell syntax.",
    },
  },
  required: ["argv"],
  additionalProperties: false,
};

function toolDefinitionFromCliSource(source: CliSourceRecord): CatalogTool {
  return {
    name: source.name,
    exposedName: exposedToolName(source.id, "run", "cli-source"),
    description: source.description || `Run ${source.command} with direct argv arguments.`,
    inputSchema: RAW_CLI_INPUT_SCHEMA,
    sourceId: source.id,
    sourceName: source.name,
    sourceKind: "cli-source",
    status: "ready",
  };
}

interface ConnectedMcp {
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  tools: Tool[];
}

interface SourceFailure {
  message: string;
  at: number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function listTools(client: Client): Promise<Tool[]> {
  const result = await client.listTools();
  return result.tools;
}

export class McpGateway {
  private readonly connections = new Map<string, ConnectedMcp>();
  private readonly connecting = new Map<string, Promise<ConnectedMcp>>();
  private readonly failures = new Map<string, SourceFailure>();
  private closed = false;

  constructor(
    private readonly store: ToolboxStore,
    private readonly log: { info(message: string): void; warn(message: string): void; error(message: string): void },
    private readonly cliOptions: { timeoutMs: number; maxOutputBytes: number },
  ) {}

  async close(): Promise<void> {
    this.closed = true;
    const pending = [...this.connecting.values()];
    await Promise.allSettled(pending);
    const connections = [...this.connections.entries()];
    this.connections.clear();
    this.failures.clear();
    await Promise.all(
      connections.map(async ([id, connection]) => {
        try {
          await connection.client.close();
        } catch (error) {
          this.log.warn(`Failed to close MCP source ${id}: ${errorText(error)}`);
        }
      }),
    );
  }

  async closeSource(id: string): Promise<void> {
    const pending = this.connecting.get(id);
    if (pending) {
      try {
        await pending;
      } catch {
        // The connection attempt has already recorded its failure.
      }
    }
    const connection = this.connections.get(id);
    this.connections.delete(id);
    this.failures.delete(id);
    if (!connection) return;
    try {
      await connection.client.close();
    } catch (error) {
      this.log.warn(`Failed to close MCP source ${id}: ${errorText(error)}`);
    }
  }

  async refreshSource(id: string): Promise<SourceSummary> {
    if (!this.store.getMcpServer(id)) throw new Error(`MCP source not found: ${id}`);
    await this.closeSource(id);
    await this.ensureSource(id);
    return (await this.sourceSummaries()).find((source) => source.id === id)!;
  }

  async ensureSource(id: string): Promise<ConnectedMcp | null> {
    if (this.closed) throw new Error("MCP gateway is closed");
    const current = this.connections.get(id);
    if (current) return current;
    const pending = this.connecting.get(id);
    if (pending) return pending;

    const source = this.store.getMcpServer(id);
    if (!source || !source.enabled) return null;

    const failure = this.failures.get(id);
    if (failure && Date.now() - failure.at < MCP_RETRY_AFTER_MS) {
      throw new Error(failure.message);
    }

    const connectionPromise = this.connectSource(source);
    this.connecting.set(id, connectionPromise);
    try {
      return await connectionPromise;
    } finally {
      if (this.connecting.get(id) === connectionPromise) this.connecting.delete(id);
    }
  }

  private async connectSource(source: McpServerRecord): Promise<ConnectedMcp> {
    let client: Client | undefined;
    try {
      client = new Client(MCP_CLIENT_INFO, {
        versionNegotiation: { mode: "auto" },
      });
      let transport: ConnectedMcp["transport"];
      if (source.transport === "http") {
        transport = new StreamableHTTPClientTransport(new URL(source.url!), {
          requestInit: { headers: source.headers },
        });
      } else {
        const stdioTransport = new StdioClientTransport({
          command: source.command!,
          args: source.args,
          cwd: source.cwd ?? undefined,
          env: Object.keys(source.env).length ? { ...process.env, ...source.env } as Record<string, string> : undefined,
          stderr: "pipe",
        });
        stdioTransport.stderr?.on("data", (chunk: Buffer) => {
          const message = chunk.toString("utf8").trim();
          if (message) this.log.warn(`MCP source ${source.name} stderr: ${message}`);
        });
        transport = stdioTransport;
      }
      const connection: ConnectedMcp = { client, transport, tools: [] };
      transport.onerror = (error) => {
        this.log.warn(`MCP source ${source.name} reported an error: ${errorText(error)}`);
      };
      transport.onclose = () => {
        if (this.connections.get(source.id)?.transport === transport) this.connections.delete(source.id);
      };
      await withTimeout(client.connect(transport), MCP_CONNECT_TIMEOUT_MS, `Connecting to MCP source ${source.name}`);
      connection.tools = await withTimeout(listTools(client), MCP_CONNECT_TIMEOUT_MS, `Listing tools from ${source.name}`);
      if (this.closed) throw new Error("MCP gateway is closed");
      this.connections.set(source.id, connection);
      this.failures.delete(source.id);
      this.log.info(`Connected to MCP source ${source.name} (${connection.tools.length} tools)`);
      return connection;
    } catch (error) {
      const message = errorText(error);
      this.failures.set(source.id, { message, at: Date.now() });
      if (client) {
        try {
          await withTimeout(client.close(), MCP_CLOSE_TIMEOUT_MS, `Closing MCP source ${source.name}`);
        } catch (closeError) {
          this.log.warn(`Failed to close MCP source ${source.name}: ${errorText(closeError)}`);
        }
      }
      this.connections.delete(source.id);
      this.failures.set(source.id, { message, at: Date.now() });
      throw new Error(message);
    }
  }

  async catalog(options: { connect?: boolean } = {}): Promise<CatalogTool[]> {
    const connect = options.connect ?? true;
    const tools: CatalogTool[] = [];
    for (const source of this.store.listMcpServers()) {
      if (!source.enabled) continue;
      try {
        const connection = connect ? await this.ensureSource(source.id) : this.connections.get(source.id);
        for (const tool of connection?.tools ?? []) tools.push(toolDefinitionFromMcp(source, tool));
      } catch (error) {
        this.log.warn(`Unable to load tools from ${source.name}: ${errorText(error)}`);
      }
    }
    for (const source of this.store.listCliSources()) {
      if (source.enabled) tools.push(toolDefinitionFromCliSource(source));
    }
    return tools;
  }

  async sourceSummaries(): Promise<SourceSummary[]> {
    const summaries: SourceSummary[] = [];
    for (const source of this.store.listMcpServers()) {
      let status: SourceSummary["status"] = source.enabled ? "idle" : "disabled";
      let lastError: string | null = null;
      let toolCount = 0;
      if (source.enabled) {
        const connection = this.connections.get(source.id);
        const failure = this.failures.get(source.id);
        if (connection) {
          status = "ready";
          toolCount = connection.tools.length;
        } else if (failure) {
          status = "error";
          lastError = failure.message;
        }
      }
      summaries.push({
        id: source.id,
        name: source.name,
        description: source.description,
        transport: source.transport,
        endpoint: source.url,
        command: source.command,
        args: source.args,
        cwd: source.cwd,
        enabled: source.enabled,
        hasHeaders: Object.keys(source.headers).length > 0,
        hasEnv: Object.keys(source.env).length > 0,
        toolCount,
        status,
        lastError,
        updatedAt: source.updatedAt,
      });
    }
    return summaries;
  }

  cliSourceSummaries() {
    return this.store.listCliSources().map((source) => ({
      id: source.id,
      name: source.name,
      description: source.description,
      command: source.command,
      cwd: source.cwd,
      enabled: source.enabled,
      hasEnv: Object.keys(source.env).length > 0,
      status: source.enabled ? ("ready" as const) : ("disabled" as const),
      updatedAt: source.updatedAt,
    }));
  }

  async runCliSource(sourceId: string, args: unknown, signal?: AbortSignal): Promise<CliRunResult> {
    const source = this.store.getCliSource(sourceId);
    if (!source) throw new Error(`CLI source not found: ${sourceId}`);
    if (!source.enabled) throw new Error(`CLI source is disabled: ${source.name}`);
    return runCliSource(source, args, { ...this.cliOptions, signal });
  }

  async call(exposedName: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const tools = await this.catalog();
    const definition = tools.find((tool) => tool.exposedName === exposedName);
    if (!definition) throw new Error(`Tool not found: ${exposedName}`);
    if (definition.sourceKind === "cli-source") {
      const result = await this.runCliSource(definition.sourceId, args, signal);
      return {
        content: [{ type: "text", text: cliResultText(result) }],
        isError: result.exitCode !== 0,
      };
    }
    const connection = await this.ensureSource(definition.sourceId);
    if (!connection || !definition.remoteName) throw new Error(`MCP source is unavailable: ${definition.sourceId}`);
    return connection.client.callTool({
      name: definition.remoteName,
      arguments: isRecord(args) ? args : {},
    }, { signal });
  }

  async listForAgent(): Promise<CatalogTool[]> {
    return this.catalog({ connect: false });
  }

  createHttpHandler(): McpHttpHandler {
    const handler = createMcpHandler(
      async () => {
        const server = new McpServer({ name: "bb-toolbox", version: "0.1.0" });
        const tools = await this.catalog();
        for (const tool of tools) {
          server.registerTool(
            tool.exposedName,
            {
              title: tool.name,
              description: tool.description,
              inputSchema: fromJsonSchema(tool.inputSchema as Parameters<typeof fromJsonSchema>[0]),
            },
            async (args, context) => {
              try {
                return await this.call(tool.exposedName, args, context.mcpReq.signal);
              } catch (error) {
                return {
                  content: [{ type: "text", text: errorText(error) }],
                  isError: true,
                };
              }
            },
          );
        }
        return server;
      },
      {
        responseMode: "auto",
        legacy: "stateless",
        onerror: (error) => this.log.error(`MCP proxy request failed: ${errorText(error)}`),
      },
    );
    return handler;
  }

  async handleHttp(context: Context): Promise<Response> {
    return (await this.createHttpHandler()).fetch(context.req.raw);
  }
}
