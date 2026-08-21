import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { ExperimentalHostSignals } from "@get-bb/plugin-sdk/host";
import { z } from "zod";

const eventCategorySchema = z.enum(["user", "assistant", "tool", "system", "context", "telemetry", "step", "turn", "other"]);
const errorFilterSchema = z.enum(["all", "only"]);
const sessionStatusSchema = z.enum(["active", "completed", "unknown"]);

export const traceHostSessionSchema = z.object({
  id: z.string(),
  source: z.string(),
  title: z.string(),
  filePath: z.string(),
  model: z.string().nullable(),
  cwd: z.string().nullable(),
  startedAt: z.number().nullable(),
  updatedAt: z.number().nullable(),
  eventCount: z.number(),
  userCount: z.number(),
  assistantCount: z.number(),
  toolCount: z.number(),
  errorCount: z.number(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  durationMs: z.number().nullable(),
  status: sessionStatusSchema,
  fileSizeBytes: z.number(),
});

export const traceHostEventSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  line: z.number(),
  type: z.string(),
  kind: z.enum(["message", "tool", "step", "turn", "reasoning", "telemetry", "system"]),
  role: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  timestamp: z.number().nullable(),
  durationMs: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  usageIsTotal: z.boolean(),
  turn: z.number().nullable(),
  step: z.number().nullable(),
  depth: z.number(),
  model: z.string().nullable(),
  cwd: z.string().nullable(),
  rawJson: z.string(),
  rawTruncated: z.boolean(),
});

const facetSchema = z.object({ value: z.string(), count: z.number() });
export const traceHostSessionFacetsSchema = z.object({
  categories: z.array(facetSchema),
  toolTypes: z.array(facetSchema),
  errorCount: z.number(),
  totalEvents: z.number(),
});

const hostRootSchema = z.object({
  id: z.string().min(1).max(200),
  source: z.enum(["codex", "claude", "pi", "omp", "dsh", "custom"]),
  label: z.string().max(300),
  path: z.string().min(1).max(16_384),
  kind: z.literal("session"),
  format: z.enum(["jsonl", "zstd"]).optional(),
});

export const traceHostContract = defineRpcContract({
  compact: {
    input: z.null(),
    output: z.object({
      changed: z.boolean(),
      vacuumed: z.boolean(),
    }).strict(),
  },
  scan: {
    input: z.object({
      roots: z.array(hostRootSchema).max(100),
      forceFingerprintPaths: z.array(z.string().min(1).max(16_384)).max(20_000),
      forceFingerprintAll: z.boolean().optional(),
      maxFiles: z.number().int().min(1).max(64),
    }).strict(),
    output: z.object({
      changed: z.boolean(),
      complete: z.boolean(),
      processedPaths: z.array(z.string().max(16_384)).max(64),
      failedPaths: z.array(z.string().max(16_384)).max(64),
    }).strict(),
  },
  stats: {
    input: z.object({
      lastScanAt: z.number().nullable(),
      indexing: z.boolean(),
      lastError: z.string().nullable(),
    }).strict(),
    output: z.object({
      sessions: z.number(),
      events: z.number(),
      bytes: z.number(),
      lastScanAt: z.number().nullable(),
      indexing: z.boolean(),
      lastError: z.string().nullable(),
    }).strict(),
  },
  listSessions: {
    input: z.object({
      query: z.string().max(500).optional(),
      source: z.string().max(80).optional(),
      errorFilter: errorFilterSchema.optional(),
      status: sessionStatusSchema.optional(),
      hasTools: z.boolean().optional(),
      sort: z.enum(["updated", "started", "events", "duration", "errors"]).optional(),
      limit: z.number().int().min(1).max(200),
      offset: z.number().int().min(0).max(100_000),
    }).strict(),
    output: z.object({
      sessions: z.array(traceHostSessionSchema).max(200),
      total: z.number(),
    }).strict(),
  },
  getSession: {
    input: z.object({
      id: z.string().min(1),
      query: z.string().max(500).optional(),
      categories: z.array(eventCategorySchema).max(9).optional(),
      toolTypes: z.array(z.string().max(160)).max(100).optional(),
      errorFilter: errorFilterSchema.optional(),
      limit: z.number().int().min(1).max(2_000),
      offset: z.number().int().min(0).max(100_000),
    }).strict(),
    output: z.object({
      session: traceHostSessionSchema.nullable(),
      events: z.array(traceHostEventSchema).max(2_000),
      totalEvents: z.number(),
    }).strict(),
  },
  getSessionFacets: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: traceHostSessionFacetsSchema,
  },
  rawEvent: {
    input: z.object({
      id: z.string().min(1).max(1_024),
    }).strict(),
    output: z.object({
      raw: z.string().nullable(),
      truncated: z.boolean(),
    }).strict(),
  },
});

export const traceHostSignals = {} satisfies ExperimentalHostSignals;
