export const PROVIDER_IDS = [
  "codex",
  "claude",
  "pi",
  "prime",
  "opencode",
  "omp",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
export type AnalyticsProviderId = ProviderId | "other";
export type SourceKind = "provider" | "bb";
export type StoreKind = "jsonl" | "sqlite";
export type SessionStatus = "active" | "completed" | "failed" | "unknown";
export type Severity = "info" | "warning" | "critical";
export type FindingScope = "range" | "provider" | "session" | "turn" | "tool";
export type CapabilityName =
  | "metadata"
  | "turns"
  | "tools"
  | "tokens"
  | "context"
  | "errors"
  | "latency"
  | "models";
export type CapabilityLevel = "complete" | "partial" | "unavailable";

export type CapabilityReport = Record<CapabilityName, CapabilityLevel>;

export const CAPABILITY_NAMES: CapabilityName[] = [
  "metadata",
  "turns",
  "tools",
  "tokens",
  "context",
  "errors",
  "latency",
  "models",
];

export function emptyCapabilities(
  level: CapabilityLevel = "unavailable",
): CapabilityReport {
  return Object.fromEntries(
    CAPABILITY_NAMES.map((name) => [name, level]),
  ) as CapabilityReport;
}

export interface ProviderSourceDescriptor {
  id: ProviderId;
  label: string;
  bbProviderIds: string[];
  storeKind: StoreKind;
  defaultPath: string;
  archivePath?: string;
  defaultDbPath?: string;
}

export interface SourceSettings {
  autoIndex: boolean;
  includeArchived: boolean;
  excludeCodexBar: boolean;
  defaultView: "provider" | "unified" | "bb";
  defaultRange: RangeId;
  retentionDays: number;
  privacyMode: "strict";
  hostId: string;
  priceOverrides: PriceOverrides;
  sources: Record<ProviderId, { enabled: boolean; path: string; hostId: string }>;
}

export type RangeId = "1h" | "6h" | "24h" | "7d" | "30d" | "lifetime";

/** USD cost per 1,000,000 tokens for one model (see src/pricing.ts). */
export interface ModelPrice {
  inputPerM: number;
  cachedInputPerM: number;
  outputPerM: number;
}

/** User-supplied per-provider, per-model price overrides. */
export type PriceOverrides = Partial<Record<ProviderId, Record<string, ModelPrice>>>;

/** A computed cost estimate for a session or turn. */
export interface CostEstimate {
  totalUsd: number;
  estimated: boolean;
  priceSource: "model" | "provider-fallback" | "provider";
  model: string | null;
  pricedTokens: number;
}

export const RANGE_MS: Record<Exclude<RangeId, "lifetime">, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export interface UsageSnapshot {
  turnId: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cachedWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  contextUsed: number | null;
  contextLimit: number | null;
  costUsd: number | null;
  costEstimated: boolean;
  estimated: boolean;
  sourceSequence: number;
  at: number | null;
}

export interface NormalizedTurn {
  id: string;
  startedAt: number | null;
  endedAt: number | null;
  status: SessionStatus;
  durationMs: number | null;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cachedWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  contextPeak: number | null;
  costUsd: number | null;
  costEstimated: boolean;
  sourceSequenceStart: number | null;
  sourceSequenceEnd: number | null;
}

export interface NormalizedItem {
  sessionId?: string;
  id: string;
  turnId: string | null;
  kind: string;
  toolName: string | null;
  status: "running" | "completed" | "failed" | "interrupted" | "unknown";
  durationMs: number | null;
  errorCategory: string | null;
  approvalStatus: string | null;
  sourceSequence: number;
  at: number | null;
}

export interface EvidenceRef {
  source: SourceKind;
  sourceRecordId: string;
  sourceSequence: number | null;
  eventType: string;
  at: number | null;
}

export interface ProviderSessionRecord {
  id: string;
  source: SourceKind;
  provider: AnalyticsProviderId;
  hostId: string;
  providerSessionId: string | null;
  bbThreadId: string | null;
  title: string;
  cwd: string | null;
  projectId: string | null;
  model: string | null;
  origin: string | null;
  status: SessionStatus;
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
  /** Absolute path the session was scanned from (provider sources only). */
  sourcePath: string | null;
  fingerprint: string | null;
  linkState: "none" | "suggested" | "linked";
  findingCount: number;
}

export interface ParsedProviderSession {
  session: ProviderSessionRecord;
  turns: NormalizedTurn[];
  items: NormalizedItem[];
  usage: UsageSnapshot[];
  evidence: EvidenceRef[];
}

export interface NormalizedBbEvent {
  sourceSequence: number;
  eventType: string;
  itemId: string | null;
  messageId: string | null;
  turnId: string | null;
  at: number | null;
  classification:
    | "turn"
    | "tool"
    | "usage"
    | "context"
    | "error"
    | "delegation"
    | "lifecycle"
    | "other";
  status: string | null;
  durationMs: number | null;
  toolName: string | null;
  errorCategory: string | null;
  approvalStatus: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  contextUsed: number | null;
  contextLimit: number | null;
  estimated: boolean;
  providerSessionId: string | null;
}

export interface LinkRecord {
  providerSessionId: string;
  bbThreadId: string;
  strategy: "explicit-session-id" | "provider-thread-id" | "metadata-window";
  confidence: number;
  policy: "suggested" | "accepted";
  evidence: EvidenceRef[];
  matchedAt: number;
}

export interface FindingRecord {
  id: string;
  ruleId: string;
  severity: Severity;
  source: SourceKind;
  provider: AnalyticsProviderId;
  scope: FindingScope;
  scopeId: string | null;
  title: string;
  summary: string;
  recommendation: string;
  metricValue: number | null;
  threshold: number | null;
  sampleSize: number;
  coverageNote: string;
  evidence: EvidenceRef[];
  createdAt: number;
}

export interface SourceStatusRecord {
  id: string;
  provider: AnalyticsProviderId;
  label: string;
  hostId: string;
  storeKind: StoreKind;
  pathLabel: string;
  enabled: boolean;
  detected: boolean;
  supported: boolean;
  count: number;
  capabilities: CapabilityReport;
  cursor: string | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastWarning: string | null;
  remoteDatabaseUnsupported: boolean;
}

export interface DashboardInput {
  view: "provider" | "unified" | "bb";
  range: RangeId;
  providers?: ProviderId[];
  source?: SourceKind;
  hostId?: string;
  projectId?: string;
  model?: string;
  archived?: boolean;
}

export interface ProviderSummary {
  provider: AnalyticsProviderId;
  label: string;
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
  lastActivityAt: number | null;
  sampleSize: number;
  coverage: CapabilityReport;
}

export interface DashboardTotals {
  sessions: number;
  active: number;
  failed: number;
  turns: number;
  messages: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  costEstimated: boolean;
  contextPeak: number | null;
  compactions: number;
  sampleSize: number;
}

export interface DashboardResult {
  view: DashboardInput["view"];
  range: RangeId;
  generatedAt: number;
  stale: boolean;
  totals: DashboardTotals;
  providers: ProviderSummary[];
  findings: FindingRecord[];
  sessions: ProviderSessionRecord[];
  tools: Array<{
    provider: AnalyticsProviderId;
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
  models: Array<{ model: string; provider: AnalyticsProviderId; sessions: number; totalTokens: number | null }>;
  coverage: Array<{ provider: AnalyticsProviderId; capability: CapabilityName; level: CapabilityLevel; note: string }>;
}

