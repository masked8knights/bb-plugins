// Shared types for the session index.
//
// The provider set is defined by the source registry (src/sources.ts);
// ProviderId is the union of registered source ids. The *active* set is
// discovered from disk at index/status time, not hard-coded here.

export type ProviderId =
  | "codex"
  | "claude"
  | "prime"
  | "opencode"
  | "omp";

export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  ts?: number;
}

export interface SessionMeta {
  /** Provider-qualified id: `${provider}:${providerSessionId}`. */
  id: string;
  provider: ProviderId;
  providerSessionId: string;
  /** Source jsonl path, or `hermes-db:<id>` / `opencode-db:<id>` for db stores. */
  filePath: string | null;
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
  /** Formatted conversation text (capped for storage). */
  transcript: string;
  truncated: boolean;
  sizeBytes: number | null;
  mtimeMs: number | null;
}

/**
 * Per-source settings. Paths default to the registry's known store locations
 * and are overridable; `Enabled` toggles participation in the index.
 */
export interface IndexSettings {
  codexEnabled: boolean;
  codexPath: string;
  claudeEnabled: boolean;
  claudePath: string;
  primeEnabled: boolean;
  primePath: string;
  primeDbPath: string;
  opencodeEnabled: boolean;
  opencodePath: string;
  ompEnabled: boolean;
  ompPath: string;
}

export function defaultIndexSettings(): IndexSettings {
  return {
    codexEnabled: true,
    codexPath: "~/.codex/sessions",
    claudeEnabled: true,
    claudePath: "~/.claude/projects",
    primeEnabled: true,
    primePath: "~/.prime/agent/sessions",
    primeDbPath: "~/.hermes/state.db",
    opencodeEnabled: true,
    opencodePath: "~/.local/share/opencode/opencode.db",
    ompEnabled: true,
    ompPath: "~/.omp/agent/sessions",
  };
}
