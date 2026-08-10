import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

  it("reports the effective price table without hitting the network", async () => {
    const host = createFakePluginHost({ pluginId: "telemetry", settings: { autoIndex: false } });
    hosts.push(host);
    await plugin(host.bb);

    const prices = await host.harness.behavior.runCli(["prices"]);
    expect(prices.exitCode).toBe(0);
    expect(String(prices.stdout)).toContain("bundled fallback");
    expect(String(prices.stdout)).toMatch(/Models priced: \d+/);

    const modelLookup = await host.harness.behavior.runCli(["prices", "--model", "gpt-5"]);
    expect(modelLookup.exitCode).toBe(0);
    expect(String(modelLookup.stdout)).toContain("gpt-5 (bundled)");

    const unknown = await host.harness.behavior.runCli(["prices", "--model", "gpt-999"]);
    expect(String(unknown.stdout)).toContain("No price found");
  });
});

describe("provider session round-trip through the store", () => {
  it("persists extracted tokens, cache writes, and reported cost", async () => {
    const dir = mkdtempSync(join("/tmp", "telemetry-roundtrip-"));
    const storeDir = join(dir, "pi-store");
    mkdirSync(storeDir, { recursive: true });
    const now = Date.now();
    writeFileSync(join(storeDir, "roundtrip.jsonl"), [
      JSON.stringify({ type: "session", id: "roundtrip-1", timestamp: now - 2000, cwd: "/workspace" }),
      JSON.stringify({
        type: "message", id: "m1", parentId: null, timestamp: now - 1000,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "grep", arguments: {} }],
          usage: { input: 500, output: 120, cacheRead: 400, cacheWrite: 60, totalTokens: 1020, cost: { total: 0.0031 } },
        },
      }),
      JSON.stringify({ type: "agent_status", id: "a1", parentId: "m1", timestamp: now, status: { taskState: "needs_input" } }),
    ].join("\n"));
    try {
      const host = createFakePluginHost({
        pluginId: "telemetry",
        settings: { autoIndex: false, piPath: storeDir, primeEnabled: false, opencodeEnabled: false },
        sdk: {
          hosts: { list: async () => [] },
          files: {
            listPaths: async () => ({ paths: [{ kind: "file", path: join(storeDir, "roundtrip.jsonl") }], truncated: false }),
            read: async () => { throw new Error("primary-host reads must not hit the file API"); },
          },
          providers: { list: async () => [] },
          threads: { list: async () => [] },
        },
      });
      hosts.push(host);
      await plugin(host.bb);

      const result = await host.harness.behavior.runCli(["reindex", "--full"]);
      expect(result.exitCode).toBe(0);

      // Page to the end: the fixture session is the oldest in the store.
      type SessionRow = { providerSessionId: string; inputTokens: number | null; cachedInputTokens: number | null; cachedWriteTokens: number | null; costUsd: number | null; toolCalls: number; status: string };
      let session: SessionRow | undefined;
      let offset = 0;
      for (;;) {
        const page = await host.harness.callRpc("listSessions", { view: "provider", range: "lifetime", limit: 200, offset }) as { sessions: SessionRow[]; total: number };
        session = page.sessions.find((s) => s.providerSessionId === "roundtrip-1");
        if (session || offset + page.sessions.length >= page.total) break;
        offset += page.sessions.length;
      }
      expect(session).toBeDefined();
      expect(session?.inputTokens).toBe(500);
      expect(session?.cachedInputTokens).toBe(400);
      expect(session?.cachedWriteTokens).toBe(60);
      expect(session?.toolCalls).toBe(1);
      expect(session?.status).toBe("completed");
      // Provider-reported cost survives the persist/read cycle and is not re-estimated.
      expect(session?.costUsd).toBeCloseTo(0.0031, 10);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
