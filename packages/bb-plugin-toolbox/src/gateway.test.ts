import { describe, expect, it } from "vitest";
import { McpGateway, exposedToolName } from "./gateway";
import type { ToolboxStore } from "./store";
import type { CliSourceRecord, McpServerRecord } from "./types";

const log = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const options = { timeoutMs: 1_000, maxOutputBytes: 10_000 };

describe("MCP gateway", () => {
  it("keeps sanitized names unique when remote names collide", () => {
    const dotted = exposedToolName("source", "foo.bar", "mcp");
    const underscored = exposedToolName("source", "foo_bar", "mcp");
    const dottedSource = exposedToolName("a.b", "run", "mcp");
    const underscoredSource = exposedToolName("a_b", "run", "mcp");
    const delimiterSource = exposedToolName("a:", "b", "mcp");
    const delimiterTool = exposedToolName("a", ":b", "mcp");

    expect(dotted).not.toBe(underscored);
    expect(dottedSource).not.toBe(underscoredSource);
    expect(delimiterSource).not.toBe(delimiterTool);
    expect(dotted).toMatch(/^mcp_source__foo_bar_[a-z0-9]+$/u);
    expect(underscored).toMatch(/^mcp_source__foo_bar_[a-z0-9]+$/u);
  });

  it("does not connect MCP sources for a connection-free catalog", async () => {
    const source: McpServerRecord = {
      id: "mcp_unavailable",
      name: "Unavailable",
      description: "",
      transport: "stdio",
      url: null,
      command: "not-a-real-command",
      args: [],
      cwd: null,
      headers: {},
      env: {},
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    };
    const store = {
      listMcpServers: () => [source],
      listCliSources: () => [],
    } as unknown as ToolboxStore;
    const gateway = new McpGateway(store, log, options);

    await expect(gateway.catalog({ connect: false })).resolves.toEqual([]);
    await gateway.close();
  });

  it("catalogs one raw tool per CLI source", async () => {
    const source: CliSourceRecord = {
      id: "cli_source_bird",
      name: "Bird",
      description: "Use Bird's own commands",
      command: "bird",
      cwd: null,
      env: {},
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    };
    const store = {
      listMcpServers: () => [],
      listCliSources: () => [source],
    } as unknown as ToolboxStore;
    const gateway = new McpGateway(store, log, options);

    await expect(gateway.catalog({ connect: false })).resolves.toEqual([
      expect.objectContaining({
        name: "Bird",
        sourceId: source.id,
        sourceKind: "cli-source",
        inputSchema: expect.objectContaining({ required: ["argv"] }),
      }),
    ]);
    await gateway.close();
  });

  it("rejects refreshes for unknown MCP sources", async () => {
    const store = { getMcpServer: () => null } as unknown as ToolboxStore;
    const gateway = new McpGateway(store, log, options);

    await expect(gateway.refreshSource("mcp_missing")).rejects.toThrow("MCP source not found");
    await gateway.close();
  });
});
