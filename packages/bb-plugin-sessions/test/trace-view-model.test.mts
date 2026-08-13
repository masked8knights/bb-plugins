import assert from "node:assert/strict";
import {
  buildTraceTimeline,
  formatTraceDuration,
  traceContentSections,
  traceTimelineFocusIndexes,
  traceTimelineRangeForIndexes,
} from "../src/trace-view-model.ts";
import { enrichTraceWithTelemetry } from "../src/streaming.ts";
import { parseStoredTrace } from "../src/trace.ts";
import type { SessionTraceEntry } from "../src/types.ts";

const entries: SessionTraceEntry[] = [
  {
    id: "user-1",
    kind: "user",
    title: "User",
    text: "Inspect the trace",
    timestamp: 1_000,
    status: "completed",
    toolName: null,
    sourceSequence: 1,
  },
  {
    id: "assistant-1",
    kind: "assistant",
    title: "Assistant",
    text: "I will inspect it.",
    timestamp: 1_250,
    status: "completed",
    toolName: null,
    sourceSequence: 2,
    metrics: { turnId: "turn-1", durationMs: 900, outputTokens: 12 },
  },
  {
    id: "tool-1",
    kind: "tool",
    title: "bash",
    text: "Input: {\"command\":\"pwd\"}\n\nOutput:\n/Users/patrick",
    timestamp: 2_250,
    status: "completed",
    toolName: "bash",
    sourceSequence: 3,
    metrics: { turnId: "turn-1", durationMs: 120, eventType: "tool_call" },
  },
  {
    id: "assistant-2",
    kind: "assistant",
    title: "Assistant",
    text: "Done",
    timestamp: null,
    status: "completed",
    toolName: null,
    sourceSequence: 4,
  },
];

const sequence = buildTraceTimeline(entries, "sequence");
assert.ok(sequence);
assert.equal(sequence.spans[0]?.lane, "input");
assert.equal(sequence.spans[1]?.lane, "model");
assert.equal(sequence.spans[2]?.lane, "tools");
assert.deepEqual(sequence.spans.map((span) => [span.start, span.end]), [[0, 1], [1, 2], [2, 3], [3, 4]]);

const duration = buildTraceTimeline(entries, "duration");
assert.ok(duration);
assert.equal(duration.hasTiming, true);
assert.equal(duration.spans[0]?.timingSource, "inferred");
assert.equal(duration.spans[1]?.timingSource, "measured");
assert.equal(duration.spans[1]?.durationMs, 900);
assert.equal(duration.spans[3]?.timingSource, "unknown");

const overlap = buildTraceTimeline([
  { ...entries[0]!, id: "overlap-a", timestamp: 1_000, metrics: { durationMs: 1_000 } },
  { ...entries[0]!, id: "overlap-b", sourceSequence: 2, timestamp: 1_200, metrics: { durationMs: 100 } },
], "duration");
assert.ok(overlap);
assert.equal(overlap.spans[1]?.start, 200);

const focus = traceTimelineFocusIndexes(entries, { start: 1, end: 2.1 }, "sequence");
assert.deepEqual([...focus], ["user-1", "assistant-1", "tool-1"]);
assert.deepEqual(traceTimelineRangeForIndexes(sequence, 1, 3), { start: 1, end: 4 });

const sections = traceContentSections(entries[2]!.text);
assert.deepEqual(sections.map((section) => section.label), ["Input", "Output"]);
assert.equal(sections[0]?.text, '{"command":"pwd"}');
assert.equal(sections[1]?.text, "/Users/patrick");

const unknown = buildTraceTimeline(
  entries.map((entry) => ({ ...entry, timestamp: null, metrics: undefined })),
  "duration",
);
assert.ok(unknown);
assert.equal(unknown.hasTiming, false);
assert.deepEqual(unknown.spans.map((span) => span.start), [0, 1, 2, 3]);
assert.ok(unknown.spans.every((span) => span.timingSource === "unknown"));

assert.equal(formatTraceDuration(null), "—");
assert.equal(formatTraceDuration(120), "120 ms");
assert.equal(formatTraceDuration(1_250), "1.3 s");
assert.equal(formatTraceDuration(119_500), "2m 0s");

const normalizedFold = parseStoredTrace(JSON.stringify([{
  ...entries[2],
  sourceSequence: 1,
  sourceSequences: Array.from({ length: 100 }, (_, index) => index + 1),
}]), "");
assert.equal(normalizedFold.entries[0]?.sourceSequences?.length, 64);
assert.equal(normalizedFold.entries[0]?.sourceSequences?.at(-1), 100);

const enriched = enrichTraceWithTelemetry(
  [
    { ...entries[0]!, id: "turn-user", sourceSequence: 1 },
    {
      ...entries[2]!,
      id: "merged-tool",
      sourceSequence: 2,
      sourceSequences: [2, 3],
      status: "running",
      metrics: undefined,
    },
    { ...entries[3]!, id: "turn-assistant", sourceSequence: 4 },
  ],
  {
    items: [{ turnId: "turn-1", kind: "tool", durationMs: 42, errorCategory: "timeout", sourceSequence: 3, status: "failed" }],
    turns: [{ id: "turn-1", sourceSequenceStart: 1, sourceSequenceEnd: 5 }],
    usage: [{ turnId: "turn-1", sourceSequence: 5, inputTokens: 100, outputTokens: 20, at: 5 }],
  } as unknown as Parameters<typeof enrichTraceWithTelemetry>[1],
);
assert.equal(enriched[0]?.metrics?.inputTokens, undefined);
assert.equal(enriched[1]?.status, "failed");
assert.equal(enriched[1]?.metrics?.durationMs, 42);
assert.equal(enriched[1]?.metrics?.errorCategory, "timeout");
assert.equal(enriched[1]?.metrics?.usageScope, undefined);
assert.equal(enriched[2]?.metrics?.inputTokens, 100);
assert.equal(enriched[2]?.metrics?.usageScope, "turn");

const interrupted = enrichTraceWithTelemetry(
  [{ ...entries[2]!, id: "interrupted-tool", sourceSequence: 2, status: "interrupted" }],
  {
    items: [{ turnId: null, kind: "tool", durationMs: null, errorCategory: null, sourceSequence: 2, status: "completed" }],
    turns: [],
    usage: [],
  } as unknown as Parameters<typeof enrichTraceWithTelemetry>[1],
);
assert.equal(interrupted[0]?.status, "interrupted");

const newestUsage = enrichTraceWithTelemetry(
  [{ ...entries[2]!, id: "usage-merged", sourceSequence: 2, sourceSequences: [2, 3], metrics: undefined }],
  {
    items: [],
    turns: [],
    usage: [
      { turnId: null, sourceSequence: 2, inputTokens: 10, outputTokens: 1, at: 2 },
      { turnId: null, sourceSequence: 3, inputTokens: 30, outputTokens: 3, at: 3 },
    ],
  } as unknown as Parameters<typeof enrichTraceWithTelemetry>[1],
);
assert.equal(newestUsage[0]?.metrics?.inputTokens, 30);

console.log("trace-view-model tests passed");
