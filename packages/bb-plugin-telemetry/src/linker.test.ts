import { describe, expect, it } from "vitest";
import { emptyCapabilities, type ProviderSessionRecord } from "./types";
import { explicitProviderLinkKey, linkProviderSessions } from "./linker";

function session(
  id: string,
  source: "provider" | "bb",
  provider: ProviderSessionRecord["provider"],
  hostId: string,
  providerSessionId: string | null,
  bbThreadId: string | null,
): ProviderSessionRecord {
  return {
    id,
    source,
    provider,
    hostId,
    providerSessionId,
    bbThreadId,
    title: id,
    cwd: null,
    projectId: null,
    model: null,
    origin: null,
    status: "completed",
    startedAt: null,
    updatedAt: null,
    durationMs: null,
    messageCount: 0,
    turnCount: 0,
    toolCalls: 0,
    toolErrors: 0,
    inputTokens: null,
    cachedInputTokens: null,
    cachedWriteTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    contextPeak: null,
    costUsd: null,
    costEstimated: false,
    compactionCount: 0,
    failureCount: 0,
    delegatedCount: 0,
    archived: false,
    coverage: emptyCapabilities(),
    storeLabel: "test",
  sourcePath: null,
    fingerprint: null,
    linkState: "none",
    findingCount: 0,
  };
}

describe("provider session linking", () => {
  it("does not cross-link reused session ids across providers or hosts", () => {
    const providerSessions = [
      session("provider:host-a:codex:shared", "provider", "codex", "host-a", "shared", null),
      session("provider:host-b:claude:shared", "provider", "claude", "host-b", "shared", null),
    ];
    const bbSessions = [
      session("bb:thread-a", "bb", "codex", "host-a", "shared", "thread-a"),
      session("bb:thread-b", "bb", "claude", "host-b", "shared", "thread-b"),
    ];
    const explicit = new Map([
      [explicitProviderLinkKey("codex", "host-a", "shared"), { bbThreadId: "thread-a", sourceSequence: 1 }],
      [explicitProviderLinkKey("claude", "host-b", "shared"), { bbThreadId: "thread-b", sourceSequence: 2 }],
    ]);

    const links = linkProviderSessions(providerSessions, bbSessions, explicit, 1);

    expect(links.map((link) => [link.providerSessionId, link.bbThreadId])).toEqual([
      ["provider:host-a:codex:shared", "thread-a"],
      ["provider:host-b:claude:shared", "thread-b"],
    ]);
  });

  it("uses the metadata window when a real thread list row has no environment object", () => {
    const provider = session("provider:primary:codex:window", "provider", "codex", "primary", "window", null);
    const bb = session("bb:thread-window", "bb", "codex", "primary", null, "thread-window");
    provider.startedAt = 1_700_000_000_000;
    provider.updatedAt = 1_700_000_010_000;
    bb.startedAt = provider.startedAt;
    bb.updatedAt = provider.updatedAt;

    const links = linkProviderSessions([provider], [bb], new Map(), 1);

    expect(links).toMatchObject([{
      providerSessionId: provider.id,
      bbThreadId: "thread-window",
      strategy: "metadata-window",
    }]);
  });
});
