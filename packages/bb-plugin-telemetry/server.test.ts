import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin from "./server";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

describe("Telemetry server", () => {
  it("reports source health for a provider-specific remote host", async () => {
    const host = createFakePluginHost({
      pluginId: "telemetry",
      settings: {
        autoIndex: false,
        codexHostId: "remote-1",
      },
      sdk: {
        hosts: {
          list: async () => [{ id: "remote-1", name: "Remote", status: "connected" }],
          directory: async () => ({ directory: "/remote/home" }),
        },
        files: {
          listPaths: async () => ({ paths: [], truncated: false }),
        },
        providers: {
          list: async () => [],
        },
        threads: {
          list: async () => [],
        },
      },
    });
    hosts.push(host);
    await plugin(host.bb);

    const refreshed = await host.harness.behavior.runCli([
      "reindex",
      "--full",
      "--provider",
      "codex",
    ]);
    expect(refreshed.exitCode).toBe(0);

    const status = await host.harness.callRpc("status", null) as {
      sources: Array<{ provider: string; hostId: string; detected: boolean }>;
    };
    expect(status.sources.find((source) => source.provider === "codex")).toMatchObject({
      hostId: "remote-1",
      detected: false,
    });
  });
});
