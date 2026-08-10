import { describe, expect, it } from "vitest";
import { buildDashboard } from "./aggregate";
import type { NormalizedItem, ProviderSessionRecord } from "./types";

const session: ProviderSessionRecord = {
  id: "codex:session-1",
  source: "provider",
  provider: "codex",
  hostId: "local",
  providerSessionId: "session-1",
  bbThreadId: null,
  title: "Telemetry fixture",
  cwd: null,
  projectId: null,
  model: "gpt-test",
  origin: null,
  status: "completed",
  startedAt: 1_000,
  updatedAt: 2_000,
  durationMs: 1_000,
  messageCount: 1,
  turnCount: 2,
  toolCalls: 1,
  toolErrors: 0,
  inputTokens: 100,
  cachedInputTokens: 25,
  cachedWriteTokens: 0,
  outputTokens: 50,
  reasoningTokens: 10,
  totalTokens: 150,
  contextPeak: 0.4,
  compactionCount: 0,
  failureCount: 0,
  delegatedCount: 0,
  archived: false,
  costUsd: null,
  costEstimated: false,
  coverage: {
    metadata: "complete",
    turns: "complete",
    tools: "complete",
    tokens: "complete",
    context: "complete",
    errors: "complete",
    latency: "complete",
    models: "complete",
  },
  storeLabel: "fixture",
  sourcePath: null,
  fingerprint: "fixture",
  linkState: "none",
  findingCount: 0,
};

const item: NormalizedItem = {
  sessionId: session.id,
  id: "tool-1",
  turnId: "turn-1",
  kind: "tool",
  toolName: "terminal",
  status: "completed",
  durationMs: 120,
  errorCategory: null,
  approvalStatus: null,
  sourceSequence: 1,
  at: 1_500,
};

describe("buildDashboard telemetry aggregates", () => {
  it("keeps tool rows and daily totals associated with their harness", () => {
    const result = buildDashboard(
      [session],
      [item],
      [],
      [],
      { view: "provider", range: "lifetime" },
      3_000,
    );

    expect(result.tools[0]).toMatchObject({ provider: "codex", name: "terminal", calls: 1, failures: 0 });
    expect(result.daily[0]).toMatchObject({ date: "1970-01-01", sessions: 1, totalTokens: 150 });
    expect(result.daily[0]?.byProvider.codex).toMatchObject({ sessions: 1, turns: 2, totalTokens: 150 });
    // 75 non-cached input @ $1.25/M + 25 cached @ $0.125/M + 50 output @ $10/M.
    expect(result.totals.costUsd).toBeCloseTo(0.000596875, 10);
    expect(result.totals.costEstimated).toBe(true);
    expect(result.providers[0]?.costUsd).toBeCloseTo(0.000596875, 10);
    expect(result.sessions[0]?.costUsd).toBeCloseTo(0.000596875, 10);
  });

  it("uses model-matched pricing when the model is in the table", () => {
    const known = buildDashboard(
      [{ ...session, model: "gpt-5" }],
      [item],
      [],
      [],
      { view: "provider", range: "lifetime" },
      3_000,
    );
    // gpt-5 prices: $1.25 input, $0.125 cached, $10 output per 1M tokens.
    expect(known.totals.costUsd).toBeCloseTo(0.000596875, 10);
    expect(known.totals.costEstimated).toBe(false);
    expect(known.sessions[0]?.costEstimated).toBe(false);
  });

  it("applies price overrides from settings", () => {
    const overridden = buildDashboard(
      [{ ...session, model: "gpt-test" }],
      [item],
      [],
      [],
      { view: "provider", range: "lifetime" },
      3_000,
      { codex: { "gpt-test": { inputPerM: 1, cachedInputPerM: 0.1, outputPerM: 2 } } },
    );
    // 75 @ $1/M + 25 @ $0.1/M + 50 @ $2/M.
    expect(overridden.totals.costUsd).toBeCloseTo(0.0001775, 10);
    expect(overridden.totals.costEstimated).toBe(false);
  });
});
