import { describe, expect, it } from "vitest";
import { createProviderJsonlParser, parseProviderJsonl, parseProviderMetadataSession } from "./providers";
import { mergeParsedRecords } from "./source-reader";

describe("provider record normalization", () => {
  it("keeps structured JSONL metrics when Pi metadata has the same id", () => {
    const jsonl = parseProviderJsonl(
      "pi",
      "primary",
      "/tmp/pi-session.jsonl",
      [
        JSON.stringify({ type: "session", session_id: "same-session", timestamp: 1_700_000_000_000 }),
        JSON.stringify({ type: "tool_call", id: "tool-1", name: "shell", status: "completed", timestamp: 1_700_000_001_000 }),
      ].join("\n"),
      "jsonl-fingerprint",
    );
    const metadata = parseProviderMetadataSession({
      provider: "pi",
      hostId: "primary",
      providerSessionId: "same-session",
      path: "/tmp/pi.db",
      title: "Metadata title",
      cwd: "/workspace",
      model: "pi-model",
      startedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
      messageCount: 4,
      fingerprint: "sqlite-fingerprint",
    });
    if (!jsonl) throw new Error("expected JSONL record");

    const [merged] = mergeParsedRecords([jsonl, metadata]);
    expect(merged.session.title).toBe("Metadata title");
    expect(merged.session.model).toBe("pi-model");
    expect(merged.session.cwd).toBe("/workspace");
    expect(merged.items).toHaveLength(1);
    expect(merged.session.toolCalls).toBe(1);
    expect(merged.session.messageCount).toBe(4);
    expect(merged.session.fingerprint).not.toBe("jsonl-fingerprint");
  });

  it("derives tool errors from the final update for a deduplicated item", () => {
    const parsed = parseProviderJsonl(
      "codex",
      "primary",
      "/tmp/codex-session.jsonl",
      [
        JSON.stringify({ type: "session", session_id: "counter-session", timestamp: 1_700_000_000_000 }),
        JSON.stringify({ type: "tool_call", id: "tool-1", name: "shell", status: "failed", error: { type: "timeout" }, timestamp: 1_700_000_001_000 }),
        JSON.stringify({ type: "tool_call", id: "tool-1", name: "shell", status: "completed", timestamp: 1_700_000_002_000 }),
      ].join("\n"),
      "fingerprint",
    );
    if (!parsed) throw new Error("expected parsed record");

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.status).toBe("completed");
    expect(parsed.items[0]?.errorCategory).toBeNull();
    expect(parsed.session.toolCalls).toBe(1);
    expect(parsed.session.toolErrors).toBe(0);
    expect(parsed.session.failureCount).toBe(0);
  });

  it("extracts Claude Code usage and model from progress events", () => {
    const parsed = parseProviderJsonl(
      "claude",
      "primary",
      "/tmp/claude-session.jsonl",
      [
        JSON.stringify({
          type: "user", sessionId: "claude-1", cwd: "/workspace", timestamp: "2026-07-01T10:00:00Z",
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        }),
        JSON.stringify({
          type: "progress", sessionId: "claude-1", timestamp: "2026-07-01T10:00:10Z",
          completion: {
            model: "claude-sonnet-4-5",
            usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 200, output_tokens: 30 },
          },
        }),
      ].join("\n"),
      "fingerprint",
    );
    if (!parsed) throw new Error("expected parsed record");

    expect(parsed.session.model).toBe("claude-sonnet-4-5");
    expect(parsed.session.inputTokens).toBe(100);
    expect(parsed.session.cachedInputTokens).toBe(200);
    expect(parsed.session.cachedWriteTokens).toBe(50);
    expect(parsed.session.outputTokens).toBe(30);
    expect(parsed.session.coverage.tokens).toBe("complete");
  });

  it("extracts Pi toolCall blocks, cache reads, and reported cost from message.usage", () => {
    const parsed = parseProviderJsonl(
      "pi",
      "primary",
      "/tmp/pi-tools.jsonl",
      [
        JSON.stringify({ type: "session", id: "pi-1", timestamp: 1_700_000_000_000 }),
        JSON.stringify({
          type: "message", id: "m1", parentId: null, timestamp: 1_700_000_001_000,
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "..." },
              { type: "toolCall", id: "call_1", name: "bash", arguments: { cmd: "ls" } },
            ],
            usage: { input: 500, output: 120, cacheRead: 400, cacheWrite: 0, totalTokens: 1020, cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0031 } },
          },
        }),
        JSON.stringify({ type: "agent_status", id: "s1", parentId: "m1", timestamp: 1_700_000_002_000, status: { summary: "", taskState: "needs_input", basedOnMessageCount: 2 } }),
      ].join("\n"),
      "fingerprint",
    );
    if (!parsed) throw new Error("expected parsed record");

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.toolName).toBe("bash");
    expect(parsed.items[0]?.status).toBe("completed");
    expect(parsed.session.toolCalls).toBe(1);
    expect(parsed.session.inputTokens).toBe(500);
    expect(parsed.session.cachedInputTokens).toBe(400);
    expect(parsed.session.outputTokens).toBe(120);
    expect(parsed.session.totalTokens).toBe(1020);
    expect(parsed.session.costUsd).toBeCloseTo(0.0031, 10);
    expect(parsed.session.costEstimated).toBe(false);
    expect(parsed.session.status).toBe("completed");
  });

  it("extracts omp tool executions from custom tool_execution_start events", () => {
    const parsed = parseProviderJsonl(
      "omp",
      "primary",
      "/tmp/omp-tools.jsonl",
      [
        JSON.stringify({ type: "session", id: "omp-1", timestamp: 1_700_000_000_000 }),
        JSON.stringify({
          type: "custom", customType: "tool_execution_start", id: "c1", parentId: "m1", timestamp: 1_700_000_001_000,
          data: { toolCallId: "call_9", toolName: "grep", startedAt: "2026-07-01T10:00:01Z", intent: "find" },
        }),
        JSON.stringify({ type: "custom", customType: "session_exit", id: "c2", parentId: "c1", timestamp: 1_700_000_002_000 }),
      ].join("\n"),
      "fingerprint",
    );
    if (!parsed) throw new Error("expected parsed record");

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.toolName).toBe("grep");
    expect(parsed.items[0]?.id).toBe("call_9");
    expect(parsed.items[0]?.status).toBe("completed");
    expect(parsed.session.toolCalls).toBe(1);
    expect(parsed.session.status).toBe("completed");
  });

  it("extracts Codex token_count usage per turn and real model, not model_provider", () => {
    const parsed = parseProviderJsonl(
      "codex",
      "primary",
      "/tmp/codex-tokens.jsonl",
      [
        JSON.stringify({ type: "session_meta", payload: { session_id: "codex-1", id: "codex-1", model_provider: "openai", cwd: "/workspace" }, timestamp: "2026-07-01T10:00:00Z" }),
        JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1", model: "gpt-5.1-codex" }, timestamp: "2026-07-01T10:00:01Z" }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count", turn_id: "turn-1",
            info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 5, total_tokens: 135 }, total_token_usage: { total_tokens: 999 }, model_context_window: 258400 },
          },
          timestamp: "2026-07-01T10:00:02Z",
        }),
      ].join("\n"),
      "fingerprint",
    );
    if (!parsed) throw new Error("expected parsed record");

    expect(parsed.session.model).toBe("gpt-5.1-codex");
    expect(parsed.session.inputTokens).toBe(100);
    expect(parsed.session.cachedInputTokens).toBe(20);
    expect(parsed.session.outputTokens).toBe(30);
    expect(parsed.session.reasoningTokens).toBe(5);
    // Cumulative totals must not be summed; the per-request snapshot wins.
    expect(parsed.session.totalTokens).toBe(135);
    expect(parsed.session.turnCount).toBe(1);
    expect(parsed.turns[0]?.totalTokens).toBe(135);
  });

  it("does not treat a bare provider name as the model", () => {
    const parsed = parseProviderJsonl(
      "codex",
      "primary",
      "/tmp/codex-nomodel.jsonl",
      JSON.stringify({ type: "session_meta", payload: { session_id: "codex-2", id: "codex-2", model_provider: "openai" }, timestamp: "2026-07-01T10:00:00Z" }),
      "fingerprint",
    );
    if (!parsed) throw new Error("expected parsed record");
    expect(parsed.session.model).toBeNull();
  });

  it("merges provider-reported usage and cost from sqlite metadata into the JSONL record", () => {
    const jsonl = parseProviderJsonl(
      "pi",
      "primary",
      "/tmp/pi-session.jsonl",
      [
        JSON.stringify({ type: "session", session_id: "merge-1", timestamp: 1_700_000_000_000 }),
        JSON.stringify({ type: "agent_status", id: "a1", timestamp: 1_700_000_001_000, status: { taskState: "needs_input" } }),
      ].join("\n"),
      "jsonl-fingerprint",
    );
    const metadata = parseProviderMetadataSession({
      provider: "pi",
      hostId: "primary",
      providerSessionId: "merge-1",
      path: "/tmp/pi.db",
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 300,
      cachedWriteTokens: 50,
      reasoningTokens: 25,
      totalTokens: 1250,
      toolCalls: 7,
      costUsd: 0.05,
      costEstimated: false,
      status: "completed",
      archived: true,
      fingerprint: "sqlite-fingerprint",
    });
    if (!jsonl) throw new Error("expected JSONL record");

    const [merged] = mergeParsedRecords([jsonl, metadata]);
    expect(merged.session.inputTokens).toBe(1000);
    expect(merged.session.cachedInputTokens).toBe(300);
    expect(merged.session.cachedWriteTokens).toBe(50);
    expect(merged.session.totalTokens).toBe(1250);
    expect(merged.session.toolCalls).toBe(7);
    expect(merged.session.costUsd).toBe(0.05);
    expect(merged.session.costEstimated).toBe(false);
    expect(merged.session.archived).toBe(true);
    expect(merged.session.status).toBe("completed");
  });

  it("prefers the sqlite lifecycle verdict over a provisional active JSONL state", () => {
    const jsonl = parseProviderJsonl(
      "pi",
      "primary",
      "/tmp/pi-session.jsonl",
      [
        JSON.stringify({ type: "session_state", id: "s1", timestamp: 1_700_000_000_000, state: { status: "active" } }),
        JSON.stringify({ type: "message", id: "m1", timestamp: 1_700_000_001_000, message: { role: "assistant", content: [] } }),
      ].join("\n"),
      "jsonl-fingerprint",
    );
    const metadata = parseProviderMetadataSession({
      provider: "pi",
      hostId: "primary",
      providerSessionId: "state-1",
      path: "/tmp/pi.db",
      status: "completed",
      fingerprint: "sqlite-fingerprint",
    });
    if (!jsonl) throw new Error("expected JSONL record");

    const [merged] = mergeParsedRecords([{ ...jsonl, session: { ...jsonl.session, id: "provider:primary:pi:state-1", providerSessionId: "state-1" } }, metadata]);
    expect(merged.session.status).toBe("completed");
  });

  it("counts compaction snapshots without parsing their multi-MB payloads", () => {
    const parser = createProviderJsonlParser("codex", "primary", "/tmp/compacted-session.jsonl");
    parser.processLine(JSON.stringify({ type: "session", session_id: "compacted-session", timestamp: 1_700_000_000_000 }), 0);
    // A `compacted` line whose payload is deliberately NOT valid JSON: the
    // head-only fast path still reads the type + timestamp, so the event
    // counts and shows up in evidence without JSON.parse ever running.
    parser.processLine('{"timestamp":"2026-06-03T12:35:31.624Z","type":"compacted","payload":{"replacement_history":["' + "x".repeat(600) + '"{', 1);
    parser.processLine(JSON.stringify({ type: "tool_call", id: "tool-1", name: "shell", status: "completed", timestamp: 1_700_000_001_000 }), 2);

    const parsed = parser.finish("fingerprint");
    expect(parsed?.session.compactionCount).toBe(1);
    expect(parsed?.evidence.some((event) => event.eventType === "compacted" && event.at !== null)).toBe(true);
    expect(parsed?.items).toHaveLength(1);
  });

  it("streaming parser matches the whole-content parser line for line", () => {
    const content = [
      JSON.stringify({ type: "session", session_id: "stream-session", timestamp: 1_700_000_000_000 }),
      JSON.stringify({ type: "compacted", timestamp: "2026-06-03T12:35:31.624Z", payload: { replacement_history: [] } }),
      JSON.stringify({ type: "tool_call", id: "tool-1", name: "shell", status: "completed", timestamp: 1_700_000_001_000 }),
      JSON.stringify({ type: "usage", session_id: "stream-session", timestamp: 1_700_000_002_000, payload: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } }),
    ].join("\n");
    const whole = parseProviderJsonl("codex", "primary", "/tmp/stream-session.jsonl", content, "fingerprint");
    const parser = createProviderJsonlParser("codex", "primary", "/tmp/stream-session.jsonl");
    content.split(/\r?\n/).forEach((line, index) => parser.processLine(line, index));
    const streamed = parser.finish("fingerprint");

    expect(streamed).toEqual(whole);
    expect(streamed?.session.compactionCount).toBe(1);
  });

  it("skips pathological single lines without failing the session", () => {
    const parser = createProviderJsonlParser("codex", "primary", "/tmp/giant-line.jsonl");
    parser.processLine(JSON.stringify({ type: "session", session_id: "giant-session", timestamp: 1_700_000_000_000 }), 0);
    parser.processLine("{\"type\":\"tool_call\",\"payload\":\"" + "x".repeat(70 * 1024 * 1024) + "\"}", 1);
    parser.processLine(JSON.stringify({ type: "tool_call", id: "tool-1", name: "shell", status: "completed", timestamp: 1_700_000_001_000 }), 2);

    const parsed = parser.finish("fingerprint");
    expect(parsed?.session.compactionCount).toBe(0);
    expect(parsed?.items).toHaveLength(1);
  });
});
