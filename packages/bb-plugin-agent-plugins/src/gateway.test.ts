import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { McpGateway } from "./gateway.js";
import { AgentPluginsStore } from "./store.js";
import type { PluginRecord } from "./types.js";

const databases: Database.Database[] = [];

function createStore(): AgentPluginsStore {
  const database = new Database(":memory:");
  databases.push(database);
  return new AgentPluginsStore(database, (db, statements) => {
    for (const statement of statements) db.exec(statement);
  });
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
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
});
