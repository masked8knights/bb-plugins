import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin from "../server";
import { compactReindexInput } from "../src/rpc-input";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

function disabledSources() {
  return {
    piEnabled: false,
    primeEnabled: false,
    ompEnabled: false,
    hermesEnabled: false,
    codexEnabled: false,
    claudeEnabled: false,
    opencodeEnabled: false,
  };
}

describe("Observability RPC contract", () => {
  it("omits undefined providers from reindex input", () => {
    expect(compactReindexInput({ providers: undefined })).toEqual({});
    expect(compactReindexInput({ providers: ["codex"] })).toEqual({ providers: ["codex"] });
  });

  it("accepts an empty-index telemetry dashboard through host validation", async () => {
    const host = createFakePluginHost({
      pluginId: "sessions",
      settings: disabledSources(),
      sdk: {
        providers: {
          list: async () => [{ id: "acp-custom", displayName: "Custom provider", available: true }],
        },
      },
    });
    hosts.push(host);
    await plugin(host.bb);

    const result = await host.harness.callRpc("telemetryDashboard", {
      view: "provider",
      range: "7d",
    });

    expect(result).toMatchObject({
      dashboard: {
        view: "provider",
        range: "7d",
        totals: { sessions: 0 },
      },
      sources: expect.any(Array),
      uncovered: [{ id: "acp-custom", displayName: "Custom provider" }],
      providerDiscoveryState: "fresh",
    });
  });
});
