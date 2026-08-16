import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ToolboxStore } from "./store";

function makeStore() {
  const db = new Database(":memory:");
  const store = new ToolboxStore(db, (database, statements) => {
    let version = Number(database.pragma("user_version", { simple: true }));
    for (const statement of statements.slice(version)) {
      database.exec(statement);
      version += 1;
      database.pragma(`user_version = ${version}`);
    }
  });
  return { db, store };
}

describe("ToolboxStore", () => {
  it("round-trips MCP and CLI definitions", () => {
    const { db, store } = makeStore();
    const mcp = store.upsertMcp({
      name: "Docs MCP",
      description: "Documentation tools",
      transport: "stdio",
      command: "node",
      args: ["server.mjs"],
      cwd: "/tmp/docs",
      env: { API_KEY: "secret" },
      enabled: true,
    });
    const cli = store.upsertCli({
      name: "pr_view",
      description: "View a pull request",
      command: "gh",
      argsTemplate: ["pr", "view", "{{number}}"],
      inputSchema: { type: "object", properties: { number: { type: "integer" } } },
      cwd: "/tmp/repo",
      env: { GH_TOKEN: "secret" },
      enabled: true,
    });
    const source = store.upsertCliSource({
      name: "bird",
      description: "Twitter CLI",
      command: "bird",
      cwd: "/tmp/social",
      env: { NO_COLOR: "1" },
      enabled: true,
    });

    expect(store.getMcpServer(mcp.id)).toMatchObject({
      name: "Docs MCP",
      transport: "stdio",
      args: ["server.mjs"],
      env: { API_KEY: "secret" },
    });
    expect(store.getCliTool(cli.id)).toMatchObject({
      name: "pr_view",
      argsTemplate: ["pr", "view", "{{number}}"],
      inputSchema: expect.objectContaining({ type: "object" }),
    });
    expect(store.getCliSource(source.id)).toMatchObject({
      name: "bird",
      command: "bird",
      env: { NO_COLOR: "1" },
    });

    store.deleteMcp(mcp.id);
    store.deleteCli(cli.id);
    store.deleteCliSource(source.id);
    expect(store.listMcpServers()).toHaveLength(0);
    expect(store.listCliTools()).toHaveLength(0);
    expect(store.listCliSources()).toHaveLength(0);
    db.close();
  });

  it("updates an existing record without changing its id", () => {
    const { db, store } = makeStore();
    const created = store.upsertCli({
      name: "echo",
      description: "Echo text",
      command: "printf",
      argsTemplate: ["{{text}}"],
      inputSchema: { type: "object" },
      enabled: true,
    });
    const updated = store.upsertCli({
      id: created.id,
      name: "echo_text",
      description: "Echo text twice",
      command: "printf",
      argsTemplate: ["{{text}}", "{{text}}"],
      inputSchema: { type: "object" },
      enabled: false,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe("echo_text");
    expect(updated.enabled).toBe(false);
    db.close();
  });
});
