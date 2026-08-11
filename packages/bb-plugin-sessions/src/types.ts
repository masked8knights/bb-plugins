// Shared types for the unified Sessions plugin.
//
// The six canonical provider families are intentionally separate from the
// physical store they happen to use. `opencode` remains a legacy adapter;
// existing rows stay readable and are shown when that source has data, but it
// is not counted as one of the canonical provider families.

export const CANONICAL_PROVIDER_IDS = [
  "pi",
  "prime",
  "omp",
  "hermes",
  "codex",
  "claude",
] as const;

export type CanonicalProviderId = (typeof CANONICAL_PROVIDER_IDS)[number];
export type ProviderId = CanonicalProviderId | "opencode";

export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  ts?: number;
}

export type SessionTraceKind = "user" | "assistant" | "tool" | "system";
export type SessionTraceStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "unknown";

/**
 * A small, display-oriented projection of a provider transcript. The raw
 * provider records stay on disk; this is intentionally bounded so opening a
 * session never requires shipping a whole JSONL file to the browser.
 */
export interface SessionTraceEntry {
  id: string;
  kind: SessionTraceKind;
  title: string;
  text: string;
  timestamp: number | null;
  status: SessionTraceStatus;
  toolName: string | null;
  sourceSequence: number;
}

export type SessionStatus = "active" | "completed" | "failed" | "unknown";

export interface SessionAnalytics {
  status: SessionStatus;
  durationMs: number | null;
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
  costUsd: number | null;
  costEstimated: boolean;
  coverageJson: string;
}

export function emptySessionAnalytics(): SessionAnalytics {
  return {
    status: "unknown",
    durationMs: null,
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
    compactionCount: 0,
    failureCount: 0,
    delegatedCount: 0,
    costUsd: null,
    costEstimated: false,
    coverageJson: "{}",
  };
}

export interface SessionMeta {
  /** Provider-qualified id: `${provider}:${providerSessionId}`. */
  id: string;
  provider: ProviderId;
  providerSessionId: string;
  /** Source jsonl path, or `hermes-db:<id>` / `opencode-db:<id>` for db stores. */
  filePath: string | null;
  /** Whether this session came from a provider archive store. */
  archived?: boolean;
  title: string;
  cwd: string | null;
  gitRepoRoot: string | null;
  /** Epoch ms. */
  startedAt: number | null;
  /** Epoch ms. */
  updatedAt: number | null;
  model: string | null;
  origin: string | null;
  messageCount: number;
  summary: string | null;
  firstUserMessage: string | null;
  /** Full formatted conversation text used for local search and rehydration. */
  transcript: string;
  /** The index getter may return a bounded prefix for very large transcripts. */
  transcriptPreviewTruncated?: boolean;
  truncated: boolean;
  sizeBytes: number | null;
  mtimeMs: number | null;
  /** Bounded event projection used by the session inspector. */
  trace?: SessionTraceEntry[];
  traceTruncated?: boolean;
  /** Structured telemetry projected from the same source scan. */
  analytics?: SessionAnalytics;
}

/**
 * Per-source settings. Paths default to the registry's known store locations
 * and are overridable; `Enabled` toggles participation in the index.
 */
export interface IndexSettings {
  [key: string]: boolean | string;
  piEnabled: boolean;
  piPath: string;
  primeEnabled: boolean;
  primePath: string;
  ompEnabled: boolean;
  ompPath: string;
  hermesEnabled: boolean;
  hermesPath: string;
  codexEnabled: boolean;
  codexPath: string;
  claudeEnabled: boolean;
  claudePath: string;
  opencodeEnabled: boolean;
  opencodePath: string;
}

export function defaultIndexSettings(): IndexSettings {
  return {
    piEnabled: true,
    piPath: "~/.pi/agent/sessions",
    primeEnabled: true,
    // Prime Agent uses a separate default root. If an installation explicitly
    // points both providers at one path, the indexer treats that shared path
    // as Pi-owned because the JSONL files lack harness provenance.
    primePath: "~/.prime/agent/sessions",
    ompEnabled: true,
    ompPath: "~/.omp/agent/sessions",
    hermesEnabled: true,
    hermesPath: "~/.hermes/state.db",
    codexEnabled: true,
    codexPath: "~/.codex/sessions",
    claudeEnabled: true,
    claudePath: "~/.claude/projects",
    opencodeEnabled: true,
    opencodePath: "~/.local/share/opencode/opencode.db",
  };
}
