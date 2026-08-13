// bb-plugin-sessions — a hyper-local observability store for the six canonical
// agent providers, with overview metrics, provider aggregates, trace search,
// and rehydration in the same surface.

import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  createIndexer,
  migrateDb,
  type IndexProgress,
  type SessionRow,
} from "./src/indexer";
import { rehydrateSession, resolveRehydrateHostId } from "./src/rehydrate";
import {
  buildRichTelemetryDashboard,
  buildTelemetryDashboard,
  type CapabilityReport,
  type DashboardInput,
  type RichTelemetryResponse,
  type SourceStatusRecord,
} from "./src/telemetry";
import {
  getSourceForBbProviderId,
  isCoveredBySource,
  isKnownProviderId,
  PROVIDER_LABELS,
  PROVIDER_SOURCES,
  type ProviderId,
} from "./src/sources";
import { defaultIndexSettings, type IndexSettings } from "./src/types";
import { capTraceEntries, parseStoredTrace } from "./src/trace";
import { sourceIsStale } from "./src/source-freshness";

// ---------------------------------------------------------------------------
// Schemas (provider ids are dynamic — validated against the source registry)
// ---------------------------------------------------------------------------

const providerId = z.string().max(256).refine(isKnownProviderId, {
  message: "Unknown session source provider",
});
const searchResultSchema = z.object({
  id: z.string(),
  provider: z.string(),
  title: z.string(),
  cwd: z.string().nullable(),
  startedAt: z.number().nullable(),
  updatedAt: z.number().nullable(),
  model: z.string().nullable(),
  messageCount: z.number(),
  firstUserMessage: z.string().nullable(),
  summary: z.string().nullable(),
  origin: z.string().nullable(),
});

const sessionDetailSchema = searchResultSchema.extend({
  providerSessionId: z.string(),
  filePath: z.string().nullable(),
  gitRepoRoot: z.string().nullable(),
  transcript: z.string(),
  /** The detail RPC's display-only transcript cap. */
  transcriptPreviewTruncated: z.boolean(),
  /** The indexed source itself was bounded or only partially read. */
  transcriptSourceTruncated: z.boolean(),
  /** Kept as the display-preview flag for older clients. */
  transcriptTruncated: z.boolean(),
  transcriptLength: z.number(),
  truncated: z.boolean(),
  trace: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["user", "assistant", "tool", "system"]),
      title: z.string(),
      text: z.string(),
      timestamp: z.number().nullable(),
      status: z.enum(["running", "completed", "failed", "interrupted", "unknown"]),
      toolName: z.string().nullable(),
      sourceSequence: z.number(),
      sourceSequences: z.array(z.number()).max(64).optional(),
      metrics: z.object({
        durationMs: z.number().nullable().optional(),
        turnId: z.string().nullable().optional(),
        eventType: z.string().nullable().optional(),
        errorCategory: z.string().nullable().optional(),
        inputTokens: z.number().nullable().optional(),
        cachedInputTokens: z.number().nullable().optional(),
        cachedWriteTokens: z.number().nullable().optional(),
        outputTokens: z.number().nullable().optional(),
        reasoningTokens: z.number().nullable().optional(),
        totalTokens: z.number().nullable().optional(),
        contextUsed: z.number().nullable().optional(),
        contextLimit: z.number().nullable().optional(),
        usageScope: z.enum(["event", "turn"]).optional(),
      }).strict().optional(),
    }),
  ),
  traceTruncated: z.boolean(),
});

const analyticsSchema = z.object({
  status: z.enum(["active", "completed", "failed", "unknown"]),
  durationMs: z.number().nullable(),
  turnCount: z.number(),
  toolCalls: z.number(),
  toolErrors: z.number(),
  inputTokens: z.number().nullable(),
  cachedInputTokens: z.number().nullable(),
  cachedWriteTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  reasoningTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  contextPeak: z.number().nullable(),
  compactionCount: z.number(),
  failureCount: z.number(),
  delegatedCount: z.number(),
  costUsd: z.number().nullable(),
  costEstimated: z.boolean(),
  coverageJson: z.string(),
});
const sessionDetailWithAnalyticsSchema = sessionDetailSchema.extend({
  analytics: analyticsSchema,
});

const telemetryTotalsSchema = z.object({
  sessions: z.number(),
  active: z.number(),
  failed: z.number(),
  turns: z.number(),
  messages: z.number(),
  toolCalls: z.number(),
  toolErrors: z.number(),
  inputTokens: z.number().nullable(),
  cachedInputTokens: z.number().nullable(),
  cachedWriteTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  reasoningTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
  costEstimated: z.boolean(),
  contextPeak: z.number().nullable(),
  compactions: z.number(),
});
const telemetryProviderSchema = telemetryTotalsSchema.extend({
  provider: z.string(),
  label: z.string(),
  lastActivityAt: z.number().nullable(),
});
const telemetryRecentSchema = z.object({
  id: z.string(),
  provider: z.string(),
  title: z.string(),
  updatedAt: z.number().nullable(),
  status: z.string(),
  model: z.string().nullable(),
  messageCount: z.number(),
  turnCount: z.number(),
  toolCalls: z.number(),
  toolErrors: z.number(),
  totalTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
  costEstimated: z.boolean(),
});
const telemetrySchema = z.object({
  generatedAt: z.number(),
  range: z.enum(["24h", "7d", "30d", "lifetime"]),
  truncated: z.boolean(),
  totals: telemetryTotalsSchema,
  providers: z.array(telemetryProviderSchema),
  recent: z.array(telemetryRecentSchema),
  daily: z.array(z.object({
    date: z.string(),
    sessions: z.number(),
    turns: z.number(),
    toolErrors: z.number(),
    totalTokens: z.number().nullable(),
  })),
});
const dashboardInputSchema = z.object({
  view: z.enum(["provider", "unified"]),
  range: z.enum(["1h", "6h", "24h", "7d", "30d", "lifetime"]),
  providers: z.array(z.string().max(256)).max(20).optional(),
  hostId: z.string().max(256).optional(),
  projectId: z.string().max(256).optional(),
  model: z.string().max(1_000).optional(),
  archived: z.boolean().optional(),
}).strict();

const capabilityLevelSchema = z.enum(["complete", "partial", "unavailable"]);
const capabilityReportSchema = z.object({
  metadata: capabilityLevelSchema,
  turns: capabilityLevelSchema,
  tools: capabilityLevelSchema,
  tokens: capabilityLevelSchema,
  context: capabilityLevelSchema,
  errors: capabilityLevelSchema,
  latency: capabilityLevelSchema,
  models: capabilityLevelSchema,
}).strict();
const dashboardTotalsSchema = telemetryTotalsSchema.extend({
  sampleSize: z.number(),
  totalTokenCoverage: z.object({ known: z.number(), missing: z.number() }).strict(),
});
const dashboardProviderSchema = z.object({
  provider: z.string(),
  label: z.string(),
  availability: z.enum(["active", "historical", "unknown"]),
  sessions: z.number(),
  active: z.number(),
  failed: z.number(),
  turns: z.number(),
  messages: z.number(),
  toolCalls: z.number(),
  toolErrors: z.number(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
  costEstimated: z.boolean(),
  contextIssues: z.number(),
  contextPeak: z.number().nullable(),
  averageDurationMs: z.number().nullable(),
  lastActivityAt: z.number().nullable(),
  sampleSize: z.number(),
  coverage: capabilityReportSchema,
  historicalOnly: z.boolean(),
  totalTokenCoverage: z.object({ known: z.number(), missing: z.number() }).strict(),
}).strict();
const dashboardSessionSchema = z.object({
  id: z.string(),
  source: z.enum(["provider", "bb"]),
  provider: z.string(),
  hostId: z.string(),
  providerSessionId: z.string().nullable(),
  bbThreadId: z.string().nullable(),
  title: z.string(),
  cwd: z.string().nullable(),
  projectId: z.string().nullable(),
  model: z.string().nullable(),
  origin: z.string().nullable(),
  status: z.string(),
  startedAt: z.number().nullable(),
  updatedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  messageCount: z.number(),
  turnCount: z.number(),
  toolCalls: z.number(),
  toolErrors: z.number(),
  inputTokens: z.number().nullable(),
  cachedInputTokens: z.number().nullable(),
  cachedWriteTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  reasoningTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  contextPeak: z.number().nullable(),
  compactionCount: z.number(),
  failureCount: z.number(),
  delegatedCount: z.number(),
  archived: z.boolean(),
  costUsd: z.number().nullable(),
  costEstimated: z.boolean(),
  coverage: capabilityReportSchema,
  storeLabel: z.string(),
  sourcePath: z.string().nullable(),
  fingerprint: z.string().nullable(),
  linkState: z.enum(["none", "suggested", "linked"]),
  findingCount: z.number(),
}).strict();
const findingEvidenceSchema = z.object({
  source: z.enum(["provider", "bb"]),
  sourceRecordId: z.string(),
  sourceSequence: z.number().nullable(),
  eventType: z.string(),
  at: z.number().nullable(),
}).strict();
const findingSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  severity: z.enum(["info", "warning", "critical"]),
  source: z.enum(["provider", "bb"]),
  provider: z.string(),
  scope: z.enum(["range", "provider", "session", "turn", "tool"]),
  scopeId: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  recommendation: z.string(),
  metricValue: z.number().nullable(),
  threshold: z.number().nullable(),
  sampleSize: z.number(),
  coverageNote: z.string(),
  evidence: z.array(findingEvidenceSchema).max(8),
  createdAt: z.number(),
}).strict();
const dashboardResultSchema = z.object({
  view: z.enum(["provider", "unified"]),
  range: z.enum(["1h", "6h", "24h", "7d", "30d", "lifetime"]),
  generatedAt: z.number(),
  truncated: z.boolean(),
  stale: z.boolean(),
  indexedSessions: z.number(),
  totals: dashboardTotalsSchema,
  providers: z.array(dashboardProviderSchema).max(100),
  findings: z.array(findingSchema).max(100),
  sessions: z.array(dashboardSessionSchema).max(100),
  tools: z.array(z.object({
    provider: z.string(),
    name: z.string(),
    calls: z.number(),
    failures: z.number(),
    failureRate: z.number().nullable(),
    p50LatencyMs: z.number().nullable(),
    p95LatencyMs: z.number().nullable(),
  }).strict()).max(100),
  daily: z.array(z.object({
    date: z.string(),
    sessions: z.number(),
    turns: z.number(),
    toolErrors: z.number(),
    totalTokens: z.number().nullable(),
    byProvider: z.record(z.string(), z.object({
      sessions: z.number(),
      turns: z.number(),
      toolErrors: z.number(),
      totalTokens: z.number().nullable(),
    }).strict()),
  }).strict()).max(31),
  models: z.array(z.object({
    model: z.string(),
    provider: z.string(),
    sessions: z.number(),
    totalTokens: z.number().nullable(),
  }).strict()).max(30),
  coverage: z.array(z.object({
    provider: z.string(),
    capability: z.enum(["metadata", "turns", "tools", "tokens", "context", "errors", "latency", "models"]),
    level: capabilityLevelSchema,
    note: z.string(),
  }).strict()).max(1000),
}).strict();
const sourceStatusSchema = z.object({
  id: z.string(),
  provider: z.string(),
  label: z.string(),
  hostId: z.string(),
  storeKind: z.enum(["jsonl", "sqlite"]),
  pathLabel: z.string(),
  enabled: z.boolean(),
  detected: z.boolean(),
  supported: z.boolean(),
  availability: z.enum(["active", "historical", "unknown"]),
  count: z.number(),
  capabilities: capabilityReportSchema,
  cursor: z.string().nullable(),
  lastSuccessAt: z.number().nullable(),
  lastError: z.string().nullable(),
  lastWarning: z.string().nullable(),
  remoteDatabaseUnsupported: z.boolean(),
}).strict();
const richTelemetryResponseSchema = z.object({
  dashboard: dashboardResultSchema,
  sources: z.array(sourceStatusSchema).max(100),
  uncovered: z.array(z.object({ id: z.string(), displayName: z.string() }).strict()).max(100),
  indexing: z.object({
    active: z.boolean(),
    phase: z.string(),
    provider: z.string().nullable(),
    done: z.number(),
    total: z.number(),
  }).strict(),
  lastIndexAt: z.number().nullable(),
  error: z.string().nullable(),
  providerDiscoveryError: z.string().nullable(),
  providerDiscoveryState: z.enum(["fresh", "stale", "unknown"]),
}).strict();

const statusDtoSchema = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      enabled: z.boolean(),
      detected: z.boolean(),
      supported: z.boolean(),
      availability: z.enum(["active", "historical", "unknown"]),
      root: z.string().nullable(),
      count: z.number(),
      lastIndexedAt: z.number().nullable(),
      lastWarning: z.string().nullable(),
    }),
  ),
  /** Runtime BB providers that are currently available, including plugin providers. */
  activeProviders: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      sourceId: z.string().nullable(),
      sessionCount: z.number(),
    }),
  ).max(100),
  /** BB providers that exist but have no session source adapter yet. */
  uncovered: z.array(
    z.object({ id: z.string(), displayName: z.string() }),
  ).max(100),
  totalSessions: z.number(),
  indexing: z.object({
    active: z.boolean(),
    phase: z.string(),
    provider: z.string().nullable(),
    done: z.number(),
    total: z.number(),
  }),
  lastIndexAt: z.number().nullable(),
  error: z.string().nullable(),
  providerDiscoveryError: z.string().nullable(),
  providerDiscoveryState: z.enum(["fresh", "stale", "unknown"]),
});

const rehydrateResultSchema = z.object({
  threadId: z.string(),
  threadTitle: z.string(),
  project: z.object({ id: z.string(), name: z.string() }),
  environment: z.object({
    kind: z.enum(["unmanaged", "project-default"]),
    path: z.string().optional(),
    hostId: z.string().optional(),
  }),
  provider: z.string().nullable(),
  inputChars: z.number(),
  notes: z.array(z.string()),
});

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: statusDtoSchema,
  },
  reindex: {
    input: z
      .object({ providers: z.array(providerId).max(20).optional() })
      .strict(),
    output: z.object({ started: z.boolean() }),
  },
  search: {
    input: z
      .object({
        query: z.string().max(500),
        providers: z.array(providerId).max(20).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .strict(),
    output: z.object({
      results: z.array(searchResultSchema),
      total: z.number().int().nonnegative(),
    }),
  },
  getSession: {
    input: z.object({ id: z.string().min(1).max(2_000) }).strict(),
    output: z.object({ session: sessionDetailWithAnalyticsSchema }),
  },
  rehydrate: {
    input: z
      .object({
        id: z.string().min(1).max(2_000),
        projectId: z.string().max(256).optional(),
        providerId: z.string().max(256).optional(),
        mode: z.enum(["full", "condensed"]).optional(),
      })
      .strict(),
    output: rehydrateResultSchema,
  },
  listProviders: {
    input: z.object({ sessionId: z.string().min(1).max(2_000), projectId: z.string().max(256).optional() }).strict(),
    output: z.object({
      providers: z.array(
        z.object({
          id: z.string(),
          displayName: z.string(),
          available: z.boolean(),
        }),
      ).max(100),
      sourceDefault: z.record(z.string(), z.string().nullable()),
      error: z.string().nullable(),
      providerDiscoveryState: z.enum(["fresh", "stale", "unknown"]),
    }),
  },
  telemetry: {
    input: z.object({
      range: z.enum(["24h", "7d", "30d", "lifetime"]).optional(),
      providers: z.array(providerId).max(20).optional(),
    }).strict(),
    output: telemetrySchema,
  },
  telemetryDashboard: {
    input: dashboardInputSchema,
    output: richTelemetryResponseSchema,
  },
});

export type RpcContract = typeof rpcContract;
export type StatusDto = z.infer<typeof statusDtoSchema>;
export type SessionDetail = z.infer<typeof sessionDetailWithAnalyticsSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type RehydrateResult = z.infer<typeof rehydrateResultSchema>;
export type TelemetryDashboard = z.infer<typeof telemetrySchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_METADATA_CHARS = 8_000;
const MAX_SEARCH_RESPONSE_CHARS = 120_000;
// Keep the UTF-8 serialized projection comfortably below BB's 1 MiB command
// boundary even when the data contains multi-byte provider text.
const MAX_TELEMETRY_RESPONSE_CHARS = 200_000;
const MAX_CLI_OUTPUT_CHARS = 200_000;

function boundedCliJson(value: unknown, maxChars = MAX_CLI_OUTPUT_CHARS): string {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized.length <= maxChars) return serialized;
  let preview = serialized.slice(0, maxChars);
  let bounded = JSON.stringify({ truncated: true, output: preview }, null, 2);
  while (bounded.length > maxChars && preview.length > 0) {
    preview = preview.slice(0, Math.max(0, preview.length - Math.ceil((bounded.length - maxChars) * 1.25)));
    bounded = JSON.stringify({ truncated: true, output: preview }, null, 2);
  }
  return bounded;
}

function boundedMetadata(value: string | null, maxChars = MAX_METADATA_CHARS): string | null {
  if (value == null || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}

function boundedDiagnostics(values: readonly string[]): string {
  return values
    .map((value) => boundedMetadata(value, 256) ?? "<empty>")
    .join(", ");
}

function safeDiagnostic(prefix: string, error: unknown): string {
  const kind = error instanceof Error && error.name ? error.name : "unknown error";
  return `${prefix} (${kind})`;
}

function rowToSearchResult(row: SessionRow) {
  return {
    id: boundedMetadata(row.id, 2_000) ?? "unknown",
    provider: boundedMetadata(row.provider, 256) ?? "unknown",
    title: boundedMetadata(row.title, 2_000) ?? "Untitled session",
    cwd: boundedMetadata(row.cwd, 4_000),
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    model: boundedMetadata(row.model, 1_000),
    messageCount: row.messageCount,
    firstUserMessage: boundedMetadata(row.firstUserMessage, MAX_METADATA_CHARS),
    summary: boundedMetadata(row.summary, MAX_METADATA_CHARS),
    origin: boundedMetadata(row.origin, 1_000),
  };
}

function capSearchResults<T>(rows: T[], maxChars = MAX_SEARCH_RESPONSE_CHARS): T[] {
  const output: T[] = [];
  let used = 2;
  for (const row of rows) {
    const next = JSON.stringify(row).length + (output.length > 0 ? 1 : 0);
    if (used + next > maxChars) break;
    output.push(row);
    used += next;
  }
  return output;
}

const TELEMETRY_ARRAY_KEYS = [
  "recent",
  "providers",
  "daily",
  "sessions",
  "findings",
  "tools",
  "models",
  "coverage",
] as const;

function capTelemetryProjection<T extends { truncated: boolean }>(
  value: T,
  maxChars = MAX_TELEMETRY_RESPONSE_CHARS,
): T {
  let output = { ...value, truncated: false } as T;
  let truncated = false;
  for (let attempt = 0; attempt < 2_000 && JSON.stringify(output).length > maxChars; attempt++) {
    let changed = false;
    for (const key of TELEMETRY_ARRAY_KEYS) {
      const candidate = (output as Record<string, unknown>)[key];
      if (!Array.isArray(candidate) || candidate.length === 0) continue;
      const nextLength = Math.max(0, candidate.length - Math.max(1, Math.ceil(candidate.length / 4)));
      output = { ...output, [key]: candidate.slice(0, nextLength) } as T;
      truncated = true;
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return { ...output, truncated } as T;
}

function capRichTelemetryResponse(response: RichTelemetryResponse): RichTelemetryResponse {
  let dashboard = capTelemetryProjection(response.dashboard, 120_000);
  let output: RichTelemetryResponse = { ...response, dashboard };
  for (let attempt = 0; attempt < 2_000 && JSON.stringify(output).length > MAX_TELEMETRY_RESPONSE_CHARS; attempt++) {
    const currentDashboardLength = JSON.stringify(dashboard).length;
    const nextDashboard = capTelemetryProjection(
      dashboard,
      Math.max(50_000, Math.floor(currentDashboardLength * 0.75)),
    );
    if (JSON.stringify(nextDashboard).length < currentDashboardLength) {
      dashboard = nextDashboard;
      output = { ...output, dashboard };
      continue;
    }
    if (output.uncovered.length > 1) {
      output = {
        ...output,
        dashboard: { ...dashboard, truncated: true },
        uncovered: output.uncovered.slice(0, Math.max(1, Math.floor(output.uncovered.length * 0.75))),
      };
      dashboard = output.dashboard;
      continue;
    }
    if (output.sources.length > 1) {
      output = {
        ...output,
        dashboard: { ...dashboard, truncated: true },
        sources: output.sources.slice(0, Math.max(1, Math.floor(output.sources.length * 0.75))),
      };
      dashboard = output.dashboard;
      continue;
    }
    break;
  }
  return output;
}

function rowToAnalytics(row: SessionRow) {
  return {
    status: row.status,
    durationMs: row.durationMs,
    turnCount: row.turnCount,
    toolCalls: row.toolCalls,
    toolErrors: row.toolErrors,
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    cachedWriteTokens: row.cachedWriteTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    totalTokens: row.totalTokens,
    contextPeak: row.contextPeak,
    compactionCount: row.compactionCount,
    failureCount: row.failureCount,
    delegatedCount: row.delegatedCount,
    costUsd: row.costUsd,
    costEstimated: row.costEstimated === 1,
    coverageJson: boundedMetadata(row.coverageJson, 4_000) ?? "{}",
  };
}

function rowToTrace(row: SessionRow) {
  const parsed = parseStoredTrace(row.traceJson, row.transcript);
  const capped = capTraceEntries(parsed.entries);
  return {
    entries: capped.entries,
    truncated: row.traceTruncated === 1 || parsed.truncated || capped.truncated,
  };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const INDEX_SCHEMA_VERSION = 4;
const MAX_CLI_TRANSCRIPT_CHARS = 120_000;

function boundedText(text: string, maxChars: number): { value: string; truncated: boolean } {
  if (text.length <= maxChars) return { value: text, truncated: false };
  return {
    value: `${text.slice(0, maxChars)}\n\n… (transcript truncated)`,
    truncated: true,
  };
}

function telemetryCapabilities(provider: string): CapabilityReport {
  const unavailable: CapabilityReport = {
    metadata: "unavailable",
    turns: "unavailable",
    tools: "unavailable",
    tokens: "unavailable",
    context: "unavailable",
    errors: "unavailable",
    latency: "unavailable",
    models: "unavailable",
  };
  if (provider === "claude") {
    return { ...unavailable, metadata: "complete", tools: "complete", errors: "partial", models: "partial" };
  }
  if (provider === "hermes") {
    return { ...unavailable, metadata: "complete", tools: "complete", turns: "partial", tokens: "complete", errors: "partial", latency: "partial", models: "complete" };
  }
  if (provider === "opencode") {
    return { ...unavailable, metadata: "partial", tools: "partial", errors: "partial" };
  }
  return { ...unavailable, metadata: "complete", turns: "complete", tools: "complete", tokens: "complete", errors: "partial", latency: "partial", models: "complete" };
}

function parseProviderList(
  argv: string[],
  mode: "positional" | "flag" = "positional",
): ProviderId[] | undefined {
  if (invalidProviderIds(argv, mode).length > 0) return [];
  const out: ProviderId[] = [];
  let requested = false;
  if (mode === "flag") {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] !== "--provider") continue;
      requested = true;
      const value = argv[i + 1];
      if (value && isKnownProviderId(value)) out.push(value);
      i++;
    }
  } else {
    for (const a of argv) {
      if (a.startsWith("-")) continue;
      requested = true;
      if (isKnownProviderId(a)) out.push(a);
    }
  }
  return requested ? [...new Set(out)] : undefined;
}

function invalidProviderIds(
  argv: string[],
  mode: "positional" | "flag" = "positional",
): string[] {
  const invalid: string[] = [];
  if (mode === "flag") {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] !== "--provider") continue;
      const value = argv[i + 1];
      if (!value) invalid.push("<missing>");
      else if (!isKnownProviderId(value)) invalid.push(value);
      i++;
    }
  } else {
    for (const value of argv) {
      if (!value.startsWith("-") && !isKnownProviderId(value)) invalid.push(value);
    }
  }
  return [...new Set(invalid)];
}

function providerFilter(providers: string[] | undefined): ProviderId[] | undefined {
  if (providers === undefined) return undefined;
  return providers.every(isKnownProviderId)
    ? [...new Set(providers)] as ProviderId[]
    : [];
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function hasFlag(argv: string[], ...names: string[]): boolean {
  return names.some((n) => argv.includes(n));
}

function parseSearchArgs(argv: string[]): {
  query?: string;
  unexpectedPositionals: string[];
  unknownFlags: string[];
} {
  let query: string | undefined;
  const unexpectedPositionals: string[] = [];
  const unknownFlags: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") continue;
    if (arg === "--provider" || arg === "--limit") {
      i++;
      continue;
    }
    if (arg.startsWith("-")) {
      unknownFlags.push(arg);
      continue;
    }
    if (query === undefined) query = arg;
    else unexpectedPositionals.push(arg);
  }
  return { query, unexpectedPositionals, unknownFlags };
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  migrateDb(db);

  // Settings are generated from the source registry: every registered source
  // gets an enable toggle and an optional path override (empty = auto-detect).
  const settingDefs: Record<string, {
    type: "boolean" | "string";
    label: string;
    description?: string;
    default?: string | boolean;
  }> = {};
  for (const s of PROVIDER_SOURCES) {
    settingDefs[`${s.id}Enabled`] = {
      type: "boolean",
      label: `Index ${s.label} sessions`,
      default: true,
    };
    settingDefs[`${s.id}Path`] = {
      type: "string",
      label: `${s.label} store path`,
      description: `Where ${s.label} stores sessions. Leave empty to auto-detect.`,
      default: s.defaultRoots[0],
    };
  }
  const settings = bb.settings.define(
    settingDefs as Parameters<typeof bb.settings.define>[0],
  );

  const boolVal = (
    v: string | boolean | undefined,
    fallback: boolean,
  ): boolean => (typeof v === "boolean" ? v : fallback);
  const strVal = (
    v: string | boolean | undefined,
    fallback: string,
  ): string => (typeof v === "string" && v.trim() !== "" ? v : fallback);

  const getSettings = async (): Promise<IndexSettings> => {
    const v = await settings.get();
    const d = defaultIndexSettings();
    const configuredPiPath = strVal(v.piPath, d.piPath);
    const configuredPrimePath = strVal(v.primePath, d.primePath);
    return {
      piEnabled: boolVal(v.piEnabled, d.piEnabled),
      piPath: configuredPiPath,
      primeEnabled: boolVal(v.primeEnabled, d.primeEnabled),
      primePath: configuredPrimePath,
      ompEnabled: boolVal(v.ompEnabled, d.ompEnabled),
      ompPath: strVal(v.ompPath, d.ompPath),
      hermesEnabled: boolVal(v.hermesEnabled, d.hermesEnabled),
      hermesPath: strVal(v.hermesPath, strVal(v.primeDbPath, d.hermesPath)),
      codexEnabled: boolVal(v.codexEnabled, d.codexEnabled),
      codexPath: strVal(v.codexPath, d.codexPath),
      claudeEnabled: boolVal(v.claudeEnabled, d.claudeEnabled),
      claudePath: strVal(v.claudePath, d.claudePath),
      opencodeEnabled: boolVal(v.opencodeEnabled, d.opencodeEnabled),
      opencodePath: strVal(v.opencodePath, d.opencodePath),
    } satisfies IndexSettings;
  };

  const indexer = createIndexer({
    db,
    kv: bb.storage.kv,
    log: (m) => bb.log.info(m),
    publish: (p: IndexProgress) => {
      try {
        bb.realtime.publish("sessions-index", p);
      } catch {
        // ignore
      }
    },
    getSettings,
  });

  const getLastIndexAt = async (): Promise<number | null> =>
    (await bb.storage.kv.get<number>("lastIndexAt")) ?? null;

  type RuntimeProvider = { id: string; displayName: string; available: boolean };
  type ProviderDiscoveryState = "fresh" | "stale" | "unknown";
  const providerCatalogKey = "sessionsProviderCatalog";
  let providerCatalogCache: RuntimeProvider[] | null = null;

  const normalizeProviderCatalog = (value: unknown): RuntimeProvider[] | null => {
    if (!Array.isArray(value)) return null;
    const output: RuntimeProvider[] = [];
    const seen = new Set<string>();
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const candidate = item as Record<string, unknown>;
      if (
        typeof candidate.id !== "string" ||
        typeof candidate.displayName !== "string" ||
        typeof candidate.available !== "boolean" ||
        !candidate.id.trim() ||
        seen.has(candidate.id)
      ) continue;
      seen.add(candidate.id);
      output.push({
        id: boundedMetadata(candidate.id, 256) ?? "unknown",
        displayName: boundedMetadata(candidate.displayName, 1_000) ?? "Unknown provider",
        available: candidate.available,
      });
      if (output.length >= 100) break;
    }
    return output;
  };

  const readCachedProviderCatalog = async (): Promise<RuntimeProvider[] | null> => {
    try {
      const cached = normalizeProviderCatalog(await bb.storage.kv.get<unknown>(providerCatalogKey));
      if (cached) providerCatalogCache = cached;
      return cached;
    } catch {
      return null;
    }
  };

  const getBbProviders = async (hostId?: string): Promise<{
    providers: RuntimeProvider[];
    error: string | null;
    state: ProviderDiscoveryState;
  }> => {
    try {
      const seen = new Set<string>();
      const output: RuntimeProvider[] = [];
      for (const provider of await bb.sdk.providers.list(hostId ? { hostId } : undefined)) {
        if (seen.has(provider.id)) continue;
        seen.add(provider.id);
        output.push({
          id: boundedMetadata(provider.id, 256) ?? "unknown",
          displayName: boundedMetadata(provider.displayName, 1_000) ?? "Unknown provider",
          available: provider.available,
        });
        if (output.length >= 100) break;
      }
      if (!hostId) {
        providerCatalogCache = output;
        void bb.storage.kv.set(providerCatalogKey, output).catch(() => undefined);
      }
      return { providers: output, error: null, state: "fresh" };
    } catch (err) {
      const error = safeDiagnostic("Provider discovery failed", err);
      bb.log.error(error);
      let providers = hostId ? null : providerCatalogCache;
      if (!hostId && providers === null) providers = await readCachedProviderCatalog();
      return {
        providers: providers ?? [],
        error,
        state: providers === null ? "unknown" : "stale",
      };
    }
  };

  /** Agent tools are invoked inside a project context. Resolve only local
   * primary-host roots and fail closed when that context cannot be resolved;
   * the observability UI/CLI remain the explicit human-facing global views. */
  const resolveAgentScope = async (projectId: string): Promise<{ roots: string[] }> => {
    try {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      const project = projects.find((candidate) => candidate.id === projectId);
      if (!project) return { roots: [] };
      const roots = project.sources
        .filter((source) => !source.hostId || source.hostId === "primary")
        .map((source) => source.path)
        .filter((path): path is string => typeof path === "string" && path.trim().length > 0)
        .flatMap((path) => {
          const resolved = resolvePath(path);
          try {
            // Keep both representations: indexed rows may contain either a
            // configured symlink path or its canonical target path. The
            // project explicitly owns the source, so both are valid scope
            // aliases; unrelated projects remain outside the root set.
            return [...new Set([resolved, realpathSync(resolved)])];
          } catch {
            return [resolved];
          }
        });
      return { roots: [...new Set(roots)] };
    } catch (error) {
      bb.log.error(safeDiagnostic("Could not resolve agent project scope", error));
      return { roots: [] };
    }
  };

  // Make the local session corpus available to provider-backed agents. These
  // tools return normalized metadata and bounded transcript/trace projections;
  // raw store paths stay a human-facing detail of the UI/CLI.
  bb.agents.registerTool({
    name: "sessions_search",
    description: "Search the local Sessions index across prior agent conversations using BM25 full-text search.",
    instructions: "Use sessions_search when prior work, decisions, errors, or context may already exist in another local agent session.",
    parameters: z.object({
      query: z.string().max(500),
      providers: z.array(providerId).max(20).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    experimental_statusLabels: {
      pending: "Searching local sessions",
      completed: "Searched local sessions",
    },
    async execute({ query, providers, limit }, context) {
      await indexer.ensureIndexed({ force: false });
      const scope = await resolveAgentScope(context.projectId);
      const want = providerFilter(providers);
      const result = indexer.searchWithTotal(query, want, limit ?? 10, scope);
      return JSON.stringify({
        total: result.total,
        results: capSearchResults(result.rows.map(rowToSearchResult)),
      });
    },
  });

  bb.agents.registerTool({
    name: "sessions_get",
    description: "Read one indexed local agent session, including bounded conversation text and telemetry; set includeTrace when event-level tool evidence is needed.",
    parameters: z.object({
      id: z.string().min(1).max(2_000),
      maxChars: z.number().int().min(1_000).max(120_000).optional(),
      includeTrace: z.boolean().optional(),
    }),
    experimental_statusLabels: {
      pending: "Reading local session",
      completed: "Read local session",
    },
    async execute({ id, maxChars, includeTrace }, context) {
      await indexer.ensureIndexed({ force: false });
      const scope = await resolveAgentScope(context.projectId);
      const row = indexer.get(id, scope);
      if (!row) return { content: [{ type: "text", text: "Session not found" }], isError: true };
      const cap = maxChars ?? 120_000;
      const transcriptTruncated = row.transcriptLength > cap || row.transcript.length < row.transcriptLength;
      const transcript = transcriptTruncated
        ? `${row.transcript.slice(0, cap)}\n\n… (tool response truncated; search the session for a narrower passage)`
        : row.transcript;
      const result: Record<string, unknown> = {
        ...rowToSearchResult(row),
        providerSessionId: boundedMetadata(row.providerSessionId, 2_000) ?? "unknown",
        transcript,
        transcriptLength: row.transcriptLength,
        transcriptTruncated,
        analytics: rowToAnalytics(row),
      };
      if (includeTrace) {
        const trace = rowToTrace(row);
        result.trace = trace.entries;
        result.traceTruncated = trace.truncated;
      }
      return JSON.stringify(result);
    },
  });

  bb.agents.registerTool({
    name: "sessions_telemetry",
    description: "Summarize local agent session telemetry by time range and provider.",
    parameters: z.object({
      range: z.enum(["24h", "7d", "30d", "lifetime"]).optional(),
      providers: z.array(providerId).max(20).optional(),
    }),
    async execute({ range, providers }, context) {
      await indexer.ensureIndexed({ force: false });
      const scope = await resolveAgentScope(context.projectId);
      return JSON.stringify(capTelemetryProjection(
        buildTelemetryDashboard(db, range ?? "7d", providerFilter(providers), Date.now(), scope),
      ));
    },
  });

  bb.agents.configure(() => ({
    tools: ["sessions_search", "sessions_get", "sessions_telemetry"],
    skills: [],
    instructions: "The Sessions plugin can search prior local agent conversations and summarize their telemetry. Use sessions_search before assuming earlier work is unavailable.",
  }));

  const buildStatus = async (): Promise<z.infer<typeof statusDtoSchema>> => {
    const [settings, providerCatalog, lastIndexAt] = await Promise.all([
      getSettings(),
      getBbProviders(),
      getLastIndexAt(),
    ]);
    const bbProviders = providerCatalog.providers;
    // The provider registry is the runtime source of truth. A provider can be
    // installed but unavailable; it must not make a source look supported or
    // appear in the observability UI.
    const activeBbProviders = bbProviders.filter((p) => p.available);
    const bbIds = new Set(activeBbProviders.map((p) => p.id));
    // An initial provider-list failure does not prove that every indexed
    // source is historical. Keep support explicitly unknown until discovery
    // succeeds (or a cached catalog is available), while exposing the error
    // separately to the UI.
    const supportIds = providerCatalog.state === "fresh" ? bbIds : new Set<string>();
    const full = indexer.status(settings, lastIndexAt, supportIds);
    const providers = full.providers.map((provider) => {
      const availability = providerCatalog.state !== "fresh"
        ? "unknown"
        : provider.supported
          ? "active"
          : "historical";
      return {
        ...provider,
        root: boundedMetadata(provider.root, 4_000),
        lastWarning: boundedMetadata(provider.lastWarning, 2_000),
        supported: availability === "active",
        availability,
      } as const;
    });
    const sourceStatus = new Map(providers.map((provider) => [provider.id, provider]));
    const activeProviders = providerCatalog.state === "fresh" ? activeBbProviders.map((provider) => {
      const source = getSourceForBbProviderId(provider.id);
      return {
        id: provider.id,
        displayName: provider.displayName,
        sourceId: source?.id ?? null,
        sessionCount: source ? sourceStatus.get(source.id)?.count ?? 0 : 0,
      };
    }) : [];
    const uncovered = providerCatalog.state === "fresh"
      ? activeBbProviders.filter((p) => !isCoveredBySource(p.id))
      : [];
    return {
      ...full,
      providers,
      activeProviders,
      uncovered,
      error: full.error,
      providerDiscoveryError: providerCatalog.error,
      providerDiscoveryState: providerCatalog.state,
    };
  };

  // -------------------------------------------------------------------------
  // RPC
  // -------------------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    async status() {
      return buildStatus();
    },
    async reindex({ providers }) {
      if (providers?.some((provider) => !isKnownProviderId(provider))) {
        throw new Error("Unknown session source provider");
      }
      const want = providerFilter(providers);
      if (providers !== undefined && providers.length === 0) return { started: false };
      // Fire-and-forget; progress arrives on the sessions-index channel.
      void indexer
        .ensureIndexed({ force: true, providers: want })
        .catch((err) => bb.log.error(safeDiagnostic("Reindex failed", err)));
      return { started: true };
    },
    async search({ query, providers, limit }) {
      const want = providerFilter(providers);
      const { rows, total } = indexer.searchWithTotal(query, want, limit ?? 50);
      return { results: capSearchResults(rows.map(rowToSearchResult)), total };
    },
    async getSession({ id }) {
      const row = indexer.get(id);
      if (!row) throw new Error("Session not found");
      const PREVIEW = 40_000;
      const trace = rowToTrace(row);
      const transcriptPreviewTruncated = row.transcriptLength > PREVIEW;
      const transcriptSourceTruncated = row.truncated === 1;
      return {
        session: {
          ...rowToSearchResult(row),
          providerSessionId: boundedMetadata(row.providerSessionId, 2_000) ?? "unknown",
          filePath: boundedMetadata(row.filePath, 4_000),
          gitRepoRoot: boundedMetadata(row.gitRepoRoot, 4_000),
          transcript:
            transcriptPreviewTruncated
              ? row.transcript.slice(0, PREVIEW) + "\n\n… (preview truncated)"
              : row.transcript,
          transcriptPreviewTruncated,
          transcriptSourceTruncated,
          transcriptTruncated: transcriptPreviewTruncated,
          transcriptLength: row.transcriptLength,
          truncated: row.truncated === 1,
          trace: trace.entries,
          traceTruncated: trace.truncated,
          analytics: rowToAnalytics(row),
        },
      };
    },
    async rehydrate({ id, projectId, providerId, mode }) {
      const row = indexer.get(id);
      if (!row) throw new Error("Session not found");
      try {
        return await rehydrateSession(bb, row, { projectId, providerId, mode });
      } catch (error) {
        throw new Error(safeDiagnostic("Rehydration failed", error));
      }
    },
    async listProviders({ sessionId, projectId }) {
      const row = indexer.get(sessionId);
      if (!row) throw new Error("Session not found");
      let hostId: string | undefined;
      try {
        hostId = await resolveRehydrateHostId(bb, row, projectId);
      } catch (error) {
        bb.log.error(safeDiagnostic("Could not resolve rehydration host", error));
      }
      const catalog = await getBbProviders(hostId);
      // A cached catalog is useful for status context, but it is not proof
      // that an explicit rehydration provider is runnable on this target.
      // Keep Auto available while discovery is stale/unknown.
      const providers = catalog.state === "fresh"
        ? catalog.providers.filter((provider) => provider.available)
        : [];
      const sourceDefault: Record<string, string | null> = {};
      for (const s of PROVIDER_SOURCES) {
        sourceDefault[s.id] = providers.some((p) => p.id === s.bbProviderId)
          ? s.bbProviderId
          : null;
      }
      return {
        providers,
        sourceDefault,
        error: catalog.error,
        providerDiscoveryState: catalog.state,
      };
    },
    async telemetry({ range, providers }) {
      return capTelemetryProjection(
        buildTelemetryDashboard(db, range ?? "7d", providerFilter(providers)),
      );
    },
    async telemetryDashboard(input) {
      const status = await buildStatus();
      const runtimeSourceIds = new Set(
        status.activeProviders
          .map((provider) => provider.sourceId)
          .filter((provider): provider is string => provider !== null),
      );
      // Runtime availability controls rehydration/actions, not whether
      // historical rows are observable. Keep indexed/detected sources visible
      // even when their provider CLI is currently unavailable.
      const visibleSourceIds = new Set([
        ...runtimeSourceIds,
        ...status.providers
          .filter((provider) => provider.detected || provider.count > 0 || provider.lastWarning)
          .map((provider) => provider.id),
      ]);
      const sources: SourceStatusRecord[] = status.providers
        .filter((provider) => visibleSourceIds.has(provider.id))
        .map((provider) => {
          const source = PROVIDER_SOURCES.find((candidate) => candidate.id === provider.id);
          const runtimeProvider = status.activeProviders.find((candidate) => candidate.sourceId === provider.id);
          return {
            id: `${provider.id}:primary`,
            provider: provider.id,
            label: boundedMetadata(runtimeProvider?.displayName ?? provider.label, 1_000) ?? "Unknown source",
            hostId: "primary",
            storeKind: provider.id === "hermes" || provider.id === "opencode" ? "sqlite" : "jsonl",
            pathLabel: boundedMetadata(
              provider.root
                ? [provider.root, ...(source?.archiveRoots ?? [])].join(" + ")
                : source?.defaultRoots[0] ?? provider.id,
              2_000,
            ) ?? provider.id,
            enabled: provider.enabled,
            detected: provider.detected,
            supported: provider.supported,
            availability: provider.availability,
            count: provider.count,
            capabilities: telemetryCapabilities(provider.id),
            cursor: null,
            lastSuccessAt: provider.lastIndexedAt,
            lastError: null,
            lastWarning: boundedMetadata(provider.lastWarning, 2_000),
            remoteDatabaseUnsupported: false,
          };
        });
      const requestedProviders = input.providers !== undefined
        ? input.providers.every((provider) => visibleSourceIds.has(provider))
          ? input.providers
          : []
        : [...visibleSourceIds];
      const dashboardInput: DashboardInput = {
        ...(input as DashboardInput),
        providers: requestedProviders,
      };
      const dashboard = buildRichTelemetryDashboard(db, dashboardInput, sources);
      return capRichTelemetryResponse({
        dashboard: {
          ...dashboard,
          stale: status.indexing.active || status.error !== null || status.providerDiscoveryError !== null || sources.some((source) => source.lastWarning !== null || source.lastError !== null || sourceIsStale(source)),
        },
        sources,
        uncovered: status.uncovered,
        indexing: status.indexing,
        lastIndexAt: status.lastIndexAt,
        error: status.error,
        providerDiscoveryError: status.providerDiscoveryError,
        providerDiscoveryState: status.providerDiscoveryState,
      } satisfies RichTelemetryResponse);
    },
  });

  // -------------------------------------------------------------------------
  // CLI: bb sessions …
  // -------------------------------------------------------------------------

  bb.cli.register({
    name: "sessions",
    summary: "Search, rehydrate, and measure locally discovered provider sessions",
    commands: [
      { name: "status", summary: "Show auto-discovered sources and index status", usage: "bb sessions status [--json]" },
      { name: "reindex", summary: "Scan provider stores and refresh the index", usage: "bb sessions reindex [--full] [pi|prime|omp|hermes|codex|claude …]" },
      { name: "search", summary: "Full-text search across indexed sessions", usage: "bb sessions search <query> [--provider <id>] [--limit <n>] [--json]" },
      { name: "get", summary: "Show one indexed session (metadata + transcript)", usage: "bb sessions get <id> [--json]" },
      { name: "rehydrate", summary: "Rehydrate an indexed session into a BB thread", usage: "bb sessions rehydrate <id> [--project <id>] [--provider <id>] [--condensed|--full] [--json]" },
      { name: "telemetry", summary: "Summarize local session telemetry", usage: "bb sessions telemetry [--range 24h|7d|30d|lifetime] [--provider <id>] [--json]" },
    ],
    async run(argv, ctx) {
      const [cmd, ...rest] = argv;
      const json = hasFlag(rest, "--json");
      const print = (obj: unknown) => {
        const text = json
          ? boundedCliJson(obj)
          : boundedMetadata(String(obj), MAX_CLI_OUTPUT_CHARS) ?? "";
        return { exitCode: 0, stdout: text + "\n" };
      };
      switch (cmd) {
        case "status": {
          const s = await buildStatus();
          if (json) return print(s);
          const lines = [
            `Sessions indexed: ${s.totalSessions}`,
            `Last index: ${s.lastIndexAt ? new Date(s.lastIndexAt).toISOString() : "never"}`,
            s.indexing.active ? `Indexing: ${s.indexing.phase} (${s.indexing.provider ?? ""}) ${s.indexing.done}/${s.indexing.total}` : "Indexing: idle",
            s.error ? `Error: ${s.error}` : "",
            s.providerDiscoveryError ? `Provider discovery: ${s.providerDiscoveryError}` : "",
          ];
          for (const p of s.providers) {
            const status = !p.enabled
              ? "disabled"
              : !p.detected
                ? "not detected"
                : p.availability === "unknown"
                  ? "detected (provider availability unknown)"
                : !p.supported
                  ? "detected (no bb provider)"
                  : "active";
            const root = p.detected && p.root ? ` @ ${p.root}` : "";
            lines.push(
              `  ${p.label}: ${p.count} indexed · ${status}${root}${p.lastWarning ? ` · warning: ${p.lastWarning}` : ""}`,
            );
          }
          if (s.uncovered.length > 0) {
            lines.push(
              `BB providers without a session source: ${s.uncovered
                .map((u) => `${u.displayName} (${u.id})`)
                .join(", ")}`,
            );
          }
          return print(lines.filter(Boolean).join("\n"));
        }
        case "reindex": {
          const invalid = invalidProviderIds(rest);
          if (invalid.length > 0) {
            return {
              exitCode: 1,
              stderr: `Unknown session source provider: ${boundedDiagnostics(invalid)}\n`,
            };
          }
          const providers = parseProviderList(rest);
          const res = await indexer.ensureIndexed({
            force: hasFlag(rest, "--full", "--force"),
            providers,
          });
          const s = await buildStatus();
          if (json) return print({ ...res, totalSessions: s.totalSessions });
          return print(
            `Index refreshed: ${res.indexed} new/updated, ${res.removed} removed. Total: ${s.totalSessions} sessions.`,
          );
        }
        case "search": {
          const parsedSearch = parseSearchArgs(rest);
          const query = parsedSearch.query;
          if (!query) {
            return {
              exitCode: 1,
              stderr: "Usage: bb sessions search <query> [--provider <id>] [--limit <n>]\n",
            };
          }
          if (parsedSearch.unexpectedPositionals.length > 0 || parsedSearch.unknownFlags.length > 0) {
            const unexpected = [
              ...parsedSearch.unexpectedPositionals,
              ...parsedSearch.unknownFlags,
            ];
            return {
              exitCode: 1,
              stderr: `Unexpected search argument: ${boundedDiagnostics(unexpected)}\n`,
            };
          }
          if (query.length > 500) {
            return { exitCode: 1, stderr: "Search query must be 500 characters or fewer\n" };
          }
          const providers = parseProviderList(rest, "flag");
          const invalid = invalidProviderIds(rest, "flag");
          if (invalid.length > 0) {
            return {
              exitCode: 1,
              stderr: `Unknown session source provider: ${boundedDiagnostics(invalid)}\n`,
            };
          }
          const parsedLimit = Number(flagValue(rest, "--limit") ?? "20");
          const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
            ? Math.min(100, Math.round(parsedLimit))
            : 20;
          const { rows, total } = indexer.searchWithTotal(query, providers, limit);
          if (json) return print({ total, results: capSearchResults(rows.map(rowToSearchResult)) });
          if (rows.length === 0) return print("No matching sessions.");
          const lines = rows.map((r, i) => {
            const when = r.updatedAt
              ? new Date(r.updatedAt).toISOString().slice(0, 10)
              : "?";
            const title = boundedMetadata(r.title, 2_000) ?? "Untitled session";
            const cwd = r.cwd ? ` · ${boundedMetadata(r.cwd, 4_000)}` : "";
            const id = boundedMetadata(r.id, 2_000) ?? "unknown";
            return `${i + 1}. [${r.provider}] ${title} (${when}, ${r.messageCount} msgs)${cwd}\n   id: ${id}`;
          });
          const summary =
            rows.length < total
              ? `\n${rows.length} of ${total} matching sessions (use --limit to see more).`
              : `\n${total} matching session${total === 1 ? "" : "s"}.`;
          return print(lines.join("\n") + summary);
        }
        case "get": {
          const id = rest.find((a) => !a.startsWith("-"));
          if (!id) {
            return { exitCode: 1, stderr: "Usage: bb sessions get <id>\n" };
          }
          const row = indexer.get(id);
          if (!row) return { exitCode: 1, stderr: "Session not found\n" };
          if (json) {
            const transcript = boundedText(row.transcript, MAX_CLI_TRANSCRIPT_CHARS);
            const trace = rowToTrace(row);
            const transcriptTruncated = transcript.truncated || row.transcript.length < row.transcriptLength;
            return print({
              ...rowToSearchResult(row),
              providerSessionId: boundedMetadata(row.providerSessionId, 2_000) ?? "unknown",
              filePath: boundedMetadata(row.filePath, 4_000),
              gitRepoRoot: boundedMetadata(row.gitRepoRoot, 4_000),
              transcript: transcript.value,
              transcriptLength: row.transcriptLength,
              transcriptTruncated,
              truncated: row.truncated === 1,
              trace: trace.entries,
              traceTruncated: trace.truncated,
              analytics: rowToAnalytics(row),
            });
          }
          const meta = [
            `Provider: ${PROVIDER_LABELS[row.provider] ?? row.provider} (${row.provider})`,
            `Session: ${boundedMetadata(row.providerSessionId, 2_000) ?? "unknown"}`,
            row.model ? `Model: ${boundedMetadata(row.model, 1_000)}` : "",
            row.startedAt ? `Started: ${new Date(row.startedAt).toISOString()}` : "",
            row.updatedAt ? `Updated: ${new Date(row.updatedAt).toISOString()}` : "",
            row.cwd ? `Cwd: ${boundedMetadata(row.cwd, 4_000)}` : "",
            row.gitRepoRoot ? `Repo: ${boundedMetadata(row.gitRepoRoot, 4_000)}` : "",
            `Messages: ${row.messageCount}`,
            row.truncated ? "(transcript truncated for storage)" : "",
          ]
            .filter(Boolean)
            .join("\n");
          const transcript =
            row.transcript.length > 8_000
              ? row.transcript.slice(0, 8_000) + "\n… (transcript truncated; use --json for full)"
              : row.transcript;
          return print(`${meta}\n\n${transcript}`);
        }
        case "rehydrate": {
          const id = rest.find((a) => !a.startsWith("-"));
          if (!id) {
            return {
              exitCode: 1,
              stderr:
                "Usage: bb sessions rehydrate <id> [--project <id>] [--provider <id>] [--condensed|--full]\n",
            };
          }
          const row = indexer.get(id);
          if (!row) return { exitCode: 1, stderr: "Session not found\n" };
          const mode = hasFlag(rest, "--condensed")
            ? "condensed"
            : "full";
          let result;
          try {
            result = await rehydrateSession(bb, row, {
              projectId: flagValue(rest, "--project") ?? ctx.projectId,
              providerId: flagValue(rest, "--provider"),
              mode,
            });
          } catch (error) {
            return { exitCode: 1, stderr: `${safeDiagnostic("Rehydration failed", error)}\n` };
          }
          if (json) return print(result);
          return print(
            [
              `Rehydrated "${result.threadTitle}" into thread ${result.threadId}`,
              `Project: ${result.project.name} (${result.project.id})`,
              `Environment: ${result.environment.kind}${
                result.environment.path ? ` @ ${result.environment.path}` : ""
              }`,
              `Provider: ${result.provider ?? "project default"}`,
              `Prompt: ${result.inputChars} chars (${mode})`,
            ].join("\n"),
          );
        }
        case "telemetry": {
          const requestedRange = flagValue(rest, "--range") ?? "7d";
          const range = ["24h", "7d", "30d", "lifetime"].includes(requestedRange)
            ? (requestedRange as "24h" | "7d" | "30d" | "lifetime")
            : "7d";
          const invalid = invalidProviderIds(rest, "flag");
          if (invalid.length > 0) {
            return {
              exitCode: 1,
              stderr: `Unknown session source provider: ${boundedDiagnostics(invalid)}\n`,
            };
          }
          const providers = parseProviderList(rest, "flag");
          const dashboard = capTelemetryProjection(buildTelemetryDashboard(db, range, providers));
          if (json) return print(dashboard);
          return print([
            `Telemetry (${range}): ${dashboard.totals.sessions} sessions, ${dashboard.totals.messages} messages, ${dashboard.totals.turns} turns`,
            `Tools: ${dashboard.totals.toolCalls} calls · ${dashboard.totals.toolErrors} errors`,
            `Tokens: ${dashboard.totals.totalTokens === null ? "unknown" : dashboard.totals.totalTokens.toLocaleString()}`,
            dashboard.providers.length
              ? dashboard.providers.map((p) => `  ${p.label}: ${p.sessions} sessions · ${p.turns} turns · ${p.toolCalls} tools`).join("\n")
              : "  No sessions in this range.",
          ].join("\n"));
        }
        default:
          return {
            exitCode: 1,
            stderr:
              "Unknown command. Try: status | reindex | search <q> | get <id> | rehydrate <id> | telemetry\n",
          };
      }
    },
  });

  // -------------------------------------------------------------------------
  // Background: keep the index fresh
  // -------------------------------------------------------------------------

  bb.background.service("indexer", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          const settings = await getSettings();
          const versions = (await bb.storage.kv.get<Record<string, number>>("sessionsIndexVersions")) ?? {};
          const pending = PROVIDER_SOURCES
            .filter((source) => settings[`${source.id}Enabled`])
            .map((source) => source.id)
            .filter((provider) => versions[provider] !== INDEX_SCHEMA_VERSION);
          const result = await indexer.ensureIndexed(
            pending.length > 0
              ? { force: true, providers: pending, signal }
              : { force: false, signal },
          );
          if (signal.aborted) break;
          if (pending.length > 0 && result.completedProviders.length > 0) {
            const nextVersions = { ...versions };
            for (const provider of result.completedProviders) {
              if (pending.includes(provider)) nextVersions[provider] = INDEX_SCHEMA_VERSION;
            }
            await bb.storage.kv.set("sessionsIndexVersions", nextVersions);
          }
        } catch (err) {
          bb.log.error(safeDiagnostic("Background index failed", err));
        }
        await sleep(60_000, signal);
      }
    },
  });

  bb.onDispose(async () => {
    indexer.dispose();
    await indexer.waitForIdle();
  });
}
