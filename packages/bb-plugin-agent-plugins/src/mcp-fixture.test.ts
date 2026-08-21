import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { McpGateway, type McpStdioHost } from "./gateway.js";
import { AgentPluginsStore } from "./store.js";
import type { PluginRecord } from "./types.js";

const databases: Database.Database[] = [];
const tempDirs: string[] = [];

function createStore(): AgentPluginsStore {
  const database = new Database(":memory:");
  databases.push(database);
  return new AgentPluginsStore(database, (db, statements) => {
    for (const statement of statements) db.exec(statement);
  });
}

function addPlugin(store: AgentPluginsStore, id = "fixture-plugin"): PluginRecord {
  const plugin: PluginRecord = {
    id,
    name: "Fixture Plugin",
    version: "1.0.0",
    description: "MCP fixture",
    specVersion: "1.0.0",
    sourceType: "path",
    sourceIntent: "path:/tmp/fixture-plugin",
    sourceResolved: null,
    sourceRef: null,
    tagPrefix: null,
    pluginRoot: "/tmp/fixture-plugin-root",
    pluginData: "/tmp/fixture-plugin-data",
    activeGen: 1,
    status: "active",
    approval: "approved",
    lastError: null,
    contentHash: null,
    installedAt: 1,
    updatedAt: 1,
  };
  store.upsertPlugin(plugin);
  return plugin;
}

const FIXTURE = String.raw`
let buffer = "";
function send(id, result, error) {
  const message = { jsonrpc: "2.0", id };
  if (error) message.error = error; else message.result = result;
  process.stdout.write(JSON.stringify(message) + "\n");
}
function handle(message) {
  if (message.id === undefined) return;
  const method = message.method;
  if (method === "initialize") {
    send(message.id, {
      protocolVersion: message.params && message.params.protocolVersion || "2025-11-25",
      capabilities: { tools: { listChanged: true }, prompts: { listChanged: true }, resources: { subscribe: true, listChanged: true }, completions: {} },
      serverInfo: { name: "fixture", version: "1.0.0" },
      instructions: "fixture instructions"
    });
    return;
  }
  if (method === "tools/list") {
    send(message.id, { tools: [{ name: "echo", title: "Echo", description: "Echo a value", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, outputSchema: { type: "object", properties: { value: { type: "string" } } }, annotations: { readOnlyHint: true }, _meta: { "fixture/tool": true } }] });
    if (process.argv.includes("--exit-after-list")) setTimeout(() => process.exit(0), 1000);
    return;
  }
  if (method === "tools/call") {
    send(message.id, { content: [{ type: "text", text: "echoed" }], structuredContent: { value: "echoed" }, _meta: { "fixture/call": true } });
    return;
  }
  if (method === "prompts/list") {
    send(message.id, { prompts: [{ name: "greeting", title: "Greeting", description: "A greeting", arguments: [{ name: "name", description: "Name", required: true }], _meta: { "fixture/prompt": true } }] });
    return;
  }
  if (method === "prompts/get") {
    send(message.id, { description: "A greeting", messages: [{ role: "user", content: { type: "text", text: "Hello" } }], _meta: { "fixture/prompt-result": true } });
    return;
  }
  if (method === "resources/list") {
    send(message.id, { resources: [{ uri: "fixture://readme", name: "readme", title: "Readme", description: "Fixture readme", mimeType: "text/plain", _meta: { "fixture/resource": true } }] });
    return;
  }
  if (method === "resources/templates/list") {
    if (process.argv.includes("--no-resource-templates")) {
      send(message.id, undefined, { code: -32601, message: "Method not found" });
      return;
    }
    send(message.id, { resourceTemplates: [{ uriTemplate: "fixture://item/{id}", name: "item", description: "Fixture item", mimeType: "text/plain" }] });
    return;
  }
  if (method === "resources/read") {
    send(message.id, { contents: [{ uri: message.params.uri, mimeType: "text/plain", text: "fixture content" }], _meta: { "fixture/read": true } });
    return;
  }
  if (method === "completion/complete") {
    send(message.id, { completion: { values: ["one", "two"], total: 2, hasMore: false }, _meta: { refType: message.params && message.params.ref && message.params.ref.type, hasPluginId: Boolean(message.params && message.params.ref && message.params.ref.pluginId) } });
    return;
  }
  if (method === "logging/setLevel") { send(message.id, {}); return; }
  if (method === "resources/subscribe" || method === "resources/unsubscribe") { send(message.id, {}); return; }
  send(message.id, undefined, { code: -32601, message: "Method not found" });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
`;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of tempDirs.splice(0)) void import("node:fs/promises").then((fs) => fs.rm(directory, { recursive: true, force: true }));
});

describe("official MCP gateway integration", () => {
  it("forwards tools, prompts, resources, completions, metadata, and structured results", async () => {
    const store = createStore();
    const plugin = addPlugin(store);
    store.upsertPlugin({ ...plugin, pluginRoot: "/tmp", pluginData: "/tmp" });
    const warnings: string[] = [];
    const gateway = new McpGateway(store, { info() {}, warn(message) { warnings.push(message); }, error() {} });
    store.upsertMcpServer({
      pluginId: plugin.id,
      serverId: "fixture",
      type: "stdio",
      configJson: JSON.stringify({ type: "stdio", command: "node", args: ["-e", FIXTURE] }),
      status: "idle",
      lastError: null,
      approved: 1,
      enabled: 1,
    });

    const tools = await gateway.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name, warnings.join("\n")).toBe("echo");
    expect(tools[0]?.outputSchema).toEqual(expect.objectContaining({ type: "object" }));
    expect(tools[0]?.annotations).toEqual({ readOnlyHint: true });

    const call = await gateway.call(tools[0]!.opaqueId, { value: "hello" });
    expect(call.content).toEqual([{ type: "text", text: "echoed" }]);
    expect(call.structuredContent).toEqual({ value: "echoed" });
    expect(call._meta).toEqual({ "fixture/call": true });

    const prompts = await gateway.listPrompts();
    expect(prompts[0]?.name).toBe("greeting");
    expect(await gateway.getPrompt(prompts[0]!.opaqueId, { name: "BB" })).toEqual(expect.objectContaining({ messages: expect.any(Array) }));

    const resources = await gateway.listResources();
    expect(resources[0]?.uri).toBe("fixture://readme");
    expect(await gateway.readResource(resources[0]!.opaqueId)).toEqual(expect.objectContaining({ contents: expect.any(Array) }));

    const templates = await gateway.listResourceTemplates();
    expect(templates[0]?.uriTemplate).toBe("fixture://item/{id}");
    expect(await gateway.complete({ pluginId: plugin.id, serverId: "fixture", type: "ref/resource", uri: "fixture://readme" }, { name: "id", value: "1" })).toEqual(expect.objectContaining({ completion: expect.any(Object), _meta: { refType: "ref/resource", hasPluginId: false } }));
    expect(await gateway.complete({ type: "ref/resource", uri: "fixture://item/{id}" }, { name: "id", value: "1" })).toEqual(expect.objectContaining({ completion: expect.any(Object), _meta: { refType: "ref/resource", hasPluginId: false } }));
    await gateway.subscribeResource(resources[0]!.opaqueId);
    await gateway.unsubscribeResource(resources[0]!.opaqueId);
    await gateway.setLoggingLevel("info");
    expect(store.listMcpServers(plugin.id)[0]?.status).toBe("ready");
    await gateway.close();
  }, 30_000);

  it("keeps an enabled SSE record in the supported transport path", () => {
    const store = createStore();
    const plugin = addPlugin(store, "sse-plugin");
    store.upsertMcpServer({
      pluginId: plugin.id,
      serverId: "legacy",
      type: "sse",
      configJson: JSON.stringify({ type: "sse", url: "http://127.0.0.1:9/sse" }),
      status: "idle",
      lastError: null,
      approved: 0,
      enabled: 1,
    });
    expect(store.listMcpServers(plugin.id)[0]?.type).toBe("sse");
  });

  it("uses the isolated stdio boundary once and serves repeated catalog reads from cache", async () => {
    const store = createStore();
    const plugin = addPlugin(store, "isolated-plugin");
    store.upsertMcpServer({
      pluginId: plugin.id,
      serverId: "isolated",
      type: "stdio",
      configJson: JSON.stringify({ type: "stdio", command: "node" }),
      status: "idle",
      lastError: null,
      approved: 1,
      enabled: 1,
    });
    const catalog = {
      tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
      prompts: [],
      resources: [],
      resourceTemplates: [],
    };
    const host = {
      start: async () => catalog,
      refresh: async () => catalog,
      close: async () => undefined,
      callTool: async () => ({ content: [{ type: "text", text: "isolated" }] }),
      getPrompt: async () => ({}),
      readResource: async () => ({}),
      complete: async () => ({}),
      subscribeResource: async () => undefined,
      unsubscribeResource: async () => undefined,
      setLoggingLevel: async () => undefined,
    } as unknown as McpStdioHost;
    const start = vi.fn(host.start);
    const close = vi.fn(host.close);
    host.start = start;
    host.close = close;
    const gateway = new McpGateway(store, { info() {}, warn() {}, error() {} }, { stdioHost: host });

    const first = await gateway.listTools();
    const second = await gateway.listTools();
    expect(first[0]?.name).toBe("echo");
    expect(second[0]?.opaqueId).toBe(first[0]?.opaqueId);
    expect(start).toHaveBeenCalledTimes(1);

    const call = await gateway.call(first[0]!.opaqueId, {});
    expect(call.content).toEqual([{ type: "text", text: "isolated" }]);
    await gateway.closeServer(plugin.id, "isolated");
    expect(close).toHaveBeenCalledTimes(1);
    await gateway.close();
  });

  it("keeps an authenticated server ready when an optional catalog method is absent", async () => {
    const store = createStore();
    const plugin = addPlugin(store, "optional-catalog-plugin");
    store.upsertPlugin({ ...plugin, pluginRoot: "/tmp", pluginData: "/tmp" });
    store.upsertMcpServer({
      pluginId: plugin.id,
      serverId: "fastmail-like",
      type: "stdio",
      configJson: JSON.stringify({ type: "stdio", command: "node", args: ["-e", FIXTURE, "--", "--no-resource-templates"] }),
      status: "idle",
      lastError: null,
      approved: 1,
      enabled: 1,
    });
    const gateway = new McpGateway(store, { info() {}, warn() {}, error() {} });

    expect(await gateway.listTools()).toHaveLength(1);
    expect(await gateway.listResourceTemplates()).toEqual([]);
    expect(store.listMcpServers(plugin.id)[0]).toMatchObject({ status: "ready", lastError: null });
    await gateway.close();
  }, 15_000);

  it("persists an unexpected transport close as an actionable error", async () => {
    const store = createStore();
    const plugin = addPlugin(store, "close-plugin");
    store.upsertPlugin({ ...plugin, pluginRoot: "/tmp", pluginData: "/tmp" });
    store.upsertMcpServer({
      pluginId: plugin.id,
      serverId: "closing",
      type: "stdio",
      configJson: JSON.stringify({ type: "stdio", command: "node", args: ["-e", FIXTURE, "--", "--exit-after-list"] }),
      status: "idle",
      lastError: null,
      approved: 1,
      enabled: 1,
    });
    const gateway = new McpGateway(store, { info() {}, warn() {}, error() {} });
    await gateway.startServer(plugin.id, "closing");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(store.listMcpServers(plugin.id)[0]?.status).toBe("error");
    expect(store.listMcpServers(plugin.id)[0]?.lastError).toContain("closed unexpectedly");
    await gateway.close();
  }, 30_000);
});
