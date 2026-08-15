// Local telemetry projection for the unified Sessions plugin.
//
// The JSONL parser lives beside the conversation index, while this read model
// deliberately stays separate from the conversation index. There is one
// scan, one SQLite database, and one answer for both search and metrics.

import type Database from "better-sqlite3";
import { PROVIDER_LABELS, PROVIDER_IDS } from "./sources";
import type { ProviderId } from "./types";
import { buildScopeFilter } from "./scope";

export type TelemetryRange = "24h" | "7d" | "30d" | "lifetime";

export interface TelemetryScope {
  roots: readonly string[];
}

export interface TelemetryTotals {
  sessions: number;
  active: number;
  failed: number;
  turns: number;
  messages: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cachedWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  costEstimated: boolean;
  contextPeak: number | null;
  compactions: number;
}

export interface TelemetryProviderSummary extends TelemetryTotals {
  provider: string;
  label: string;
  lastActivityAt: number | null;
}

export interface TelemetryRecentSession {
  id: string;
  provider: string;
  title: string;
  updatedAt: number | null;
  status: string;
  model: string | null;
  messageCount: number;
  turnCount: number;
  toolCalls: number;
  toolErrors: number;
  totalTokens: number | null;
  costUsd: number | null;
  costEstimated: boolean;
}

export interface TelemetryDashboard {
  generatedAt: number;
  range: TelemetryRange;
  truncated: boolean;
  totals: TelemetryTotals;
  providers: TelemetryProviderSummary[];
  recent: TelemetryRecentSession[];
  daily: Array<{
    date: string;
    sessions: number;
    turns: number;
    toolErrors: number;
    totalTokens: number | null;
  }>;
}

// Rich dashboard types live in Sessions alongside the compact agent-tool
// projection.
export type DashboardRange = "1h" | "6h" | "24h" | "7d" | "30d" | "lifetime";
export type DashboardView = "provider" | "unified";
export type CapabilityLevel = "complete" | "partial" | "unavailable";
export type ProviderAvailability = "active" | "historical" | "unknown";
export type ProviderDiscoveryState = "fresh" | "stale" | "unknown";
export type CapabilityName =
  | "metadata"
  | "turns"
  | "tools"
  | "tokens"
  | "context"
  | "errors"
  | "latency"
  | "models";
export type CapabilityReport = Record<CapabilityName, CapabilityLevel>;

export interface DashboardInput {
  view: DashboardView;
  range: DashboardRange;
  providers?: string[];
  hostId?: string;
  projectId?: string;
  model?: string;
  archived?: boolean;
}

export interface FindingRecord {
  id: string;
  ruleId: string;
  severity: "info" | "warning" | "critical";
  source: "provider" | "bb";
  provider: string;
  scope: "range" | "provider" | "session" | "turn" | "tool";
  scopeId: string | null;
  title: string;
  summary: string;
  recommendation: string;
  metricValue: number | null;
  threshold: number | null;
  sampleSize: number;
  coverageNote: string;
  evidence: Array<{
    source: "provider" | "bb";
    sourceRecordId: string;
    sourceSequence: number | null;
    eventType: string;
    at: number | null;
  }>;
  createdAt: number;
}

export interface ProviderSessionRecord {
  id: string;
  source: "provider" | "bb";
  provider: string;
  hostId: string;
  providerSessionId: string | null;
  bbThreadId: string | null;
  title: string;
  cwd: string | null;
  projectId: string | null;
  model: string | null;
  origin: string | null;
  status: string;
  startedAt: number | null;
  updatedAt: number | null;
  durationMs: number | null;
  messageCount: number;
  turnCount: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cachedWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  contextPeak: number | null;
  compactionCount: number;
  failureCount: number;
  delegatedCount: number;
  archived: boolean;
  costUsd: number | null;
  costEstimated: boolean;
  coverage: CapabilityReport;
  storeLabel: string;
  sourcePath: string | null;
  fingerprint: string | null;
  linkState: "none" | "suggested" | "linked";
  findingCount: number;
}

export interface SourceStatusRecord {
  id: string;
  provider: string;
  label: string;
  hostId: string;
  storeKind: "jsonl" | "sqlite";
  pathLabel: string;
  enabled: boolean;
  detected: boolean;
  supported: boolean;
  availability: ProviderAvailability;
  count: number;
  capabilities: CapabilityReport;
  cursor: string | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastWarning: string | null;
  remoteDatabaseUnsupported: boolean;
}

export interface DashboardProviderSummary {
  provider: string;
  label: string;
  availability: ProviderAvailability;
  sessions: number;
  active: number;
  failed: number;
  turns: number;
  messages: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  costEstimated: boolean;
  contextIssues: number;
  contextPeak: number | null;
  averageDurationMs: number | null;
  lastActivityAt: number | null;
  sampleSize: number;
  coverage: CapabilityReport;
  /** Indexed history exists, but no currently available BB provider can run it. */
  historicalOnly: boolean;
  totalTokenCoverage: { known: number; missing: number };
}

export interface DashboardTotals extends Omit<TelemetryTotals, "compactions"> {
  compactions: number;
  sampleSize: number;
  totalTokenCoverage: { known: number; missing: number };
}

export interface DashboardResult {
  view: DashboardView;
  range: DashboardRange;
  generatedAt: number;
  truncated: boolean;
  stale: boolean;
  /** Total provider rows in the local index before range and UI filters. */
  indexedSessions: number;
  totals: DashboardTotals;
  providers: DashboardProviderSummary[];
  findings: FindingRecord[];
  sessions: ProviderSessionRecord[];
  tools: Array<{
    provider: string;
    name: string;
    calls: number;
    failures: number;
    failureRate: number | null;
    p50LatencyMs: number | null;
    p95LatencyMs: number | null;
  }>;
  daily: Array<{
    date: string;
    sessions: number;
    turns: number;
    toolErrors: number;
    totalTokens: number | null;
    byProvider: Record<string, {
      sessions: number;
      turns: number;
      toolErrors: number;
      totalTokens: number | null;
    }>;
  }>;
  models: Array<{ model: string; provider: string; sessions: number; totalTokens: number | null }>;
  coverage: Array<{ provider: string; capability: CapabilityName; level: CapabilityLevel; note: string }>;
}

export interface RichTelemetryResponse {
  dashboard: DashboardResult;
  sources: SourceStatusRecord[];
  uncovered: Array<{ id: string; displayName: string }>;
  indexing: { active: boolean; phase: string; provider: string | null; done: number; total: number };
  lastIndexAt: number | null;
  error: string | null;
  providerDiscoveryError: string | null;
  providerDiscoveryState: ProviderDiscoveryState;
}

const MAX_TELEMETRY_TEXT_CHARS = 2_000;

function telemetryText(value: unknown, fallback: string | null = null): string | null {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.length <= MAX_TELEMETRY_TEXT_CHARS
    ? value
    : `${value.slice(0, MAX_TELEMETRY_TEXT_CHARS - 1)}…`;
}

export function compactDashboardInput(input: DashboardInput): DashboardInput {
  const compact: DashboardInput = { view: input.view, range: input.range };
  if (input.providers !== undefined) compact.providers = input.providers;
  if (input.hostId !== undefined) compact.hostId = input.hostId;
  if (input.projectId !== undefined) compact.projectId = input.projectId;
  if (input.model !== undefined) compact.model = input.model;
  if (input.archived !== undefined) compact.archived = input.archived;
  return compact;
}

function rangeStart(range: TelemetryRange, now: number): number | null {
  if (range === "lifetime") return null;
  const days = range === "24h" ? 1 : range === "7d" ? 7 : 30;
  return now - days * 24 * 60 * 60 * 1000;
}

interface MetricAggregateRow {
  provider?: string;
  sessions: number;
  active: number;
  failed: number;
  turns: number;
  messages: number;
  tool_calls: number;
  tool_errors: number;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cached_write_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  cost_estimated: number;
  context_peak: number | null;
  compactions: number;
  last_activity_at?: number | null;
}

function metricTotals(row: MetricAggregateRow): TelemetryTotals {
  return {
    sessions: row.sessions ?? 0,
    active: row.active ?? 0,
    failed: row.failed ?? 0,
    turns: row.turns ?? 0,
    messages: row.messages ?? 0,
    toolCalls: row.tool_calls ?? 0,
    toolErrors: row.tool_errors ?? 0,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    cachedWriteTokens: row.cached_write_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    costEstimated: row.cost_estimated === 1,
    contextPeak: row.context_peak,
    compactions: row.compactions ?? 0,
  };
}

export function buildTelemetryDashboard(
  db: Database.Database,
  range: TelemetryRange = "7d",
  providers?: string[],
  now = Date.now(),
  scope?: TelemetryScope,
): TelemetryDashboard {
  const start = rangeStart(range, now);
  const filterProvided = providers !== undefined;
  const knownProviders = providers !== undefined && providers.every((provider) => PROVIDER_IDS.includes(provider as ProviderId))
    ? [...new Set(providers)]
    : [];
  const providerClause = filterProvided
    ? knownProviders.length
    ? ` AND provider IN (${knownProviders.map(() => "?").join(",")})`
    : " AND 1 = 0"
    : "";
  const params: unknown[] = [];
  const where: string[] = ["1 = 1"];
  if (start !== null) {
    where.push("activity_at >= ?");
    params.push(start);
  }
  if (providerClause) {
    where.push(providerClause.slice(5));
    if (knownProviders.length) params.push(...knownProviders);
  }
  if (scope !== undefined) {
    const scopeFilter = buildScopeFilter(scope.roots);
    where.push(`(${scopeFilter.sql})`);
    params.push(...scopeFilter.params);
  }
  const whereSql = where.join(" AND ");
  const aggregateSql = `
    SELECT COUNT(*) AS sessions,
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(turn_count) AS turns, SUM(message_count) AS messages,
           SUM(tool_calls) AS tool_calls, SUM(tool_errors) AS tool_errors,
           SUM(input_tokens) AS input_tokens, SUM(cached_input_tokens) AS cached_input_tokens,
           SUM(cached_write_tokens) AS cached_write_tokens, SUM(output_tokens) AS output_tokens,
           SUM(reasoning_tokens) AS reasoning_tokens, SUM(total_tokens) AS total_tokens,
           SUM(cost_usd) AS cost_usd, MAX(cost_estimated) AS cost_estimated,
           MAX(context_peak) AS context_peak, SUM(compaction_count) AS compactions
    FROM sessions WHERE ${whereSql}`;
  const totals = metricTotals(db.prepare(aggregateSql).get(...(params as never[])) as MetricAggregateRow);
  const providerRows = (db.prepare(`
    SELECT provider, COUNT(*) AS sessions,
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(turn_count) AS turns, SUM(message_count) AS messages,
           SUM(tool_calls) AS tool_calls, SUM(tool_errors) AS tool_errors,
           SUM(input_tokens) AS input_tokens, SUM(cached_input_tokens) AS cached_input_tokens,
           SUM(cached_write_tokens) AS cached_write_tokens, SUM(output_tokens) AS output_tokens,
           SUM(reasoning_tokens) AS reasoning_tokens, SUM(total_tokens) AS total_tokens,
           SUM(cost_usd) AS cost_usd, MAX(cost_estimated) AS cost_estimated,
           MAX(context_peak) AS context_peak, SUM(compaction_count) AS compactions,
           MAX(activity_at) AS last_activity_at
    FROM sessions WHERE ${whereSql} GROUP BY provider ORDER BY sessions DESC
  `).all(...(params as never[])) as MetricAggregateRow[])
    .map((row) => ({
      provider: telemetryText(row.provider, "other") ?? "other",
      label: telemetryText(
        PROVIDER_LABELS[(row.provider ?? "other") as ProviderId] ?? row.provider,
        "other",
      ) ?? "other",
      ...metricTotals(row),
      lastActivityAt: row.last_activity_at ?? null,
    } satisfies TelemetryProviderSummary));
  const recentRows = db.prepare(`
    SELECT id, provider, title, updated_at, status, model, message_count,
           turn_count, tool_calls, tool_errors, total_tokens, cost_usd, cost_estimated
    FROM sessions WHERE ${whereSql} ORDER BY activity_at DESC LIMIT 100
  `).all(...(params as never[])) as Array<{
    id: string; provider: string; title: string | null; updated_at: number | null;
    status: string | null; model: string | null; message_count: number; turn_count: number;
    tool_calls: number; tool_errors: number; total_tokens: number | null; cost_usd: number | null;
    cost_estimated: number;
  }>;
  const dailyStart = now - 31 * 24 * 60 * 60 * 1000;
  const dailyWhere = [...where];
  const dailyParams = [...params];
  if (start === null || start < dailyStart) {
    dailyWhere.push("activity_at >= ?");
    dailyParams.push(dailyStart);
  }
  const dailyRows = db.prepare(`
    SELECT strftime('%Y-%m-%d', activity_at / 1000, 'unixepoch', 'localtime') AS date,
           COUNT(*) AS sessions, SUM(turn_count) AS turns,
           SUM(tool_errors) AS tool_errors, SUM(total_tokens) AS total_tokens
    FROM sessions WHERE ${dailyWhere.join(" AND ")}
    GROUP BY date ORDER BY date DESC LIMIT 31
  `).all(...(dailyParams as never[])) as Array<{ date: string; sessions: number; turns: number; tool_errors: number; total_tokens: number | null }>;

  return {
    generatedAt: now,
    range,
    truncated: false,
    totals,
    providers: providerRows,
    recent: recentRows.map((row) => ({
      id: telemetryText(row.id, "unknown") ?? "unknown",
      provider: telemetryText(row.provider, "other") ?? "other",
      title: telemetryText(row.title, "Untitled session") ?? "Untitled session",
      updatedAt: row.updated_at,
      status: telemetryText(row.status, "unknown") ?? "unknown",
      model: telemetryText(row.model),
      messageCount: row.message_count,
      turnCount: row.turn_count,
      toolCalls: row.tool_calls,
      toolErrors: row.tool_errors,
      totalTokens: row.total_tokens,
      costUsd: row.cost_usd,
      costEstimated: row.cost_estimated === 1,
    })),
    daily: [...dailyRows].reverse().map((row) => ({
      date: row.date,
      sessions: row.sessions,
      turns: row.turns,
      toolErrors: row.tool_errors,
      totalTokens: row.total_tokens,
    })),
  };
}

const CAPABILITY_NAMES: CapabilityName[] = [
  "metadata",
  "turns",
  "tools",
  "tokens",
  "context",
  "errors",
  "latency",
  "models",
];

function emptyCapabilities(level: CapabilityLevel = "unavailable"): CapabilityReport {
  return Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, level])) as CapabilityReport;
}

function richRangeStart(range: DashboardRange, now: number): number | null {
  if (range === "lifetime") return null;
  const hours = range === "1h" ? 1 : range === "6h" ? 6 : range === "24h" ? 24 : range === "7d" ? 168 : 720;
  return now - hours * 60 * 60 * 1000;
}

function richNumber(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function richCount(row: Record<string, unknown>, key: string): number {
  return richNumber(row, key) ?? 0;
}

function richText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function richMetadata(row: Record<string, unknown>, key: string, maxChars: number): string | null {
  const value = richText(row, key);
  return value == null || value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

function coverageFromRow(row: Record<string, unknown>): CapabilityReport {
  const fallback = emptyCapabilities();
  const raw = richText(row, "coverage_json");
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const name of CAPABILITY_NAMES) {
      const value = parsed[name];
      if (value === "complete" || value === "partial" || value === "unavailable") {
        fallback[name] = value;
      }
    }
  } catch {
    // Keep the explicit unavailable coverage when a legacy row has bad JSON.
  }
  return fallback;
}

function richBoolean(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  return value === true || value === 1 || value === "1";
}

function richSession(row: Record<string, unknown>): ProviderSessionRecord {
  const provider = richMetadata(row, "provider", 256) ?? "other";
  const source = richText(row, "source") === "bb" ? "bb" : "provider";
  return {
    id: richMetadata(row, "id", 2_000) ?? `${provider}:${richMetadata(row, "provider_session_id", 512) ?? "unknown"}`,
    source,
    provider,
    hostId: richMetadata(row, "host_id", 256) ?? "primary",
    providerSessionId: richMetadata(row, "provider_session_id", 2_000),
    bbThreadId: null,
    title: richMetadata(row, "title", 2_000) ?? "Untitled session",
    cwd: richMetadata(row, "cwd", 4_000),
    projectId: richMetadata(row, "project_id", 1_000),
    model: richMetadata(row, "model", 1_000),
    origin: richMetadata(row, "origin", 1_000),
    status: richMetadata(row, "status", 256) ?? "unknown",
    startedAt: richNumber(row, "started_at"),
    updatedAt: richNumber(row, "updated_at"),
    durationMs: richNumber(row, "duration_ms"),
    messageCount: richCount(row, "message_count"),
    turnCount: richCount(row, "turn_count"),
    toolCalls: richCount(row, "tool_calls"),
    toolErrors: richCount(row, "tool_errors"),
    inputTokens: richNumber(row, "input_tokens"),
    cachedInputTokens: richNumber(row, "cached_input_tokens"),
    cachedWriteTokens: richNumber(row, "cached_write_tokens"),
    outputTokens: richNumber(row, "output_tokens"),
    reasoningTokens: richNumber(row, "reasoning_tokens"),
    totalTokens: richNumber(row, "total_tokens"),
    contextPeak: richNumber(row, "context_peak"),
    compactionCount: richCount(row, "compaction_count"),
    failureCount: richCount(row, "failure_count"),
    delegatedCount: richCount(row, "delegated_count"),
    archived: richBoolean(row, "archived"),
    costUsd: richNumber(row, "cost_usd"),
    costEstimated: richCount(row, "cost_estimated") === 1,
    coverage: coverageFromRow(row),
    // The dashboard is an aggregate/UI projection; raw provider store paths
    // are intentionally kept out of it. The explicit get-session/CLI paths
    // remain available to a human who asks for one session.
    storeLabel: provider,
    sourcePath: null,
    fingerprint: null,
    linkState: "none",
    findingCount: 0,
  };
}

function sumRich(rows: ProviderSessionRecord[], field: keyof ProviderSessionRecord): number | null {
  const values = rows
    .map((row) => row[field])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function richTotals(rows: ProviderSessionRecord[]): DashboardTotals {
  return {
    sessions: rows.length,
    active: rows.filter((row) => row.status === "active").length,
    failed: rows.filter((row) => row.status === "failed" || row.failureCount > 0).length,
    turns: rows.reduce((total, row) => total + row.turnCount, 0),
    messages: rows.reduce((total, row) => total + row.messageCount, 0),
    toolCalls: rows.reduce((total, row) => total + row.toolCalls, 0),
    toolErrors: rows.reduce((total, row) => total + row.toolErrors, 0),
    inputTokens: sumRich(rows, "inputTokens"),
    cachedInputTokens: sumRich(rows, "cachedInputTokens"),
    cachedWriteTokens: sumRich(rows, "cachedWriteTokens"),
    outputTokens: sumRich(rows, "outputTokens"),
    reasoningTokens: sumRich(rows, "reasoningTokens"),
    totalTokens: sumRich(rows, "totalTokens"),
    costUsd: sumRich(rows, "costUsd"),
    costEstimated: rows.some((row) => row.costEstimated),
    contextPeak: rows.reduce<number | null>((peak, row) => row.contextPeak === null ? peak : Math.max(peak ?? 0, row.contextPeak), null),
    compactions: rows.reduce((total, row) => total + row.compactionCount, 0),
    sampleSize: rows.length,
    totalTokenCoverage: {
      known: rows.filter((row) => row.totalTokens !== null).length,
      missing: rows.filter((row) => row.totalTokens === null).length,
    },
  };
}

function richDaily(rows: ProviderSessionRecord[]): DashboardResult["daily"] {
  const groups = new Map<string, ProviderSessionRecord[]>();
  for (const row of rows) {
    const date = new Date(row.updatedAt ?? row.startedAt ?? Date.now()).toISOString().slice(0, 10);
    const group = groups.get(date) ?? [];
    group.push(row);
    groups.set(date, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-31)
    .map(([date, group]) => {
      const byProvider = new Map<string, {
        sessions: number;
        turns: number;
        toolErrors: number;
        totalTokens: number;
        knownTokens: boolean;
      }>();
      for (const row of group) {
        const provider = byProvider.get(row.provider) ?? { sessions: 0, turns: 0, toolErrors: 0, totalTokens: 0, knownTokens: false };
        provider.sessions += 1;
        provider.turns += row.turnCount;
        provider.toolErrors += row.toolErrors;
        if (row.totalTokens !== null) {
          provider.totalTokens += row.totalTokens;
          provider.knownTokens = true;
        }
        byProvider.set(row.provider, provider);
      }
      return {
        date,
        sessions: group.length,
        turns: group.reduce((total, row) => total + row.turnCount, 0),
        toolErrors: group.reduce((total, row) => total + row.toolErrors, 0),
        totalTokens: sumRich(group, "totalTokens"),
        byProvider: Object.fromEntries([...byProvider.entries()].map(([provider, summary]) => [provider, {
          sessions: summary.sessions,
          turns: summary.turns,
          toolErrors: summary.toolErrors,
          totalTokens: summary.knownTokens ? summary.totalTokens : null,
        }])),
      };
    });
}

function richFinding(
  ruleId: string,
  severity: FindingRecord["severity"],
  provider: string,
  title: string,
  summary: string,
  metricValue: number,
  threshold: number,
  sampleSize: number,
  rows: ProviderSessionRecord[],
  now: number,
): FindingRecord {
  return {
    id: `${ruleId}:provider:${provider}`,
    ruleId,
    severity,
    source: "provider",
    provider,
    scope: "provider",
    scopeId: provider,
    title,
    summary,
    recommendation: "Open the affected sessions and compare the underlying provider events before changing settings.",
    metricValue,
    threshold,
    sampleSize,
    coverageNote: "Derived from the normalized Sessions index.",
    evidence: rows.slice(0, 8).map((row) => ({
      source: "provider" as const,
      sourceRecordId: row.id,
      sourceSequence: null,
      eventType: ruleId,
      at: row.updatedAt,
    })),
    createdAt: now,
  };
}

function richFindings(rows: ProviderSessionRecord[], now: number): FindingRecord[] {
  const findings: FindingRecord[] = [];
  for (const provider of [...new Set(rows.map((row) => row.provider))]) {
    const group = rows.filter((row) => row.provider === provider);
    const failures = group.reduce((total, row) => total + row.failureCount, 0);
    const toolCalls = group.reduce((total, row) => total + row.toolCalls, 0);
    const toolErrors = group.reduce((total, row) => total + row.toolErrors, 0);
    if (failures > 0) {
      findings.push(richFinding(
        "provider-reliability",
        failures / group.length >= 0.5 ? "critical" : "warning",
        provider,
        `${PROVIDER_LABELS[provider as ProviderId] ?? provider} telemetry reports failures`,
        `${failures} failure${failures === 1 ? "" : "s"} appeared across ${group.length} indexed session${group.length === 1 ? "" : "s"}.`,
        failures,
        1,
        group.length,
        group,
        now,
      ));
    }
    if (toolCalls >= 5 && toolErrors / toolCalls >= 0.25) {
      findings.push(richFinding(
        "tool-reliability",
        toolErrors / toolCalls >= 0.5 ? "critical" : "warning",
        provider,
        `${PROVIDER_LABELS[provider as ProviderId] ?? provider} tool failures are elevated`,
        `${toolErrors} of ${toolCalls} indexed tool calls failed (${Math.round((toolErrors / toolCalls) * 100)}%).`,
        toolErrors / toolCalls,
        0.25,
        toolCalls,
        group,
        now,
      ));
    }
  }
  return findings;
}

function richCapabilitiesForProvider(
  provider: string,
  rows: ProviderSessionRecord[],
  sources: SourceStatusRecord[],
): CapabilityReport {
  const source = sources.find((candidate) => candidate.provider === provider);
  if (source) return source.capabilities;
  const output = emptyCapabilities();
  output.metadata = rows.length ? "complete" : "unavailable";
  output.turns = rows.some((row) => row.turnCount > 0) ? "complete" : "partial";
  output.tools = rows.some((row) => row.toolCalls > 0) ? "complete" : "partial";
  output.tokens = rows.some((row) => row.totalTokens !== null) ? "complete" : "unavailable";
  output.errors = rows.some((row) => row.toolErrors > 0 || row.failureCount > 0) ? "complete" : "partial";
  output.latency = rows.some((row) => row.durationMs !== null) ? "complete" : "unavailable";
  output.models = rows.some((row) => row.model !== null) ? "complete" : "partial";
  return output;
}

interface RichProviderAggregate {
  provider: string;
  sessions: number;
  active: number;
  failed: number;
  turns: number;
  messages: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cachedWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  totalTokenCoverage: { known: number; missing: number };
  costUsd: number | null;
  costEstimated: boolean;
  contextIssues: number;
  contextPeak: number | null;
  compactions: number;
  failureCount: number;
  averageDurationMs: number | null;
  lastActivityAt: number | null;
}

function aggregateNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function aggregateNullable(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function aggregateFromRow(row: Record<string, unknown>): RichProviderAggregate {
  return {
    provider: telemetryText(row.provider, "other") ?? "other",
    sessions: aggregateNumber(row.sessions),
    active: aggregateNumber(row.active),
    failed: aggregateNumber(row.failed),
    turns: aggregateNumber(row.turns),
    messages: aggregateNumber(row.messages),
    toolCalls: aggregateNumber(row.tool_calls),
    toolErrors: aggregateNumber(row.tool_errors),
    inputTokens: aggregateNullable(row.input_tokens),
    cachedInputTokens: aggregateNullable(row.cached_input_tokens),
    cachedWriteTokens: aggregateNullable(row.cached_write_tokens),
    outputTokens: aggregateNullable(row.output_tokens),
    reasoningTokens: aggregateNullable(row.reasoning_tokens),
    totalTokens: aggregateNullable(row.total_tokens),
    totalTokenCoverage: {
      known: aggregateNumber(row.known_total_token_sessions),
      missing: aggregateNumber(row.missing_total_token_sessions),
    },
    costUsd: aggregateNullable(row.cost_usd),
    costEstimated: aggregateNumber(row.cost_estimated) > 0,
    contextIssues: aggregateNumber(row.context_issues),
    contextPeak: aggregateNullable(row.context_peak),
    compactions: aggregateNumber(row.compactions),
    failureCount: aggregateNumber(row.failure_count),
    averageDurationMs: aggregateNullable(row.average_duration_ms),
    lastActivityAt: aggregateNullable(row.last_activity_at),
  };
}

function sumAggregateNullable(
  aggregates: RichProviderAggregate[],
  field: keyof Pick<RichProviderAggregate, "inputTokens" | "cachedInputTokens" | "cachedWriteTokens" | "outputTokens" | "reasoningTokens" | "totalTokens" | "costUsd">,
): number | null {
  const values = aggregates
    .map((aggregate) => aggregate[field])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function totalsFromAggregates(aggregates: RichProviderAggregate[]): DashboardTotals {
  return {
    sessions: aggregates.reduce((sum, row) => sum + row.sessions, 0),
    active: aggregates.reduce((sum, row) => sum + row.active, 0),
    failed: aggregates.reduce((sum, row) => sum + row.failed, 0),
    turns: aggregates.reduce((sum, row) => sum + row.turns, 0),
    messages: aggregates.reduce((sum, row) => sum + row.messages, 0),
    toolCalls: aggregates.reduce((sum, row) => sum + row.toolCalls, 0),
    toolErrors: aggregates.reduce((sum, row) => sum + row.toolErrors, 0),
    inputTokens: sumAggregateNullable(aggregates, "inputTokens"),
    cachedInputTokens: sumAggregateNullable(aggregates, "cachedInputTokens"),
    cachedWriteTokens: sumAggregateNullable(aggregates, "cachedWriteTokens"),
    outputTokens: sumAggregateNullable(aggregates, "outputTokens"),
    reasoningTokens: sumAggregateNullable(aggregates, "reasoningTokens"),
    totalTokens: sumAggregateNullable(aggregates, "totalTokens"),
    totalTokenCoverage: {
      known: aggregates.reduce((sum, row) => sum + row.totalTokenCoverage.known, 0),
      missing: aggregates.reduce((sum, row) => sum + row.totalTokenCoverage.missing, 0),
    },
    costUsd: sumAggregateNullable(aggregates, "costUsd"),
    costEstimated: aggregates.some((row) => row.costEstimated),
    contextPeak: aggregates.reduce<number | null>((peak, row) => row.contextPeak === null ? peak : Math.max(peak ?? 0, row.contextPeak), null),
    compactions: aggregates.reduce((sum, row) => sum + row.compactions, 0),
    sampleSize: aggregates.reduce((sum, row) => sum + row.sessions, 0),
  };
}

function richFindingsFromAggregates(
  aggregates: RichProviderAggregate[],
  preview: ProviderSessionRecord[],
  now: number,
): FindingRecord[] {
  const findings: FindingRecord[] = [];
  for (const aggregate of aggregates) {
    const evidence = preview.filter((row) => row.provider === aggregate.provider);
    if (aggregate.failureCount > 0) {
      findings.push(richFinding(
        "provider-reliability",
        aggregate.failureCount / Math.max(1, aggregate.sessions) >= 0.5 ? "critical" : "warning",
        aggregate.provider,
        `${PROVIDER_LABELS[aggregate.provider as ProviderId] ?? aggregate.provider} telemetry reports failures`,
        `${aggregate.failureCount} failure${aggregate.failureCount === 1 ? "" : "s"} appeared across ${aggregate.sessions} indexed session${aggregate.sessions === 1 ? "" : "s"}.`,
        aggregate.failureCount,
        1,
        aggregate.sessions,
        evidence,
        now,
      ));
    }
    if (aggregate.toolCalls >= 5 && aggregate.toolErrors / aggregate.toolCalls >= 0.25) {
      findings.push(richFinding(
        "tool-reliability",
        aggregate.toolErrors / aggregate.toolCalls >= 0.5 ? "critical" : "warning",
        aggregate.provider,
        `${PROVIDER_LABELS[aggregate.provider as ProviderId] ?? aggregate.provider} tool failures are elevated`,
        `${aggregate.toolErrors} of ${aggregate.toolCalls} indexed tool calls failed (${Math.round((aggregate.toolErrors / aggregate.toolCalls) * 100)}%).`,
        aggregate.toolErrors / aggregate.toolCalls,
        0.25,
        aggregate.toolCalls,
        evidence,
        now,
      ));
    }
  }
  return findings;
}

export function buildRichTelemetryDashboard(
  db: Database.Database,
  input: DashboardInput,
  sources: SourceStatusRecord[],
  now = Date.now(),
): DashboardResult {
  const start = richRangeStart(input.range, now);
  const requestedProviders = input.providers === undefined ? undefined : [...new Set(input.providers)];
  const where: string[] = ["1 = 1"];
  const params: unknown[] = [];
  if (start !== null) {
    where.push("activity_at >= ?");
    params.push(start);
  }
  if (input.view === "provider") where.push("source = 'provider'");
  const validProviderFilter = requestedProviders === undefined || (
    requestedProviders.length > 0 &&
    requestedProviders.every((provider) => PROVIDER_IDS.includes(provider as ProviderId))
  );
  if (requestedProviders !== undefined) {
    if (!validProviderFilter) {
      where.push("1 = 0");
    } else {
      where.push(`provider IN (${requestedProviders.map(() => "?").join(",")})`);
      params.push(...requestedProviders);
    }
  }
  if (input.hostId) {
    where.push("host_id = ?");
    params.push(input.hostId);
  }
  if (input.projectId) {
    where.push("project_id = ?");
    params.push(input.projectId);
  }
  if (input.model) {
    where.push("model = ?");
    params.push(input.model);
  }
  if (input.archived !== undefined) {
    where.push("archived = ?");
    params.push(input.archived ? 1 : 0);
  }
  const aggregateRows = db.prepare(`
    SELECT provider,
           COUNT(*) AS sessions,
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'failed' OR failure_count > 0 THEN 1 ELSE 0 END) AS failed,
           SUM(turn_count) AS turns,
           SUM(message_count) AS messages,
           SUM(tool_calls) AS tool_calls,
           SUM(tool_errors) AS tool_errors,
           SUM(input_tokens) AS input_tokens,
           SUM(cached_input_tokens) AS cached_input_tokens,
           SUM(cached_write_tokens) AS cached_write_tokens,
           SUM(output_tokens) AS output_tokens,
           SUM(reasoning_tokens) AS reasoning_tokens,
           SUM(total_tokens) AS total_tokens,
           COUNT(total_tokens) AS known_total_token_sessions,
           COUNT(*) - COUNT(total_tokens) AS missing_total_token_sessions,
           SUM(cost_usd) AS cost_usd,
           MAX(cost_estimated) AS cost_estimated,
           SUM(CASE WHEN compaction_count > 0 OR context_peak >= 0.85 THEN 1 ELSE 0 END) AS context_issues,
           MAX(context_peak) AS context_peak,
           SUM(compaction_count) AS compactions,
           SUM(failure_count) AS failure_count,
           AVG(duration_ms) AS average_duration_ms,
           MAX(activity_at) AS last_activity_at
    FROM sessions
    WHERE ${where.join(" AND ")}
    GROUP BY provider
  `).all(...(params as never[])) as Array<Record<string, unknown>>;
  const aggregates = aggregateRows.map(aggregateFromRow);

  const previewRows = db.prepare(`
    SELECT id, provider, source, host_id, provider_session_id, title, cwd,
           project_id, model, origin, status, started_at, updated_at,
           duration_ms, message_count, turn_count, tool_calls, tool_errors,
           input_tokens, cached_input_tokens, cached_write_tokens,
           output_tokens, reasoning_tokens, total_tokens, context_peak,
           compaction_count, failure_count, delegated_count, archived,
           cost_usd, cost_estimated, coverage_json
    FROM sessions
    WHERE ${where.join(" AND ")}
    ORDER BY activity_at DESC
    LIMIT 100
  `).all(...(params as never[])) as Array<Record<string, unknown>>;
  const sessions = previewRows.map(richSession);
  const sourceProviders = sources
    .filter((source) => requestedProviders === undefined || requestedProviders.includes(source.provider))
    .map((source) => source.provider);
  const providerIds = [...new Set([
    ...sourceProviders,
    ...aggregates.map((aggregate) => aggregate.provider),
  ])];
  const aggregateByProvider = new Map(aggregates.map((aggregate) => [aggregate.provider, aggregate]));
  const providers = providerIds.map((provider) => {
    const aggregate = aggregateByProvider.get(provider) ?? {
      provider,
      sessions: 0,
      active: 0,
      failed: 0,
      turns: 0,
      messages: 0,
      toolCalls: 0,
      toolErrors: 0,
      inputTokens: null,
      cachedInputTokens: null,
      cachedWriteTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      totalTokenCoverage: { known: 0, missing: 0 },
      costUsd: null,
      costEstimated: false,
      contextIssues: 0,
      contextPeak: null,
      compactions: 0,
      failureCount: 0,
      averageDurationMs: null,
      lastActivityAt: null,
    } satisfies RichProviderAggregate;
    const source = sources.find((candidate) => candidate.provider === provider);
    return {
      provider,
      label: source?.label ?? PROVIDER_LABELS[provider as ProviderId] ?? provider,
      availability: source?.availability ?? "unknown",
      sessions: aggregate.sessions,
      active: aggregate.active,
      failed: aggregate.failed,
      turns: aggregate.turns,
      messages: aggregate.messages,
      toolCalls: aggregate.toolCalls,
      toolErrors: aggregate.toolErrors,
      inputTokens: aggregate.inputTokens,
      outputTokens: aggregate.outputTokens,
      totalTokens: aggregate.totalTokens,
      costUsd: aggregate.costUsd,
      costEstimated: aggregate.costEstimated,
      contextIssues: aggregate.contextIssues,
      contextPeak: aggregate.contextPeak,
      averageDurationMs: aggregate.averageDurationMs,
      lastActivityAt: aggregate.lastActivityAt,
      sampleSize: aggregate.sessions,
      coverage: richCapabilitiesForProvider(provider, sessions.filter((row) => row.provider === provider), sources),
      historicalOnly: source?.availability === "historical",
      totalTokenCoverage: aggregate.totalTokenCoverage,
    } satisfies DashboardProviderSummary;
  }).sort((left, right) => right.sessions - left.sessions || left.label.localeCompare(right.label));
  const tools = providers
    .filter((provider) => provider.toolCalls > 0)
    .map((provider) => ({
      provider: provider.provider,
      name: "All indexed tools",
      calls: provider.toolCalls,
      failures: provider.toolErrors,
      failureRate: provider.toolCalls ? provider.toolErrors / provider.toolCalls : null,
      p50LatencyMs: null,
      p95LatencyMs: null,
    }));
  const modelRows = db.prepare(`
    SELECT provider, model, COUNT(*) AS sessions, SUM(total_tokens) AS total_tokens
    FROM sessions
    WHERE ${where.join(" AND ")} AND model IS NOT NULL AND trim(model) <> ''
    GROUP BY provider, model
    ORDER BY sessions DESC
    LIMIT 30
  `).all(...(params as never[])) as Array<Record<string, unknown>>;
  const models = modelRows.map((row) => ({
    model: telemetryText(row.model, "unknown") ?? "unknown",
    provider: telemetryText(row.provider, "other") ?? "other",
    sessions: aggregateNumber(row.sessions),
    totalTokens: aggregateNullable(row.total_tokens),
  }));
  const dailyStart = now - 31 * 24 * 60 * 60 * 1000;
  const dailyWhere = [...where];
  const dailyParams = [...params];
  if (start === null || start < dailyStart) {
    dailyWhere.push("activity_at >= ?");
    dailyParams.push(dailyStart);
  }
  const bucketFormat = input.range === "1h" || input.range === "6h" || input.range === "24h"
    ? "%Y-%m-%d %H:00"
    : "%Y-%m-%d";
  const dailyRows = db.prepare(`
    SELECT strftime('${bucketFormat}', activity_at / 1000, 'unixepoch', 'localtime') AS date,
           provider, COUNT(*) AS sessions, SUM(turn_count) AS turns,
           SUM(tool_errors) AS tool_errors, SUM(total_tokens) AS total_tokens
    FROM sessions
    WHERE ${dailyWhere.join(" AND ")}
    GROUP BY date, provider
    ORDER BY date ASC
  `).all(...(dailyParams as never[])) as Array<Record<string, unknown>>;
  const dailyGroups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of dailyRows) {
    const date = telemetryText(row.date, "unknown") ?? "unknown";
    const group = dailyGroups.get(date) ?? [];
    group.push(row);
    dailyGroups.set(date, group);
  }
  const daily = [...dailyGroups.entries()].slice(-31).map(([date, rows]) => ({
    date,
    sessions: rows.reduce((sum, row) => sum + aggregateNumber(row.sessions), 0),
    turns: rows.reduce((sum, row) => sum + aggregateNumber(row.turns), 0),
    toolErrors: rows.reduce((sum, row) => sum + aggregateNumber(row.tool_errors), 0),
    totalTokens: (() => {
      const values = rows.map((row) => aggregateNullable(row.total_tokens)).filter((value): value is number => value !== null);
      return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
    })(),
    byProvider: Object.fromEntries(rows.map((row) => [telemetryText(row.provider, "other") ?? "other", {
      sessions: aggregateNumber(row.sessions),
      turns: aggregateNumber(row.turns),
      toolErrors: aggregateNumber(row.tool_errors),
      totalTokens: aggregateNullable(row.total_tokens),
    }])),
  }));
  const coverage = sources.flatMap((source) => Object.entries(source.capabilities).map(([capability, level]) => ({
    provider: source.provider,
    capability: capability as CapabilityName,
    level,
    note: level === "complete" ? `${source.label} reports this metric.` : level === "partial" ? `${source.label} reports this metric for some records.` : `${source.label} does not report this metric.`,
  })));
  return {
    view: input.view,
    range: input.range,
    generatedAt: now,
    truncated: false,
    stale: false,
    indexedSessions: (db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c,
    totals: totalsFromAggregates(aggregates),
    providers,
    findings: richFindingsFromAggregates(aggregates, sessions, now),
    sessions,
    tools,
    daily,
    models,
    coverage,
  };
}
