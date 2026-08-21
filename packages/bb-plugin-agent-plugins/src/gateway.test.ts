import * as http from "node:http";
import { once } from "node:events";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { McpGateway, redirectGuardFetch } from "./gateway.js";
import { AgentPluginsStore } from "./store.js";
import type { PluginRecord } from "./types.js";

const databases: Database.Database[] = [];
const servers: http.Server[] = [];

function createStore(): AgentPluginsStore {
  const database = new Database(":memory:");
  databases.push(database);
  return new AgentPluginsStore(database, (db, statements) => {
    for (const statement of statements) db.exec(statement);
  });
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const server of servers.splice(0)) server.close();
});

describe("McpGateway resource settings", () => {
  it("does not expose disabled approved servers to the tool catalog", async () => {
    const store = createStore();
    const plugin: PluginRecord = {
      id: "plugin-1",
      name: "Example Plugin",
      version: null,
      description: null,
      specVersion: "1.0.0",
      sourceType: "path",
      sourceIntent: "path:/tmp/example-plugin",
      sourceResolved: null,
      sourceRef: null,
      tagPrefix: null,
      pluginRoot: "/tmp/example-plugin-root",
      pluginData: "/tmp/example-plugin-data",
      activeGen: 1,
      status: "active",
      approval: "approved",
      lastError: null,
      contentHash: null,
      installedAt: 1,
      updatedAt: 1,
    };
    store.upsertPlugin(plugin);
    store.upsertMcpServer({
      pluginId: plugin.id,
      serverId: "disabled-server",
      type: "stdio",
      configJson: JSON.stringify({ type: "stdio", command: "not-started" }),
      status: "idle",
      lastError: null,
      approved: 1,
      enabled: 0,
    });

    const gateway = new McpGateway(store, {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
    expect(await gateway.listTools()).toEqual([]);
    await gateway.close();
  });

  it("persists a connection failure for an enabled approved server", async () => {
    const store = createStore();
    const plugin: PluginRecord = {
      id: "plugin-2",
      name: "Broken Plugin",
      version: null,
      description: null,
      specVersion: "1.0.0",
      sourceType: "path",
      sourceIntent: "path:/tmp/broken-plugin",
      sourceResolved: null,
      sourceRef: null,
      tagPrefix: null,
      pluginRoot: "/tmp/broken-plugin-root",
      pluginData: "/tmp/broken-plugin-data",
      activeGen: 1,
      status: "active",
      approval: "approved",
      lastError: null,
      contentHash: null,
      installedAt: 1,
      updatedAt: 1,
    };
    store.upsertPlugin(plugin);
    store.upsertMcpServer({
      pluginId: plugin.id,
      serverId: "broken-server",
      type: "stdio",
      configJson: JSON.stringify({ type: "stdio", command: "bb-agent-plugins-command-that-does-not-exist" }),
      status: "idle",
      lastError: null,
      approved: 1,
      enabled: 1,
    });

    const gateway = new McpGateway(store, {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
    await expect(gateway.startServer(plugin.id, "broken-server")).rejects.toThrow();
    const record = store.listMcpServers(plugin.id)[0]!;
    expect(record.status).toBe("error");
    expect(record.lastError).toBeTruthy();
    await gateway.close();
  });

  it("keeps fixed headers on legacy SSE session posts without leaking them to OAuth endpoints", async () => {
    const seen: Record<string, string | undefined>[] = [];
    const server = http.createServer((request, response) => {
      const fixed = request.headers["x-fixed"];
      seen.push({ path: request.url, fixed: typeof fixed === "string" ? fixed : undefined });
      response.writeHead(200);
      response.end("ok");
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const guarded = redirectGuardFetch(new URL(`${base}/sse`), { "X-Fixed": "secret" });

    await guarded(`${base}/messages?session=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
    });
    await guarded(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "BB Agent Plugins" }),
    });
    await guarded(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code",
    });
    await guarded(`${base}/sse`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    await guarded(`${base}/sse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "BB Agent Plugins" }),
    });
    await guarded(`${base}/sse`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code",
    });
    await guarded(`${base}/sse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" }),
    });
    await guarded(`${base}/sse`, { method: "DELETE" });

    expect(seen).toEqual([
      { path: "/messages?session=1", fixed: "secret" },
      { path: "/register", fixed: undefined },
      { path: "/token", fixed: undefined },
      { path: "/sse", fixed: undefined },
      { path: "/sse", fixed: undefined },
      { path: "/sse", fixed: undefined },
      { path: "/sse", fixed: "secret" },
      { path: "/sse", fixed: "secret" },
    ]);
  });

  it("bounds stalled OAuth and MCP HTTP requests", async () => {
    const server = http.createServer((_request, _response) => {
      // Leave the response open; the guard must abort the fetch itself.
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const guarded = redirectGuardFetch(new URL(`http://127.0.0.1:${port}/mcp`), undefined, 30);

    await expect(guarded(`http://127.0.0.1:${port}/mcp`)).rejects.toThrow(/timed out|aborted/i);
  });
});
