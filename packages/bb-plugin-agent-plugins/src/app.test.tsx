// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("../app"));
const panel = app.navPanels[0]!;

afterEach(() => cleanup());

describe("Agent Plugins settings", () => {
  it("renders per-skill and per-MCP switches and persists their changes", async () => {
    let snapshot = {
      plugins: [{
        id: "plugin-1",
        name: "Example Plugin",
        version: "1.0.0",
        specVersion: "1.0.0",
        sourceType: "path",
        sourceIntent: "path:/tmp/example-plugin",
        sourceResolved: null,
        status: "active",
        approval: "approved",
        lastError: null,
      }],
      skills: [{
        pluginId: "plugin-1",
        skillName: "research",
        status: "active",
        lastError: null,
        enabled: true,
      }],
      mcpServers: [{
        pluginId: "plugin-1",
        serverId: "docs",
        type: "stdio",
        status: "idle",
        lastError: null,
        approved: 0,
        enabled: true,
        configJson: JSON.stringify({ type: "stdio", command: "node" }),
      }],
      dataDir: "/tmp/bb",
    };
    const calls: Array<{ method: string; input: unknown }> = [];

    const slot = renderSlot(panel, { subPath: "" }, {
      rpc: {
        snapshot: () => snapshot,
        setSkillEnabled: ({ id, skillName, enabled }: { id: string; skillName: string; enabled: boolean }) => {
          calls.push({ method: "setSkillEnabled", input: { id, skillName, enabled } });
          snapshot = {
            ...snapshot,
            skills: snapshot.skills.map((skill) => skill.skillName === skillName ? { ...skill, enabled, status: enabled ? "active" : "skipped" } : skill),
          };
          return { enabled, status: enabled ? "active" : "skipped", lastError: null };
        },
        setMcpEnabled: ({ id, serverId, enabled }: { id: string; serverId: string; enabled: boolean }) => {
          calls.push({ method: "setMcpEnabled", input: { id, serverId, enabled } });
          snapshot = {
            ...snapshot,
            mcpServers: snapshot.mcpServers.map((server) => server.serverId === serverId ? { ...server, enabled, status: enabled ? "idle" : "disabled" } : server),
          };
          return { enabled, status: enabled ? "idle" : "disabled", lastError: null };
        },
      } as never,
    });

    fireEvent.click(await slot.findByRole("button", { name: /Example Plugin/ }));
    const skillSwitch = await slot.findByRole("switch", { name: "Disable skill research" });
    const mcpSwitch = await slot.findByRole("switch", { name: "Disable MCP server docs" });
    expect(slot.getByRole("heading", { name: "Skills" })).toBeTruthy();
    expect(slot.getByRole("heading", { name: "MCP servers" })).toBeTruthy();

    fireEvent.click(skillSwitch);
    await waitFor(() => expect(calls).toContainEqual({
      method: "setSkillEnabled",
      input: { id: "plugin-1", skillName: "research", enabled: false },
    }));
    await slot.findByRole("switch", { name: "Enable skill research" });

    fireEvent.click(mcpSwitch);
    await waitFor(() => expect(calls).toContainEqual({
      method: "setMcpEnabled",
      input: { id: "plugin-1", serverId: "docs", enabled: false },
    }));
    await slot.findByRole("switch", { name: "Enable MCP server docs" });
  });

  it("ignores an older snapshot response after a newer realtime refresh", async () => {
    const enabledSnapshot = {
      plugins: [{
        id: "plugin-1", name: "Example Plugin", version: "1.0.0", specVersion: "1.0.0",
        sourceType: "path", sourceIntent: "path:/tmp/example-plugin", sourceResolved: null,
        status: "active", approval: "approved", lastError: null,
      }],
      skills: [{ pluginId: "plugin-1", skillName: "research", status: "active", lastError: null, enabled: true }],
      mcpServers: [],
      dataDir: "/tmp/bb",
    };
    const disabledSnapshot = {
      ...enabledSnapshot,
      skills: [{ ...enabledSnapshot.skills[0]!, status: "skipped", enabled: false }],
    };
    const pending: Array<(value: typeof enabledSnapshot) => void> = [];
    let snapshotCalls = 0;
    const slot = renderSlot(panel, { subPath: "" }, {
      rpc: {
        snapshot: () => {
          snapshotCalls += 1;
          return new Promise<typeof enabledSnapshot>((resolve) => pending.push(resolve));
        },
      } as never,
    });

    await waitFor(() => expect(snapshotCalls).toBe(1));
    await slot.emitRealtime("agent-plugins-changed", { kind: "toggle" });
    await waitFor(() => expect(snapshotCalls).toBe(2));

    pending[1]!(disabledSnapshot);
    const pluginButton = await slot.findByRole("button", { name: /Example Plugin/ });
    fireEvent.click(pluginButton);
    await slot.findByRole("switch", { name: "Enable skill research" });

    pending[0]!(enabledSnapshot);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slot.getByRole("switch", { name: "Enable skill research" })).toBeTruthy();
    expect(slot.queryByRole("switch", { name: "Disable skill research" })).toBeNull();
  });
});
