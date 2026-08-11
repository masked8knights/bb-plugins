import { describe, expect, it } from "vitest";
import { mergeSessionMetas } from "../src/streaming";
import type { SessionAnalytics, SessionMeta } from "../src/types";

function analytics(toolCalls: number, turnCount: number): SessionAnalytics {
  return {
    status: "completed",
    durationMs: 1_000,
    turnCount,
    toolCalls,
    toolErrors: 0,
    inputTokens: 10,
    cachedInputTokens: 20,
    cachedWriteTokens: null,
    outputTokens: 5,
    reasoningTokens: null,
    totalTokens: null,
    contextPeak: null,
    compactionCount: 0,
    failureCount: 0,
    delegatedCount: 0,
    costUsd: null,
    costEstimated: false,
    coverageJson: JSON.stringify({ tools: "complete", turns: "complete" }),
  };
}

function meta(filePath: string, toolCalls: number, turnCount: number, transcript: string): SessionMeta {
  return {
    id: "claude:session-1",
    provider: "claude",
    providerSessionId: "session-1",
    filePath,
    title: filePath.includes("subagents") ? "Subagent title" : "Parent title",
    cwd: "/workspace",
    gitRepoRoot: null,
    startedAt: 1_000,
    updatedAt: 2_000,
    model: "claude-sonnet-4-5",
    origin: "claude-code",
    messageCount: 2,
    summary: null,
    firstUserMessage: "inspect the project",
    transcript,
    truncated: false,
    sizeBytes: 100,
    mtimeMs: 2_000,
    analytics: analytics(toolCalls, turnCount),
  };
}

describe("session file aggregation", () => {
  it("keeps the parent row and adds subagent telemetry", () => {
    const merged = mergeSessionMetas([
      meta("/tmp/.claude/projects/session-1/subagents/agent-a.jsonl", 4, 3, "subagent transcript"),
      meta("/tmp/.claude/projects/session-1.jsonl", 8, 6, "parent transcript"),
    ]);

    expect(merged.filePath).toBe("/tmp/.claude/projects/session-1.jsonl");
    expect(merged.title).toBe("Parent title");
    expect(merged.messageCount).toBe(4);
    expect(merged.analytics?.toolCalls).toBe(12);
    expect(merged.analytics?.turnCount).toBe(9);
    expect(merged.transcript).toContain("parent transcript");
    expect(merged.transcript).toContain("subagent transcript");
  });
});
