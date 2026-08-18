import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  completeLines,
  defaultSessionRoots,
  expandConfiguredPaths,
  normalizeRecord,
} from "./indexer";

describe("normalizeRecord", () => {
  it("normalizes Codex messages and token telemetry", () => {
    const event = normalizeRecord({
      timestamp: "2026-08-17T12:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1_200,
            output_tokens: 340,
          },
        },
      },
    });

    expect(event.kind).toBe("telemetry");
    expect(event.timestamp).toBe(Date.parse("2026-08-17T12:00:00.000Z"));
    expect(event.inputTokens).toBe(1_200);
    expect(event.outputTokens).toBe(340);
    expect(event.usageIsTotal).toBe(true);
  });

  it("keeps DeepSeek Harness tool calls as selectable nested events", () => {
    const event = normalizeRecord({
      type: "tool/call",
      seq: 7,
      time: 1_750_000_000,
      data: {
        turn: 2,
        step: 3,
        name: "exec",
        arguments: "{\"command\":\"pwd\"}",
      },
    });

    expect(event.kind).toBe("tool");
    expect(event.role).toBe("tool");
    expect(event.title).toBe("exec");
    expect(event.turn).toBe(2);
    expect(event.step).toBe(3);
    expect(event.depth).toBe(1);
    expect(event.summary).toContain("pwd");
  });

  it("only uses values from the requested metadata keys", () => {
    const event = normalizeRecord({
      type: "assistant/message",
      timestamp: "2026-08-17T12:00:00.000Z",
      model: "gpt-5",
      cwd: "/Users/test/project",
      data: { content: "A response" },
    });

    expect(event.model).toBe("gpt-5");
    expect(event.cwd).toBe("/Users/test/project");
  });
});

describe("completeLines", () => {
  it("emits complete JSONL records and leaves a partial tail for the next scan", async () => {
    const lines = [];
    for await (const line of completeLines(Readable.from([Buffer.from("one\n"), Buffer.from("two")]) as AsyncIterable<Uint8Array>)) {
      lines.push(line);
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      text: "one",
      line: 0,
      startByte: 0,
      endByte: 4,
    });
  });
});

describe("default roots", () => {
  it("covers the local harnesses without a network endpoint", () => {
    const roots = defaultSessionRoots("/tmp/test-home");
    expect(roots.map((root) => root.source)).toEqual(["dsh", "claude", "pi", "omp", "codex", "codex", "codex"]);
    expect(roots.find((root) => root.source === "dsh")?.format).toBe("zstd");
  });

  it("expands one configured root per line", () => {
    expect(expandConfiguredPaths("~/one\n /tmp/two", "/Users/test")).toEqual([
      "/Users/test/one",
      "/tmp/two",
    ]);
  });
});
