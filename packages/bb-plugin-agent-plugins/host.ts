import { experimental_defineHostEntry, type ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";
import {
  Client,
  type ClientCapabilities,
  type ClientOptions,
  type Prompt,
  type Resource,
  type ResourceTemplateType,
  type Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mcpHostContract, mcpHostSignals, type McpHostCatalog } from "./src/host-contract.js";
import { optionalMcpCall } from "./src/mcp-compat.js";

const CONNECT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 2_000;
const MCP_CLIENT_INFO = { name: "bb-agent-plugins-stdio", version: "0.2.2" };

type HostConnection = {
  key: string;
  client: Client;
  transport: StdioClientTransport;
  catalog: McpHostCatalog;
  expectedClose: boolean;
  lease: { dispose(): Promise<void> };
};

const connections = new Map<string, HostConnection>();

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function records(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => asRecord(item) !== null);
}

function catalogFromValues(values: {
  tools: Tool[];
  prompts: Prompt[];
  resources: Resource[];
  resourceTemplates: ResourceTemplateType[];
}): McpHostCatalog {
  return {
    tools: records(values.tools),
    prompts: records(values.prompts),
    resources: records(values.resources),
    resourceTemplates: records(values.resourceTemplates),
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("MCP host request cancelled");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => void): Promise<T> {
  if (signal.aborted) {
    onAbort();
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("MCP host request cancelled"));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", handleAbort);
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      onAbort();
      reject(signal.reason instanceof Error ? signal.reason : new Error("MCP host request cancelled"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then((value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

async function closeWithTimeout(connection: HostConnection, signal?: AbortSignal): Promise<void> {
  connection.expectedClose = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const closePromise = Promise.race([
      connection.client.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("MCP stdio close timed out")), CLOSE_TIMEOUT_MS);
      }),
    ]);
    if (signal) {
      await abortable(closePromise, signal, () => { void connection.client.close().catch(() => {}); });
    } else {
      await closePromise;
    }
  } catch {
    // The daemon owns the worker process. If an SDK close stalls, returning
    // lets the worker supervisor reap the isolated process and its child.
  } finally {
    if (timer) clearTimeout(timer);
    await connection.lease.dispose().catch(() => {});
  }
}

async function refresh(connection: HostConnection, signal: AbortSignal): Promise<McpHostCatalog> {
  throwIfAborted(signal);
  const options = { signal, timeout: REQUEST_TIMEOUT_MS, cacheMode: "refresh" as const };
  const [tools, prompts, resources, resourceTemplates] = await Promise.all([
    optionalMcpCall(() => connection.client.listTools(undefined, options), { tools: [] }),
    optionalMcpCall(() => connection.client.listPrompts(undefined, options), { prompts: [] }),
    optionalMcpCall(() => connection.client.listResources(undefined, options), { resources: [] }),
    optionalMcpCall(() => connection.client.listResourceTemplates(undefined, options), { resourceTemplates: [] }),
  ]);
  throwIfAborted(signal);
  connection.catalog = catalogFromValues({
    tools: tools.tools,
    prompts: prompts.prompts,
    resources: resources.resources,
    resourceTemplates: resourceTemplates.resourceTemplates,
  });
  return connection.catalog;
}

function createClient(key: string, context: ExperimentalHostRpcContext<typeof mcpHostSignals>): Client {
  const capabilities: ClientCapabilities = {};
  const clientOptions: ClientOptions = {
    capabilities,
    versionNegotiation: { mode: "auto" },
    listChanged: {
      tools: { autoRefresh: true, onChanged: (error) => void emitCatalogChanged(context, key, "tools", error) },
      prompts: { autoRefresh: true, onChanged: (error) => void emitCatalogChanged(context, key, "prompts", error) },
      resources: { autoRefresh: true, onChanged: (error) => void emitCatalogChanged(context, key, "resources", error) },
    },
  };
  return new Client(MCP_CLIENT_INFO, clientOptions);
}

async function emitCatalogChanged(
  context: ExperimentalHostRpcContext<typeof mcpHostSignals>,
  key: string,
  kind: "tools" | "prompts" | "resources",
  error: Error | null,
): Promise<void> {
  await context.experimental_emitSignal("catalogChanged", { key, kind, error: error ? errorText(error) : null }).catch(() => {});
}

async function connectionFor(key: string, signal: AbortSignal): Promise<HostConnection> {
  throwIfAborted(signal);
  const connection = connections.get(key);
  if (!connection) throw new Error(`MCP stdio connection not found: ${key}`);
  return connection;
}

async function closeKey(key: string, signal?: AbortSignal): Promise<boolean> {
  if (signal) throwIfAborted(signal);
  const connection = connections.get(key);
  if (!connection) return false;
  connections.delete(key);
  await closeWithTimeout(connection, signal);
  return true;
}

async function start(input: {
  key: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}, context: ExperimentalHostRpcContext<typeof mcpHostSignals>): Promise<McpHostCatalog> {
  throwIfAborted(context.signal);
  const existing = connections.get(input.key);
  if (existing) return existing.catalog;

  const lease = context.experimental_retainWorker();
  const client = createClient(input.key, context);
  const transport = new StdioClientTransport({
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => {
    const message = chunk.toString("utf8").trim();
    if (message) console.warn(`[agent-plugins] MCP ${input.key} stderr: ${message.slice(0, 2000)}`);
  });

  const connection: HostConnection = {
    key: input.key,
    client,
    transport,
    catalog: { tools: [], prompts: [], resources: [], resourceTemplates: [] },
    expectedClose: false,
    lease,
  };
  connections.set(input.key, connection);
  transport.onclose = () => {
    if (connection.expectedClose || connections.get(input.key) !== connection) return;
    connections.delete(input.key);
    void context.experimental_emitSignal("connectionChanged", {
      key: input.key,
      status: "closed",
      error: "MCP stdio transport closed unexpectedly",
    }).catch(() => {});
    void lease.dispose().catch(() => {});
  };
  transport.onerror = (error) => {
    void context.experimental_emitSignal("connectionChanged", {
      key: input.key,
      status: "error",
      error: errorText(error),
    }).catch(() => {});
  };

  try {
    await abortable(
      client.connect(transport, { signal: context.signal, timeout: CONNECT_TIMEOUT_MS }),
      context.signal,
      () => { void client.close().catch(() => {}); },
    );
    return await refresh(connection, context.signal);
  } catch (error) {
    connections.delete(input.key);
    await closeWithTimeout(connection);
    throw new Error(errorText(error));
  }
}

async function withConnection<T>(
  input: { key: string },
  context: ExperimentalHostRpcContext<typeof mcpHostSignals>,
  operation: (connection: HostConnection) => Promise<T>,
): Promise<T> {
  const connection = await connectionFor(input.key, context.signal);
  return operation(connection);
}

async function closeAll(): Promise<void> {
  const values = [...connections.values()];
  connections.clear();
  await Promise.all(values.map((connection) => closeWithTimeout(connection)));
}

export default experimental_defineHostEntry({
  contract: mcpHostContract,
  experimental_signals: mcpHostSignals,
  handlers: {
    start: (input, context) => start(input, context),
    refresh: async ({ key }, context) => withConnection({ key }, context, (connection) => refresh(connection, context.signal)),
    close: async ({ key }, context) => ({ closed: await closeKey(key, context.signal) }),
    callTool: async ({ key, name, args, toolDefinition }, context) => withConnection({ key }, context, async (connection) => {
      const result = await connection.client.callTool(
        { name, arguments: args },
        { signal: context.signal, timeout: REQUEST_TIMEOUT_MS, ...(toolDefinition ? { toolDefinition: toolDefinition as Tool } : {}) },
      );
      return asRecord(result) ?? {};
    }),
    getPrompt: async ({ key, name, args }, context) => withConnection({ key }, context, async (connection) => {
      const result = await connection.client.getPrompt({ name, arguments: Object.fromEntries(Object.entries(args).map(([arg, value]) => [arg, String(value)])) }, { signal: context.signal, timeout: REQUEST_TIMEOUT_MS });
      return asRecord(result) ?? {};
    }),
    readResource: async ({ key, uri }, context) => withConnection({ key }, context, async (connection) => {
      const result = await connection.client.readResource({ uri }, { signal: context.signal, timeout: REQUEST_TIMEOUT_MS, cacheMode: "bypass" });
      return asRecord(result) ?? {};
    }),
    complete: async ({ key, ref, argument }, context) => withConnection({ key }, context, async (connection) => {
      const result = await connection.client.complete({ ref: ref as never, argument: argument as never }, { signal: context.signal, timeout: REQUEST_TIMEOUT_MS });
      return asRecord(result) ?? {};
    }),
    subscribeResource: async ({ key, uri }, context) => withConnection({ key }, context, async (connection) => {
      await connection.client.subscribeResource({ uri }, { signal: context.signal, timeout: REQUEST_TIMEOUT_MS });
      return { subscribed: true };
    }),
    unsubscribeResource: async ({ key, uri }, context) => withConnection({ key }, context, async (connection) => {
      await connection.client.unsubscribeResource({ uri }, { signal: context.signal, timeout: REQUEST_TIMEOUT_MS });
      return { unsubscribed: true };
    }),
    setLoggingLevel: async ({ key, level }, context) => withConnection({ key }, context, async (connection) => {
      await connection.client.setLoggingLevel(level as never, { signal: context.signal, timeout: REQUEST_TIMEOUT_MS });
      return { updated: true };
    }),
  },
  dispose: closeAll,
});
