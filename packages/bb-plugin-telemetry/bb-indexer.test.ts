import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { AnalyticsStore, MIGRATIONS } from "./src/db";
import { indexBbThreads } from "./src/bb-indexer";
import { emptyCapabilities, type NormalizedBbEvent, type ProviderSessionRecord } from "./src/types";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});
describe("bb thread indexing", () => {
  it("refreshes archived and title metadata when the event cursor has not changed", async () => {
    const host = createFakePluginHost({
      pluginId: "telemetry",
      sdk: {
        threads: {
          list: async () => [{
            id: "thread-1",
            title: "New title",
            status: "idle",
            createdAt: 1,
            updatedAt: 3,
            archivedAt: 4,
          }],
          events: { list: async () => [] },
        },
      },
    });
    hosts.push(host);
    const database = host.bb.storage.database();
    host.bb.storage.migrate(database, MIGRATIONS);
    const store = new AnalyticsStore(database);
    const session: ProviderSessionRecord = {
      id: "bb:thread-1",
      source: "bb",
      provider: "codex",
      hostId: "primary",
      providerSessionId: null,
      bbThreadId: "thread-1",
      title: "Old title",
      cwd: "/workspace",
      projectId: null,
      model: "gpt-5",
      origin: "bb",
      status: "completed",
      startedAt: 1,
      updatedAt: 2,
      durationMs: null,
      messageCount: 1,
      turnCount: 1,
      toolCalls: 0,
      toolErrors: 0,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      contextPeak: null,
      compactionCount: 0,
      failureCount: 0,
      delegatedCount: 0,
      archived: false,
      costUsd: null,
      costEstimated: false,
      coverage: emptyCapabilities("complete"),
      storeLabel: "bb event stream",
      fingerprint: null,
      linkState: "none",
      findingCount: 0,
    };
    const event: NormalizedBbEvent = {
      sourceSequence: 1,
      eventType: "turn/completed",
      itemId: null,
      messageId: null,
      turnId: "turn-1",
      at: 2,
      classification: "turn",
      status: "completed",
      durationMs: null,
      toolName: null,
      errorCategory: null,
      approvalStatus: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      contextUsed: null,
      contextLimit: null,
      estimated: false,
      providerSessionId: null,
    };
    store.replaceBbSession(session, [event], [], [], [], []);

    const result = await indexBbThreads(host.bb, store, {
      includeArchived: true,
      log: () => undefined,
    });

    expect(result.indexed).toBe(0);
    expect(result.sessions).toHaveLength(1);
    expect(store.getSession("bb:thread-1")).toMatchObject({
      title: "New title",
      archived: true,
      updatedAt: 3,
    });
  });

  it("counts one assistant message for multiple deltas of the same item", async () => {
    const host = createFakePluginHost({
      pluginId: "telemetry",
      sdk: {
        threads: {
          list: async () => [{ id: "thread-2", title: "Messages", status: "idle", createdAt: 1, updatedAt: 3 }],
          events: {
            list: async () => [
              { seq: 1, type: "item/agentMessage/delta", createdAt: 1, data: { itemId: "message-1", turnId: "turn-1" } },
              { seq: 2, type: "item/agentMessage/delta", createdAt: 2, data: { itemId: "message-1", turnId: "turn-1" } },
            ],
          },
        },
      },
    });
    hosts.push(host);
    const database = host.bb.storage.database();
    host.bb.storage.migrate(database, MIGRATIONS);
    const store = new AnalyticsStore(database);

    await indexBbThreads(host.bb, store, { includeArchived: true, full: true, log: () => undefined });

    expect(store.getSession("bb:thread-2")).toMatchObject({ messageCount: 1, toolCalls: 0 });
  });
});
