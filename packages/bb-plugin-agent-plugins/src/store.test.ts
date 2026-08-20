import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
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

function addPlugin(store: AgentPluginsStore): PluginRecord {
  const plugin: PluginRecord = {
    id: "plugin-1",
    name: "Example Plugin",
    version: "1.0.0",
    description: "A test plugin.",
    specVersion: "1.0.0",
    sourceType: "path",
    sourceIntent: "path:/tmp/example-plugin",
    sourceResolved: "path:/tmp/example-plugin#hash",
    sourceRef: null,
    tagPrefix: null,
    pluginRoot: "/tmp/example-plugin-root",
    pluginData: "/tmp/example-plugin-data",
    activeGen: 1,
    status: "active",
    approval: "approved",
    lastError: null,
    contentHash: "hash",
    installedAt: 1,
    updatedAt: 1,
  };
  store.upsertPlugin(plugin);
  return plugin;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("AgentPluginsStore resource settings", () => {
  it("defaults new skills and MCP servers to enabled and persists independent toggles", () => {
    const store = createStore();
    const plugin = addPlugin(store);

    store.upsertSkill({
      pluginId: plugin.id,
      skillName: "research",
      skillDir: "skills/research",
      frontmatterJson: "{}",
      bodyHash: "skill-hash",
      materializedPath: "/tmp/skills/research",
      status: "active",
      lastError: null,
      enabled: 1,
    });
    store.upsertMcpServer({
      pluginId: plugin.id,
      serverId: "docs",
      type: "stdio",
      configJson: JSON.stringify({ type: "stdio", command: "node" }),
      status: "idle",
      lastError: null,
      approved: 0,
      enabled: 1,
    });

    expect(store.listSkills(plugin.id)[0]?.enabled).toBe(1);
    expect(store.listMcpServers(plugin.id)[0]?.enabled).toBe(1);

    expect(store.setSkillEnabled(plugin.id, "research", false)?.enabled).toBe(0);
    expect(store.setMcpEnabled(plugin.id, "docs", false)?.enabled).toBe(0);
    expect(store.listSkills(plugin.id)[0]?.enabled).toBe(0);
    expect(store.listMcpServers(plugin.id)[0]?.enabled).toBe(0);

    expect(store.setSkillEnabled(plugin.id, "research", true)?.enabled).toBe(1);
    expect(store.setMcpEnabled(plugin.id, "docs", true)?.enabled).toBe(1);
  });
});
