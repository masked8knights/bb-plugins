// Session index: auto-discovering provider stores, parsing, persistence, search.

import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";
import type Database from "better-sqlite3";
import {
  isCoveredBySource,
  isIgnoredSessionPath,
  isKnownProviderId,
  getSource,
  canonicalStorePath,
  probeSources,
  resolveSourceRoots,
  PROVIDER_SOURCES,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  type ProviderId,
  type ProviderSource,
  type SourceProbe,
} from "./sources";
import {
  openHermesDb,
  openOpenCodeDb,
  readHermesConversation,
  readHermesSessions,
  readOpenCodeConversation,
  readOpenCodeSessions,
  hermesSessionToMeta,
  openCodeSessionToMeta,
  boundedProviderSessionId,
  MAX_TRANSCRIPT_CHARS,
  resolveHome,
  type HermesSessionRow,
  type OpenCodeSessionRow,
} from "./parsers";
import { mergeSessionMetas, parseJsonlStreaming } from "./streaming";
import { capTraceEntries, MAX_TRACE_RESPONSE_CHARS } from "./trace";
import { buildScopeFilter } from "./scope";
import { MAX_JSONL_WALK_ENTRIES } from "./scan-limits";
import {
  emptySessionAnalytics,
  type IndexSettings,
  type SessionMeta,
  type SessionStatus,
} from "./types";

export interface IndexProgress {
  phase: "scanning" | "indexing" | "pruning" | "done" | "error";
  cancelled?: boolean;
  provider?: ProviderId;
  done?: number;
  total?: number;
  totalSessions?: number;
  message?: string;
}

export interface IndexerDeps {
  db: Database.Database;
  kv: {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
  };
  log(message: string): void;
  publish(progress: IndexProgress): void;
  getSettings(): Promise<IndexSettings>;
}

export interface SessionRow {
  id: string;
  provider: ProviderId;
  providerSessionId: string;
  filePath: string | null;
  archived: number;
  title: string;
  cwd: string | null;
  gitRepoRoot: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  activityAt: number;
  model: string | null;
  origin: string | null;
  messageCount: number;
  summary: string | null;
  firstUserMessage: string | null;
  transcript: string;
  transcriptLength: number;
  truncated: number;
  sizeBytes: number | null;
  mtimeMs: number | null;
  traceJson: string;
  traceTruncated: number;
  indexedAt: number | null;
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
  costEstimated: number;
  coverageJson: string;
}

/** Local project roots used to keep agent-tool reads project-scoped. */
export interface SessionScope {
  roots: readonly string[];
}

const MAX_PERSISTED_METADATA_CHARS = 8_000;

function boundedStoredText(
  value: string | null | undefined,
  maxChars = MAX_PERSISTED_METADATA_CHARS,
): string | null {
  if (value == null) return null;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function migrateDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'provider',
      provider_session_id TEXT NOT NULL,
      file_path TEXT,
      title TEXT,
      cwd TEXT,
      git_repo_root TEXT,
      project_id TEXT,
      host_id TEXT NOT NULL DEFAULT 'primary',
      archived INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      updated_at INTEGER,
      activity_at INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      origin TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      first_user_message TEXT,
      transcript TEXT NOT NULL DEFAULT '',
      truncated INTEGER NOT NULL DEFAULT 0,
      size_bytes INTEGER,
      mtime_ms INTEGER,
      trace_json TEXT NOT NULL DEFAULT '[]',
      trace_truncated INTEGER NOT NULL DEFAULT 0,
      indexed_at INTEGER,
      status TEXT NOT NULL DEFAULT 'unknown',
      duration_ms INTEGER,
      turn_count INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      tool_errors INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      cached_write_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      total_tokens INTEGER,
      context_peak REAL,
      compaction_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      delegated_count INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      cost_estimated INTEGER NOT NULL DEFAULT 0,
      coverage_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
    CREATE TABLE IF NOT EXISTS session_files (
      provider TEXT NOT NULL,
      file_path TEXT NOT NULL,
      session_id TEXT NOT NULL,
      size_bytes INTEGER,
      mtime_ms INTEGER,
      indexed_at INTEGER,
      PRIMARY KEY (provider, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_session_files_session ON session_files(session_id);
    CREATE TABLE IF NOT EXISTS session_index_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      provider, title, cwd, body,
      content = '', contentless_delete = 1,
      tokenize = 'porter unicode61'
    );
  `);
  // Additive migration for databases created by the older Session Search
  // plugin. Each statement is safe to retry when the column already exists.
  for (const statement of [
    "ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown'",
    "ALTER TABLE sessions ADD COLUMN duration_ms INTEGER",
    "ALTER TABLE sessions ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sessions ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sessions ADD COLUMN tool_errors INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sessions ADD COLUMN input_tokens INTEGER",
    "ALTER TABLE sessions ADD COLUMN cached_input_tokens INTEGER",
    "ALTER TABLE sessions ADD COLUMN cached_write_tokens INTEGER",
    "ALTER TABLE sessions ADD COLUMN output_tokens INTEGER",
    "ALTER TABLE sessions ADD COLUMN reasoning_tokens INTEGER",
    "ALTER TABLE sessions ADD COLUMN total_tokens INTEGER",
    "ALTER TABLE sessions ADD COLUMN context_peak REAL",
    "ALTER TABLE sessions ADD COLUMN compaction_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sessions ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sessions ADD COLUMN delegated_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sessions ADD COLUMN cost_usd REAL",
    "ALTER TABLE sessions ADD COLUMN cost_estimated INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sessions ADD COLUMN coverage_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'provider'",
    "ALTER TABLE sessions ADD COLUMN project_id TEXT",
    "ALTER TABLE sessions ADD COLUMN host_id TEXT NOT NULL DEFAULT 'primary'",
    "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sessions ADD COLUMN activity_at INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sessions ADD COLUMN trace_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE sessions ADD COLUMN trace_truncated INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!isDuplicateColumnError(error)) throw error;
    }
  }
  db.exec("UPDATE sessions SET activity_at = COALESCE(updated_at, started_at, 0) WHERE activity_at = 0");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(activity_at)");
  // Older indexes stored only the last physical file directly on each
  // logical session row. Backfill that representative path into the file
  // manifest; a full scan will add any sibling files that share a provider
  // session id.
  db.exec(`
    INSERT OR IGNORE INTO session_files (provider, file_path, session_id, size_bytes, mtime_ms, indexed_at)
    SELECT provider, file_path, id, size_bytes, mtime_ms, indexed_at
    FROM sessions
    WHERE file_path IS NOT NULL
      AND file_path NOT LIKE 'hermes-db:%'
      AND file_path NOT LIKE 'opencode-db:%'
  `);
  let rebuildFts = false;
  const fts = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'sessions_fts'").get() as
    | { sql: string | null }
    | undefined;
  const contentlessFts = Boolean(
    fts?.sql &&
    /content\s*=\s*''/iu.test(fts.sql) &&
    /contentless_delete\s*=\s*1/iu.test(fts.sql),
  );
  if (!contentlessFts) {
    db.exec("DROP TABLE sessions_fts");
    db.exec(`CREATE VIRTUAL TABLE sessions_fts USING fts5(
      provider, title, cwd, body,
      content = '', contentless_delete = 1,
      tokenize = 'porter unicode61'
    )`);
    rebuildFts = true;
  }
  const ftsCount = (db.prepare("SELECT COUNT(*) AS c FROM sessions_fts").get() as { c: number }).c;
  const sessionCount = (db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c;
  rebuildFts ||= ftsCount === 0 && sessionCount > 0;
  // A count-only check misses partial corruption: an FTS row can be absent
  // while another session's row keeps the counts equal. Compare both rowid
  // sets so unchanged source files cannot leave a session unsearchable.
  if (!rebuildFts) {
    const missing = db.prepare(`
      SELECT 1 AS missing
      FROM sessions s
      WHERE NOT EXISTS (
        SELECT 1 FROM sessions_fts f WHERE f.rowid = s.rowid
      )
      LIMIT 1
    `).get() as { missing: number } | undefined;
    const orphan = db.prepare(`
      SELECT 1 AS orphan
      FROM sessions_fts f
      WHERE NOT EXISTS (
        SELECT 1 FROM sessions s WHERE s.rowid = f.rowid
      )
      LIMIT 1
    `).get() as { orphan: number } | undefined;
    rebuildFts = Boolean(missing || orphan);
  }
  if (rebuildFts) {
    const rebuild = db.transaction(() => {
      db.exec("DELETE FROM sessions_fts");
      db.exec(`
        INSERT INTO sessions_fts (rowid, provider, title, cwd, body)
        SELECT rowid, COALESCE(provider, ''), COALESCE(title, ''), COALESCE(cwd, ''),
               COALESCE(first_user_message, '') || char(10) ||
               COALESCE(transcript, '') || char(10) ||
               COALESCE(file_path, '') || char(10) ||
               COALESCE(trace_json, '')
        FROM sessions
      `);
    });
    rebuild();
  }
}

function mapRow(r: Record<string, unknown>): SessionRow {
  return {
    id: r.id as string,
    provider: r.provider as ProviderId,
    providerSessionId: r.provider_session_id as string,
    filePath: (r.file_path as string | null) ?? null,
    archived: (r.archived as number) ?? 0,
    title: (r.title as string) ?? "",
    cwd: (r.cwd as string | null) ?? null,
    gitRepoRoot: (r.git_repo_root as string | null) ?? null,
    startedAt: (r.started_at as number | null) ?? null,
    updatedAt: (r.updated_at as number | null) ?? null,
    activityAt: (r.activity_at as number | null) ?? 0,
    model: (r.model as string | null) ?? null,
    origin: (r.origin as string | null) ?? null,
    messageCount: (r.message_count as number) ?? 0,
    summary: (r.summary as string | null) ?? null,
    firstUserMessage: (r.first_user_message as string | null) ?? null,
    transcript: (r.transcript as string) ?? "",
    transcriptLength:
      (r.transcript_length as number | null) ?? ((r.transcript as string) ?? "").length,
    truncated: (r.truncated as number) ?? 0,
    sizeBytes: (r.size_bytes as number | null) ?? null,
    mtimeMs: (r.mtime_ms as number | null) ?? null,
    traceJson: (r.trace_json as string) ?? "[]",
    traceTruncated: (r.trace_truncated as number) ?? 0,
    indexedAt: (r.indexed_at as number | null) ?? null,
    status: (r.status as SessionStatus | null) ?? "unknown",
    durationMs: (r.duration_ms as number | null) ?? null,
    turnCount: (r.turn_count as number) ?? 0,
    toolCalls: (r.tool_calls as number) ?? 0,
    toolErrors: (r.tool_errors as number) ?? 0,
    inputTokens: (r.input_tokens as number | null) ?? null,
    cachedInputTokens: (r.cached_input_tokens as number | null) ?? null,
    cachedWriteTokens: (r.cached_write_tokens as number | null) ?? null,
    outputTokens: (r.output_tokens as number | null) ?? null,
    reasoningTokens: (r.reasoning_tokens as number | null) ?? null,
    totalTokens: (r.total_tokens as number | null) ?? null,
    contextPeak: (r.context_peak as number | null) ?? null,
    compactionCount: (r.compaction_count as number) ?? 0,
    failureCount: (r.failure_count as number) ?? 0,
    delegatedCount: (r.delegated_count as number) ?? 0,
    costUsd: (r.cost_usd as number | null) ?? null,
    costEstimated: (r.cost_estimated as number) ?? 0,
    coverageJson: (r.coverage_json as string) ?? "{}",
  };
}

function mapSearchRow(r: Record<string, unknown>): SessionRow {
  return mapRow({
    ...r,
    transcript: "",
    trace_json: "[]",
    coverage_json: "{}",
    transcript_length: 0,
  });
}

const upsertSql = `
  INSERT INTO sessions (
    id, provider, provider_session_id, file_path, archived, title, cwd, git_repo_root,
    started_at, updated_at, activity_at, model, origin, message_count, summary,
    first_user_message, transcript, truncated, size_bytes, mtime_ms, indexed_at,
    trace_json, trace_truncated,
    status, duration_ms, turn_count, tool_calls, tool_errors, input_tokens,
    cached_input_tokens, cached_write_tokens, output_tokens, reasoning_tokens,
    total_tokens, context_peak, compaction_count, failure_count, delegated_count,
    cost_usd, cost_estimated, coverage_json
  ) VALUES (
    @id, @provider, @providerSessionId, @filePath, @archived, @title, @cwd, @gitRepoRoot,
    @startedAt, @updatedAt, @activityAt, @model, @origin, @messageCount, @summary,
    @firstUserMessage, @transcript, @truncated, @sizeBytes, @mtimeMs, @indexedAt,
    @traceJson, @traceTruncated,
    @status, @durationMs, @turnCount, @toolCalls, @toolErrors, @inputTokens,
    @cachedInputTokens, @cachedWriteTokens, @outputTokens, @reasoningTokens,
    @totalTokens, @contextPeak, @compactionCount, @failureCount, @delegatedCount,
    @costUsd, @costEstimated, @coverageJson
  )
  ON CONFLICT(id) DO UPDATE SET
    provider = excluded.provider,
    provider_session_id = excluded.provider_session_id,
    file_path = excluded.file_path,
    archived = excluded.archived,
    title = excluded.title,
    cwd = excluded.cwd,
    git_repo_root = excluded.git_repo_root,
    started_at = excluded.started_at,
    updated_at = excluded.updated_at,
    activity_at = excluded.activity_at,
    model = excluded.model,
    origin = excluded.origin,
    message_count = excluded.message_count,
    summary = excluded.summary,
    first_user_message = excluded.first_user_message,
    transcript = excluded.transcript,
    truncated = excluded.truncated,
    size_bytes = excluded.size_bytes,
    mtime_ms = excluded.mtime_ms,
    trace_json = excluded.trace_json,
    trace_truncated = excluded.trace_truncated,
    indexed_at = excluded.indexed_at,
    status = excluded.status,
    duration_ms = excluded.duration_ms,
    turn_count = excluded.turn_count,
    tool_calls = excluded.tool_calls,
    tool_errors = excluded.tool_errors,
    input_tokens = excluded.input_tokens,
    cached_input_tokens = excluded.cached_input_tokens,
    cached_write_tokens = excluded.cached_write_tokens,
    output_tokens = excluded.output_tokens,
    reasoning_tokens = excluded.reasoning_tokens,
    total_tokens = excluded.total_tokens,
    context_peak = excluded.context_peak,
    compaction_count = excluded.compaction_count,
    failure_count = excluded.failure_count,
    delegated_count = excluded.delegated_count,
    cost_usd = excluded.cost_usd,
    cost_estimated = excluded.cost_estimated,
    coverage_json = excluded.coverage_json
`;

export function upsertSession(db: Database.Database, s: SessionMeta): void {
  const analytics = s.analytics ?? emptySessionAnalytics();
  const cappedTrace = capTraceEntries(s.trace ?? [], MAX_TRACE_RESPONSE_CHARS);
  const providerSessionId = boundedProviderSessionId(s.providerSessionId, s.id);
  const title = boundedStoredText(s.title) ?? "Untitled session";
  const cwd = boundedStoredText(s.cwd);
  const gitRepoRoot = boundedStoredText(s.gitRepoRoot);
  const model = boundedStoredText(s.model, 1_000);
  const origin = boundedStoredText(s.origin, 1_000);
  const summary = boundedStoredText(s.summary);
  const firstUserMessage = boundedStoredText(s.firstUserMessage);
  const transcript = s.transcript.length > MAX_TRANSCRIPT_CHARS
    ? s.transcript.slice(0, MAX_TRANSCRIPT_CHARS)
    : s.transcript;
  const coverageJson = boundedStoredText(analytics.coverageJson, 16_000) ?? "{}";
  const params = {
    id: s.id,
    provider: s.provider,
    providerSessionId,
    filePath: s.filePath,
    archived: s.archived ? 1 : 0,
    title,
    cwd,
    gitRepoRoot,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    activityAt: s.updatedAt ?? s.startedAt ?? 0,
    model,
    origin,
    messageCount: s.messageCount,
    summary,
    firstUserMessage,
    transcript,
    truncated: s.truncated || transcript.length < s.transcript.length ? 1 : 0,
    sizeBytes: s.sizeBytes,
    mtimeMs: s.mtimeMs,
    traceJson: JSON.stringify(cappedTrace.entries),
    traceTruncated: s.traceTruncated || cappedTrace.truncated ? 1 : 0,
    indexedAt: Date.now(),
    status: analytics.status,
    durationMs: analytics.durationMs,
    turnCount: analytics.turnCount,
    toolCalls: analytics.toolCalls,
    toolErrors: analytics.toolErrors,
    inputTokens: analytics.inputTokens,
    cachedInputTokens: analytics.cachedInputTokens,
    cachedWriteTokens: analytics.cachedWriteTokens,
    outputTokens: analytics.outputTokens,
    reasoningTokens: analytics.reasoningTokens,
    totalTokens: analytics.totalTokens,
    contextPeak: analytics.contextPeak,
    compactionCount: analytics.compactionCount,
    failureCount: analytics.failureCount,
    delegatedCount: analytics.delegatedCount,
    costUsd: analytics.costUsd,
    costEstimated: analytics.costEstimated ? 1 : 0,
    coverageJson,
  };
  const run = db.transaction(() => {
    db.prepare(upsertSql).run(params as never);
    const row = db.prepare("SELECT rowid FROM sessions WHERE id = ?").get(s.id) as
      | { rowid: number }
      | undefined;
    if (row) {
      db.prepare("DELETE FROM sessions_fts WHERE rowid = ?").run(row.rowid);
      const traceSearchText = (s.trace ?? [])
        .filter((entry) => entry.kind === "tool")
        .map((entry) => [entry.toolName, entry.title, entry.text]
          .map((part) => boundedStoredText(part, 4_000) ?? "")
          .join(" "))
        .join("\n")
        .slice(0, 20_000);
      db.prepare(
        "INSERT INTO sessions_fts (rowid, provider, title, cwd, body) VALUES (?, ?, ?, ?, ?)",
      ).run(
        row.rowid,
        s.provider,
        title,
        cwd ?? "",
        `${firstUserMessage ?? ""}\n${transcript}\n${s.filePath ?? ""}\n${traceSearchText}`,
      );
    }
    if (s.provider === "hermes") {
      const legacy = db.prepare(
        "SELECT id FROM sessions WHERE provider = 'prime' AND file_path = ?",
      ).get(`hermes-db:${providerSessionId}`) as { id: string } | undefined;
      if (legacy && legacy.id !== s.id) deleteSessionRows(db, legacy.id);
    }
    if (s.filePath) {
      const previous = db
        .prepare("SELECT session_id FROM session_files WHERE provider = ? AND file_path = ?")
        .get(s.provider, s.filePath) as { session_id: string } | undefined;
      if (previous && previous.session_id !== s.id) {
        db.prepare("DELETE FROM session_files WHERE provider = ? AND file_path = ?")
          .run(s.provider, s.filePath);
        const remaining = db
          .prepare("SELECT 1 AS present FROM session_files WHERE session_id = ? LIMIT 1")
          .get(previous.session_id) as { present: number } | undefined;
        if (!remaining) deleteSessionRows(db, previous.session_id);
      }
      db.prepare(`
        INSERT INTO session_files (provider, file_path, session_id, size_bytes, mtime_ms, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, file_path) DO UPDATE SET
          session_id = excluded.session_id,
          size_bytes = excluded.size_bytes,
          mtime_ms = excluded.mtime_ms,
          indexed_at = excluded.indexed_at
      `).run(
        s.provider,
        s.filePath,
        s.id,
        s.sizeBytes,
        s.mtimeMs,
        Date.now(),
      );
    }
  });
  run();
}

/** Map one physical source file to a logical session without replacing the
 * representative file path stored on the session row. Claude Code can have a
 * parent file and several subagent files for the same provider session. */
function mapSessionFile(
  db: Database.Database,
  provider: ProviderId,
  filePath: string,
  sessionId: string,
  sizeBytes: number | null,
  mtimeMs: number | null,
): void {
  const run = db.transaction(() => {
    const previous = db
      .prepare("SELECT session_id FROM session_files WHERE provider = ? AND file_path = ?")
      .get(provider, filePath) as { session_id: string } | undefined;
    if (previous && previous.session_id !== sessionId) {
      db.prepare("DELETE FROM session_files WHERE provider = ? AND file_path = ?")
        .run(provider, filePath);
      const remaining = db
        .prepare("SELECT 1 AS present FROM session_files WHERE session_id = ? LIMIT 1")
        .get(previous.session_id) as { present: number } | undefined;
      if (!remaining) deleteSessionRows(db, previous.session_id);
    }
    db.prepare(`
      INSERT INTO session_files (provider, file_path, session_id, size_bytes, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, file_path) DO UPDATE SET
        session_id = excluded.session_id,
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms,
        indexed_at = excluded.indexed_at
    `).run(provider, filePath, sessionId, sizeBytes, mtimeMs, Date.now());
  });
  run();
}

export function deleteSession(db: Database.Database, id: string): void {
  const run = db.transaction(() => {
    deleteSessionRows(db, id);
  });
  run();
}

function deleteSessionRows(db: Database.Database, id: string): void {
  const row = db.prepare("SELECT rowid FROM sessions WHERE id = ?").get(id) as
    | { rowid: number }
    | undefined;
  if (row) db.prepare("DELETE FROM sessions_fts WHERE rowid = ?").run(row.rowid);
  db.prepare("DELETE FROM session_files WHERE session_id = ?").run(id);
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

/** Remove one physical file without deleting a logical session that still has
 * sibling files mapped to it. */
function removeFileMapping(
  db: Database.Database,
  provider: ProviderId,
  filePath: string,
): number {
  const mapped = db
    .prepare("SELECT session_id FROM session_files WHERE provider = ? AND file_path = ?")
    .get(provider, filePath) as { session_id: string } | undefined;
  if (!mapped) {
    const legacy = db
      .prepare("SELECT id FROM sessions WHERE provider = ? AND file_path = ?")
      .get(provider, filePath) as { id: string } | undefined;
    if (!legacy) return 0;
    deleteSession(db, legacy.id);
    return 1;
  }
  db.prepare("DELETE FROM session_files WHERE provider = ? AND file_path = ?")
    .run(provider, filePath);
  const remaining = db
    .prepare("SELECT 1 AS present FROM session_files WHERE session_id = ? LIMIT 1")
    .get(mapped.session_id) as { present: number } | undefined;
  if (remaining) return 0;
  const session = db
    .prepare("SELECT 1 AS present FROM sessions WHERE id = ?")
    .get(mapped.session_id) as { present: number } | undefined;
  if (session) deleteSession(db, mapped.session_id);
  return session ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Scanning helpers
// ---------------------------------------------------------------------------

interface WalkedFile {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
  dev: number;
  ino: number;
  archived?: boolean;
  ancestors: Array<{ path: string; dev: number; ino: number }>;
}

interface WalkedRootIdentity {
  path: string;
  canonicalPath: string;
  dev: number;
  ino: number;
}

interface WalkedFiles {
  files: WalkedFile[];
  complete: boolean;
  /** The root was absent, rather than present-but-unreadable. */
  missingRoot: boolean;
  errors: string[];
  /** Present even for an empty root, so pruning can detect root replacement. */
  rootIdentity?: WalkedRootIdentity;
}

export function walkJsonl(root: string, allowMissingRoot = false, signal?: AbortSignal): WalkedFiles {
  const out: WalkedFile[] = [];
  const errors: string[] = [];
  let visitedEntries = 0;
  let complete = true;
  let rootStat: ReturnType<typeof lstatSync> | null = null;
  try {
    rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return {
        files: [],
        complete: false,
        missingRoot: false,
        errors: [`${root}: root is not a directory or is a symbolic link`],
      };
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: string }).code
      : undefined;
    if (code === "ENOENT" && allowMissingRoot) {
      return { files: [], complete: true, missingRoot: true, errors: [] };
    }
    if (code !== "ENOENT") errors.push(safeDiagnostic(root, error));
    return { files: [], complete: false, missingRoot: code === "ENOENT", errors };
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch (error) {
    return {
      files: [],
      complete: false,
      missingRoot: false,
      errors: [safeDiagnostic(`${root}: could not resolve scan root`, error)],
    };
  }
  const rootIdentity: WalkedRootIdentity = {
    path: root,
    canonicalPath: canonicalRoot,
    dev: rootStat.dev,
    ino: rootStat.ino,
  };
  const stack: Array<{ path: string; dev: number; ino: number; ancestors: Array<{ path: string; dev: number; ino: number }> }> = [{
    path: root,
    dev: rootStat.dev,
    ino: rootStat.ino,
    ancestors: [{ path: root, dev: rootStat.dev, ino: rootStat.ino }],
  }];
  while (stack.length > 0) {
    if (signal?.aborted) return { files: out, complete: false, missingRoot: false, errors: [], rootIdentity };
    const current = stack.pop()!;
    const dir = current.path;
    let entries;
    let dirFd: number | null = null;
    try {
      // Keep directory traversal no-follow as well. The inode check catches
      // a parent directory that was atomically replaced after enumeration.
      dirFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const actualDir = fstatSync(dirFd);
      if (actualDir.dev !== current.dev || actualDir.ino !== current.ino) {
        complete = false;
        errors.push(`${dir}: directory changed during scan`);
        continue;
      }
      const canonicalDir = realpathSync(dir);
      if (!isWithinCanonicalRoot(canonicalRoot, canonicalDir)) {
        complete = false;
        errors.push(`${dir}: directory escaped the configured scan root`);
        continue;
      }
      // Node's readdirSync accepts paths, not numeric descriptors. The
      // descriptor check above prevents opening a symlink, and the identity
      // check below rejects a directory that was replaced while it was read.
      entries = readdirSync(dir, { withFileTypes: true });
      if (entries.length > MAX_JSONL_WALK_ENTRIES) {
        complete = false;
        errors.push(`${dir}: JSONL scan limit exceeded (${MAX_JSONL_WALK_ENTRIES} directory entries)`);
        continue;
      }
      const afterRead = lstatSync(dir);
      const afterCanonicalDir = realpathSync(dir);
      if (
        afterRead.isSymbolicLink() ||
        afterRead.dev !== current.dev ||
        afterRead.ino !== current.ino ||
        !isWithinCanonicalRoot(canonicalRoot, afterCanonicalDir)
      ) {
        complete = false;
        errors.push(`${dir}: directory changed during scan`);
        continue;
      }
    } catch (error) {
      complete = false;
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;
      if (code !== "ENOENT") errors.push(safeDiagnostic(dir, error));
      continue;
    } finally {
      if (dirFd !== null) closeSync(dirFd);
    }
    for (const e of entries) {
      if (visitedEntries >= MAX_JSONL_WALK_ENTRIES) {
        complete = false;
        errors.push(`${root}: JSONL scan limit exceeded (${MAX_JSONL_WALK_ENTRIES} directory entries)`);
        return { files: out, complete, missingRoot: false, errors, rootIdentity };
      }
      visitedEntries += 1;
      if (signal?.aborted) return { files: out, complete: false, missingRoot: false, errors: [], rootIdentity };
      try {
        const parentNow = lstatSync(dir);
        if (parentNow.isSymbolicLink() || parentNow.dev !== current.dev || parentNow.ino !== current.ino) {
          complete = false;
          errors.push(`${dir}: directory changed during scan`);
          break;
        }
      } catch {
        complete = false;
        errors.push(`${dir}: directory changed during scan`);
        break;
      }
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        complete = false;
        errors.push(`${p}: symbolic-link entry is not scanned`);
        continue;
      }
      if (e.isDirectory()) {
        try {
          const st = lstatSync(p);
          if (st.isSymbolicLink() || !st.isDirectory()) {
            complete = false;
            errors.push(`${p}: directory changed to a non-directory during scan`);
            continue;
          }
          const canonicalChild = realpathSync(p);
          if (!isWithinCanonicalRoot(canonicalRoot, canonicalChild)) {
            complete = false;
            errors.push(`${p}: directory escaped the configured scan root`);
            continue;
          }
          stack.push({
            path: p,
            dev: st.dev,
            ino: st.ino,
            ancestors: [...current.ancestors, { path: p, dev: st.dev, ino: st.ino }],
          });
        } catch (error) {
          complete = false;
          const code = error && typeof error === "object" && "code" in error
            ? (error as { code?: string }).code
            : undefined;
          if (code !== "ENOENT") errors.push(safeDiagnostic(p, error));
        }
      } else if (e.isFile() && extname(e.name) === ".jsonl") {
        try {
          // lstat prevents a stale Dirent from turning a newly-created
          // symlink into a real file candidate.
          const st = lstatSync(p);
          if (st.isSymbolicLink() || !st.isFile()) {
            complete = false;
            errors.push(`${p}: file changed to a non-regular file during scan`);
            continue;
          }
          const canonicalFile = realpathSync(p);
          if (!isWithinCanonicalRoot(canonicalRoot, canonicalFile)) {
            complete = false;
            errors.push(`${p}: file escaped the configured scan root`);
            continue;
          }
          out.push({
            path: p,
            mtimeMs: st.mtimeMs,
            sizeBytes: st.size,
            dev: st.dev,
            ino: st.ino,
            ancestors: current.ancestors,
          });
        } catch (error) {
          complete = false;
          const code = error && typeof error === "object" && "code" in error
            ? (error as { code?: string }).code
            : undefined;
          if (code !== "ENOENT") errors.push(safeDiagnostic(p, error));
        }
      }
    }
  }
  return { files: out, complete, missingRoot: false, errors, rootIdentity };
}

function walkedAncestorsStable(files: WalkedFile[]): boolean {
  for (const file of files) {
    for (const ancestor of file.ancestors) {
      try {
        const current = lstatSync(ancestor.path);
        if (current.isSymbolicLink() || current.dev !== ancestor.dev || current.ino !== ancestor.ino) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

export function walkedRootsStable(walked: WalkedFiles[]): boolean {
  for (const result of walked) {
    const expected = result.rootIdentity;
    if (!expected) continue;
    try {
      const current = lstatSync(expected.path);
      if (
        current.isSymbolicLink() ||
        !current.isDirectory() ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino ||
        realpathSync(expected.path) !== expected.canonicalPath
      ) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function pruneBySeen(
  db: Database.Database,
  provider: ProviderId,
  seenPaths: Set<string>,
  seenDbIds?: Set<string>,
): number {
  if (!seenDbIds) {
    let removed = 0;
    const mappings = db
      .prepare("SELECT file_path FROM session_files WHERE provider = ?")
      .all(provider) as Array<{ file_path: string }>;
    for (const mapping of mappings) {
      if (!seenPaths.has(mapping.file_path)) {
        removed += removeFileMapping(db, provider, mapping.file_path);
      }
    }
    // Rows created before session_files existed may have no manifest entry.
    const rows = db
      .prepare("SELECT id, file_path FROM sessions WHERE provider = ?")
      .all(provider) as Array<{ id: string; file_path: string | null }>;
    for (const row of rows) {
      if (row.file_path === null) continue;
      const mapped = db
        .prepare("SELECT 1 AS present FROM session_files WHERE session_id = ? LIMIT 1")
        .get(row.id) as { present: number } | undefined;
      if (!mapped && !seenPaths.has(row.file_path)) {
        deleteSession(db, row.id);
        removed++;
      }
    }
    return removed;
  }
  const rows = db
    .prepare("SELECT id, file_path FROM sessions WHERE provider = ?")
    .all(provider) as Array<{ id: string; file_path: string | null }>;
  let removed = 0;
  for (const r of rows) {
    const fp = r.file_path;
    if (fp == null) continue;
    if (seenDbIds) {
      // db-backed rows carry a "<store>-db:<id>" file_path.
      for (const prefix of ["hermes-db:", "opencode-db:"]) {
        if (fp.startsWith(prefix)) {
          if (!seenDbIds.has(fp.slice(prefix.length))) {
            deleteSession(db, r.id);
            removed++;
          }
          break;
        }
      }
      continue;
    }
    if (!seenPaths.has(fp)) removed += removeFileMapping(db, provider, fp);
  }
  return removed;
}

/** Keep rows belonging to an optional root that was absent for this pass. */
function preservePathsUnderRoots(
  db: Database.Database,
  provider: ProviderId,
  roots: string[],
  seenPaths: Set<string>,
): void {
  if (!roots.length) return;
  const prefixes = roots.map((root) => root.endsWith("/") ? root : `${root}/`);
  const mappings = db
    .prepare("SELECT file_path FROM session_files WHERE provider = ?")
    .all(provider) as Array<{ file_path: string }>;
  for (const mapping of mappings) {
    if (prefixes.some((prefix) => mapping.file_path.startsWith(prefix))) seenPaths.add(mapping.file_path);
  }
  const rows = db
    .prepare("SELECT file_path FROM sessions WHERE provider = ? AND file_path IS NOT NULL")
    .all(provider) as Array<{ file_path: string }>;
  for (const row of rows) {
    if (prefixes.some((prefix) => row.file_path.startsWith(prefix))) seenPaths.add(row.file_path);
  }
}

// ---------------------------------------------------------------------------
// Indexer
// ---------------------------------------------------------------------------

export interface IndexResult {
  indexed: number;
  removed: number;
  skipped: number;
  byProvider: Partial<Record<ProviderId, { indexed: number; removed: number; skipped: number }>>;
  completedProviders: ProviderId[];
}

interface IndexOptions {
  force?: boolean;
  providers?: ProviderId[];
  signal?: AbortSignal;
}

export interface Indexer {
  ensureIndexed(opts?: IndexOptions): Promise<IndexResult>;
  status(
    settings: IndexSettings,
    lastIndexAt: number | null,
    bbProviderIds?: ReadonlySet<string>,
  ): StatusSnapshot;
  search(query: string, providers?: ProviderId[], limit?: number): SessionRow[];
  /** Same filtering/ordering as search(), but also returns the total number
   *  of matches (before the limit) so UIs can show "top N of M". */
  searchWithTotal(
    query: string,
    providers?: ProviderId[],
    limit?: number,
    scope?: SessionScope,
  ): { rows: SessionRow[]; total: number };
  get(id: string, scope?: SessionScope): SessionRow | undefined;
  dispose(): void;
  waitForIdle(): Promise<void>;
}

export interface StatusSnapshot {
  providers: Array<{
    id: ProviderId;
    label: string;
    enabled: boolean;
    detected: boolean;
    supported: boolean;
    root: string | null;
    count: number;
    lastIndexedAt: number | null;
    lastWarning: string | null;
  }>;
  totalSessions: number;
  indexing: { active: boolean; phase: string; provider: string | null; done: number; total: number };
  lastIndexAt: number | null;
  error: string | null;
}

const KV_LAST_INDEX = "lastIndexAt";
const DB_LAST_ERROR = "lastError";

function sourceSuccessKey(provider: ProviderId): string {
  return `lastSuccess:${provider}`;
}

function pathIsPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: string }).code
      : undefined;
    // Permission and I/O errors mean "present but unreadable", which must
    // stay on the warning path rather than looking like an uninstalled store.
    return code !== "ENOENT";
  }
}

interface FileIdentity {
  dev: number;
  ino: number;
}

function regularFileIdentity(path: string): FileIdentity | null {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() ? { dev: stat.dev, ino: stat.ino } : null;
  } catch {
    return null;
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isWithinCanonicalRoot(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

function readIndexState(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare("SELECT value FROM session_index_state WHERE key = ?").get(key) as
      | { value: string | null }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function writeIndexState(db: Database.Database, key: string, value: string | null): void {
  try {
    if (value === null) {
      db.prepare("DELETE FROM session_index_state WHERE key = ?").run(key);
    } else {
      db.prepare(`
        INSERT INTO session_index_state (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, value);
    }
  } catch {
    // Health persistence must never turn a scan result into a failure.
  }
}

function sourceWarningKey(provider: ProviderId): string {
  return `warning:${provider}`;
}

function isDuplicateColumnError(error: unknown): boolean {
  return /duplicate column name|column .* already exists/iu.test(String(error));
}

function diagnosticKind(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length <= 64) return code;
    if (error instanceof Error && error.name.length <= 64) return error.name;
  }
  return "unknown error";
}

function safeDiagnostic(prefix: string, error: unknown): string {
  return `${prefix} (${diagnosticKind(error)})`;
}

export function createIndexer(deps: IndexerDeps): Indexer {
  type PendingWaiter = {
    opts: IndexOptions;
  };
  let running: Promise<IndexResult> | null = null;
  let pending: {
    opts: IndexOptions;
    waiters: PendingWaiter[];
    resolve: (result: IndexResult) => void;
    reject: (reason: unknown) => void;
    promise: Promise<IndexResult>;
  } | null = null;
  let active = false;
  let phase = "idle";
  let activeProvider: ProviderId | null = null;
  let doneCount = 0;
  let totalCount = 0;
  // Older versions persisted raw provider/parser messages. Do not replay
  // those unbounded diagnostics into a new RPC/UI process.
  let lastError: string | null = readIndexState(deps.db, DB_LAST_ERROR)
    ? "Previous index error"
    : null;
  const sourceWarnings = new Map<ProviderId, string>();
  for (const source of PROVIDER_SOURCES) {
    const warning = readIndexState(deps.db, sourceWarningKey(source.id));
    if (warning) sourceWarnings.set(source.id, "Previous scan warning");
  }
  let sourceProbeCache: { key: string; probes: SourceProbe[] } | null = null;
  let disposed = false;
  const disposeController = new AbortController();
  const sourceLastSuccess = new Map<ProviderId, number>();
  for (const source of PROVIDER_SOURCES) {
    const value = readIndexState(deps.db, sourceSuccessKey(source.id));
    const timestamp = value ? Number(value) : NaN;
    if (Number.isFinite(timestamp)) sourceLastSuccess.set(source.id, timestamp);
  }

  const shouldAbort = (signal?: AbortSignal): boolean =>
    disposed || disposeController.signal.aborted || signal?.aborted === true;

  const emptyResult = (): IndexResult => ({
    indexed: 0,
    removed: 0,
    skipped: 0,
    byProvider: {},
    completedProviders: [],
  });

  /**
   * A queued scan is shared by all callers, but cancellation belongs to the
   * caller that requested it. Do not let one cancelled UI/RPC request abort a
   * merged scan that another caller is still waiting for.
   */
  const resultForCaller = (
    promise: Promise<IndexResult>,
    signal?: AbortSignal,
    onCancel?: () => void,
  ): Promise<IndexResult> => {
    if (!signal) return promise;
    if (signal.aborted) return Promise.resolve(emptyResult());
    return new Promise<IndexResult>((resolve, reject) => {
      let settled = false;
      let onAbort: () => void;
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        onCancel?.();
        resolve(emptyResult());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (result) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        },
        (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    });
  };

  const mergeOptions = (requests: readonly IndexOptions[]): IndexOptions => {
    let force = false;
    let providers: ProviderId[] | undefined = [];
    for (const request of requests) {
      force ||= Boolean(request.force);
      if (request.providers === undefined) {
        providers = undefined;
      } else if (providers !== undefined) {
        providers.push(...request.providers);
      }
    }
    return {
      force,
      providers: providers === undefined ? undefined : [...new Set(providers)],
      // Caller abort signals are intentionally not part of the shared scan.
      signal: undefined,
    };
  };

  const removePendingWaiter = (waiter: PendingWaiter): void => {
    if (!pending) return;
    const index = pending.waiters.indexOf(waiter);
    if (index < 0) return;
    pending.waiters.splice(index, 1);
    if (pending.waiters.length === 0) {
      const abandoned = pending;
      pending = null;
      abandoned.resolve(emptyResult());
      return;
    }
    pending.opts = mergeOptions(pending.waiters.map((entry) => entry.opts));
  };

  function progress(p: IndexProgress) {
    if (p.phase !== "done" && p.phase !== "error") {
      active = true;
      phase = p.phase;
      activeProvider = p.provider ?? null;
      if (p.done != null) doneCount = p.done;
      if (p.total != null) totalCount = p.total;
    } else {
      active = false;
      phase = p.phase;
      activeProvider = null;
      doneCount = p.total ?? doneCount;
      sourceProbeCache = null;
      if (p.phase === "done" && !p.cancelled) {
        lastError = null;
        writeIndexState(deps.db, DB_LAST_ERROR, null);
      }
    }
    if (p.message) deps.log(p.message.slice(0, 2_000));
    try {
      deps.publish(p);
    } catch {
      // publishing must never break indexing
    }
  }

  /** Enabled for a source id, per current settings. */
  function sourceEnabled(
    settings: IndexSettings,
    id: ProviderId,
  ): boolean {
    return settings[`${id}Enabled`] as boolean;
  }

  async function ensureIndexed(opts: IndexOptions = {}): Promise<IndexResult> {
    if (shouldAbort(opts.signal)) return emptyResult();
    if (running) {
      const waiter: PendingWaiter = { opts: { ...opts, signal: undefined } };
      if (!pending) {
        let resolvePending!: (result: IndexResult) => void;
        let rejectPending!: (reason: unknown) => void;
        const promise = new Promise<IndexResult>((resolve, reject) => {
          resolvePending = resolve;
          rejectPending = reject;
        });
        pending = {
          opts: waiter.opts,
          waiters: [waiter],
          resolve: resolvePending,
          reject: rejectPending,
          promise,
        };
      } else {
        pending.waiters.push(waiter);
        pending.opts = mergeOptions(pending.waiters.map((entry) => entry.opts));
      }
      const shared = pending;
      return resultForCaller(shared.promise, opts.signal, () => removePendingWaiter(waiter));
    }
    // Caller cancellation only cancels that caller's wait. The scan itself is
    // shared work and may be needed by another caller or the background
    // service, so only plugin disposal can interrupt it.
    const scanSignal = disposeController.signal;
    const current = (async () => {
      let settings!: IndexSettings;
      let indexed = 0;
      let removed = 0;
      let skipped = 0;
      const byProvider: IndexResult["byProvider"] = {};
      const completedProviders: ProviderId[] = [];

      const cancelledResult = (): IndexResult => {
        progress({ phase: "done", cancelled: true, message: "Index cancelled" });
        return { indexed, removed, skipped, byProvider, completedProviders };
      };

      if (shouldAbort(scanSignal)) return cancelledResult();

      const markSourceSuccess = (provider: ProviderId) => {
        const timestamp = Date.now();
        sourceWarnings.delete(provider);
        writeIndexState(deps.db, sourceWarningKey(provider), null);
        sourceLastSuccess.set(provider, timestamp);
        writeIndexState(deps.db, sourceSuccessKey(provider), String(timestamp));
        completedProviders.push(provider);
      };

      const doSource = async (source: ProviderSource) => {
        if (shouldAbort(scanSignal)) return;
        const provider = source.id;
        const pStats = { indexed: 0, removed: 0, skipped: 0 };
        const bump = (kind: "indexed" | "removed" | "skipped", n: number) => {
          pStats[kind] += n;
          if (kind === "indexed") indexed += n;
          else if (kind === "removed") removed += n;
          else skipped += n;
        };
        activeProvider = provider;
        const seenPaths = new Set<string>();
        let scanComplete = true;
        let preserveExisting = false;
        const warn = (message: string) => {
          const bounded = message.length > 2_000 ? `${message.slice(0, 1_999)}…` : message;
          scanComplete = false;
          sourceWarnings.set(provider, bounded);
          writeIndexState(deps.db, sourceWarningKey(provider), bounded);
          deps.log(bounded);
        };

        if (
          source.kind === "codex" ||
          source.kind === "claude" ||
          source.kind === "pi" ||
          source.kind === "prime" ||
          source.kind === "omp"
        ) {
          const roots = resolveSourceRoots(source, settings);
          const configuredRoot = roots[0] ?? "";
          const ownerRoot = source.sharedWith
            ? canonicalStorePath(settings[`${source.sharedWith}Path`])
            : null;
          const sharedWithOwner = Boolean(
            ownerRoot && configuredRoot && canonicalStorePath(configuredRoot) === ownerRoot,
          );
          progress({
            phase: "scanning",
            provider,
            message: sharedWithOwner
              ? `${PROVIDER_LABELS[provider]} shares ${configuredRoot}; ${PROVIDER_LABELS[source.sharedWith!]} owns the unclassified files`
              : `Scanning ${PROVIDER_LABELS[provider]} at ${roots.join(" + ")}`,
          });
          if (sharedWithOwner) {
            // A Pi-format file does not contain reliable Pi-vs-Prime
            // provenance. Removing old rows here prevents the previous
            // "Pi / Prime Agent" shortcut from leaving false duplicates.
            // The shared owner has no provider-specific provenance, so Prime
            // rows are removed only after proving the owner root is readable.
            // A missing default root is a normal "not detected" state and
            // must not erase durable history.
            const ownerScan = walkJsonl(
              configuredRoot,
              source.defaultRoots.some((root) => canonicalStorePath(root) === canonicalStorePath(configuredRoot)),
              scanSignal,
            );
            if (ownerScan.missingRoot) {
              preserveExisting = true;
            } else if (!ownerScan.complete) {
              warn(`Could not inspect shared ${PROVIDER_LABELS[source.sharedWith!]} store; keeping existing indexed rows`);
              preserveExisting = true;
            } else if (!walkedRootsStable([ownerScan])) {
              warn(`The shared ${PROVIDER_LABELS[source.sharedWith!]} root changed during the scan; keeping existing indexed rows`);
              preserveExisting = true;
            } else {
              progress({ phase: "pruning", provider });
              bump("removed", pruneBySeen(deps.db, provider, new Set()));
            }
            byProvider[provider] = pStats;
            if (scanComplete) markSourceSuccess(provider);
            return;
          }
          const optionalRoots = new Set((source.archiveRoots ?? []).map(resolveHome));
          const defaultRoots = new Set(source.defaultRoots.map(resolveHome));
          const walked = roots.map((root) => walkJsonl(
            root,
            optionalRoots.has(root) || defaultRoots.has(root),
            scanSignal,
          ));
          if (shouldAbort(scanSignal)) return;
          const missingRequiredRoot = walked.some((result, index) => result.missingRoot && !optionalRoots.has(roots[index]!));
          const missingOptionalRoots = walked
            .map((result, index) => result.missingRoot && optionalRoots.has(roots[index]!) ? roots[index]! : null)
            .filter((root): root is string => root !== null);
          // An absent archive is a normal optional-store state. Preserve its
          // already-indexed rows, but still allow a complete primary scan to
          // prune files that were actually deleted from the primary root.
          preservePathsUnderRoots(deps.db, provider, missingOptionalRoots, seenPaths);
          preserveExisting = missingRequiredRoot;
          const files = walked
            .flatMap((result, index) => result.files.map((file) => ({
              ...file,
              archived: optionalRoots.has(roots[index]!),
            })))
            .filter((file) => !isIgnoredSessionPath(provider, file.path));
          const walkErrors = walked.flatMap((result) => result.errors);
          if (walked.some((result) => !result.complete)) {
            warn(
              `Could not fully scan ${PROVIDER_LABELS[provider]}; keeping existing indexed rows${
                walkErrors.length ? ` (${walkErrors.slice(0, 2).join("; ")})` : ""
              }`,
            );
          }
          totalCount = files.length;
          doneCount = 0;
          const claudeGroups = new Map<string, {
            entries: Array<{ meta: SessionMeta; file: WalkedFile }>;
            changed: boolean;
            failed: boolean;
          }>();
          for (let i = 0; i < files.length; i++) {
            if (shouldAbort(scanSignal)) return;
            const f = files[i];
            seenPaths.add(f.path);
            const existing = dbGetByFilePath(deps.db, provider, f.path);
            const unchanged = Boolean(
              !opts.force &&
              existing &&
              existing.mtimeMs === f.mtimeMs &&
              existing.sizeBytes === f.sizeBytes
            );
            if (provider === "claude") {
              // Claude Code's parent and subagent files share sessionId. Read
              // every file in the group so one physical file cannot overwrite
              // the aggregate metrics from its siblings. Quiet groups still
              // avoid a database write below when every file is unchanged.
              let parsed: SessionMeta | null = null;
              let disposition: "session" | "not-session" | "failed" = "failed";
              try {
                const result = await parseJsonlStreaming(
                    provider as Exclude<ProviderId, "hermes" | "opencode">,
                    f.path,
                    f.mtimeMs,
                    f.sizeBytes,
                    `${f.path}:${f.sizeBytes}:${Math.round(f.mtimeMs)}`,
                    "primary",
                    scanSignal,
                    { dev: f.dev, ino: f.ino },
                    f.ancestors,
                  );
                parsed = result.meta;
                disposition = result.disposition;
                } catch (err) {
                  if (shouldAbort(scanSignal)) return;
                  deps.log(safeDiagnostic(`Could not parse ${f.path}`, err));
                }
                if (parsed) {
                parsed.archived = f.archived === true;
                const group = claudeGroups.get(parsed.id) ?? { entries: [], changed: false, failed: false };
                group.entries.push({ meta: parsed, file: f });
                group.changed ||= !unchanged;
                claudeGroups.set(parsed.id, group);
              } else if (disposition === "failed") {
                warn(`Could not parse ${f.path}; keeping its existing indexed row`);
                const groupId = existing?.sessionId;
                if (groupId) {
                  const group = claudeGroups.get(groupId) ?? { entries: [], changed: false, failed: false };
                  group.changed = true;
                  group.failed = true;
                  claudeGroups.set(groupId, group);
                }
              } else if (existing && disposition === "not-session") {
                // file no longer parses to a session; drop any stale row
                // mapping, while sibling files keep the logical session alive.
                bump("removed", removeFileMapping(deps.db, provider, f.path));
              }
            } else {
              if (unchanged) {
                bump("skipped", 1);
              } else {
                let parsed: SessionMeta | null = null;
                let disposition: "session" | "not-session" | "failed" = "failed";
                try {
                  const result = await parseJsonlStreaming(
                      provider as Exclude<ProviderId, "hermes" | "opencode">,
                      f.path,
                      f.mtimeMs,
                      f.sizeBytes,
                      `${f.path}:${f.sizeBytes}:${Math.round(f.mtimeMs)}`,
                      "primary",
                    scanSignal,
                      { dev: f.dev, ino: f.ino },
                      f.ancestors,
                    );
                  parsed = result.meta;
                  disposition = result.disposition;
                } catch (err) {
                  if (shouldAbort(scanSignal)) return;
                  deps.log(safeDiagnostic(`Could not parse ${f.path}`, err));
                }
                if (parsed) {
                  parsed.archived = f.archived === true;
                  upsertSession(deps.db, parsed);
                  bump("indexed", 1);
                } else if (disposition === "not-session") {
                  bump("removed", removeFileMapping(deps.db, provider, f.path));
                } else if (disposition === "failed") {
                  warn(`Could not parse ${f.path}; keeping its existing indexed row`);
                }
              }
            }
            if (i % 40 === 0 || i === files.length - 1) {
              progress({ phase: "indexing", provider, done: i + 1, total: files.length });
            }
          }
          if (provider === "claude") {
            for (const group of claudeGroups.values()) {
              if (shouldAbort(scanSignal)) return;
              const sessionId = group.entries[0]?.meta.id;
              if (group.failed) {
                bump("skipped", 1);
                continue;
              }
              if (sessionId) {
                const known = new Set(
                  (deps.db.prepare(
                    "SELECT file_path FROM session_files WHERE provider = 'claude' AND session_id = ?",
                  ).all(sessionId) as Array<{ file_path: string }>).map((row) => row.file_path),
                );
                const current = new Set(group.entries.map((entry) => entry.file.path));
                group.changed ||= known.size !== current.size || [...known].some((path) => !current.has(path));
              }
              if (!group.changed) {
                bump("skipped", 1);
                continue;
              }
              const merged = mergeSessionMetas(group.entries.map((entry) => entry.meta));
              upsertSession(deps.db, merged);
              for (const entry of group.entries) {
                mapSessionFile(
                  deps.db,
                  provider,
                  entry.file.path,
                  merged.id,
                  entry.file.sizeBytes,
                  entry.file.mtimeMs,
                );
              }
              bump("indexed", 1);
            }
          }
          if (scanComplete && (!walkedAncestorsStable(files) || !walkedRootsStable(walked))) {
            warn(`The ${PROVIDER_LABELS[provider]} directory tree changed during the scan; keeping existing indexed rows`);
            preserveExisting = true;
          }
          if (scanComplete && !preserveExisting) {
            progress({ phase: "pruning", provider });
            bump("removed", pruneBySeen(deps.db, provider, seenPaths));
          }
        } else if (source.kind === "hermes") {
          const dbPath = settings.hermesPath;
          progress({
            phase: "scanning",
            provider,
            message: `Scanning ${PROVIDER_LABELS[provider]} (${dbPath})`,
          });
          totalCount = 1;
          doneCount = 0;
          const seenDbIds = new Set<string>();
          if (dbPath.trim()) {
            const storePath = resolveHome(dbPath);
            const storeIdentity = regularFileIdentity(storePath);
            const hdb = openHermesDb(dbPath);
            if (hdb) {
              try {
                const rows: HermesSessionRow[] = readHermesSessions(hdb);
                const countStmt = hdb.prepare(
                  `SELECT COUNT(*) AS c FROM messages
                   WHERE session_id = ? AND role IN ('user','assistant')
                     AND content IS NOT NULL AND length(trim(content)) > 0`,
                );
                for (const row of rows) {
                  if (shouldAbort(scanSignal)) return;
                  const stableDbId = boundedProviderSessionId(row.id, "hermes-session");
                  seenDbIds.add(stableDbId);
                  const key = `hermes:${stableDbId}`;
                  const existing = deps.db
                    .prepare("SELECT updated_at, message_count FROM sessions WHERE id = ?")
                    .get(key) as { updated_at: number | null; message_count: number } | undefined;
                  const updated = row.lastActivityAt ?? row.startedAt;
                  const canonicalCount = (countStmt.get(row.id) as { c: number }).c;
                  if (
                    !opts.force &&
                    existing &&
                    existing.updated_at === updated &&
                    existing.message_count === canonicalCount
                  ) {
                    bump("skipped", 1);
                    continue;
                  }
                  const conversation = readHermesConversation(hdb, row.id);
                  const meta = hermesSessionToMeta(
                    row,
                    conversation.messages,
                    conversation.trace,
                    conversation.traceTruncated,
                    conversation.toolCalls,
                    conversation.toolErrors,
                  );
                  if (conversation.parseFailed || conversation.sourceTruncated) {
                    warn(
                      conversation.sourceTruncated
                        ? `Could not fully read a ${PROVIDER_LABELS[provider]} session; the provider row limit was reached and its existing indexed row was kept`
                        : `Could not fully parse a ${PROVIDER_LABELS[provider]} session; keeping its existing indexed row`,
                    );
                  } else if (meta) {
                    upsertSession(deps.db, meta);
                    bump("indexed", 1);
                  } else if (existing) {
                    deleteSession(deps.db, key);
                    bump("removed", 1);
                  }
                }
                const currentIdentity = regularFileIdentity(storePath);
                if (
                  !storeIdentity ||
                  !currentIdentity ||
                  !sameFileIdentity(storeIdentity, currentIdentity)
                ) {
                  warn(`The ${PROVIDER_LABELS[provider]} store changed during the scan; keeping existing indexed rows`);
                  preserveExisting = true;
                }
              } catch (err) {
                warn(safeDiagnostic(`Could not fully scan ${PROVIDER_LABELS[provider]}`, err));
              } finally {
                hdb.close();
              }
            } else {
              const missingDefaultStore =
                source.defaultRoots.some((root) => resolveHome(root) === resolveHome(dbPath)) &&
                !pathIsPresent(resolveHome(dbPath));
              if (missingDefaultStore) {
                // An uninstalled optional provider is a clean "not detected"
                // state. Preserve historical rows and complete migration
                // bookkeeping without pruning.
                preserveExisting = true;
              } else {
                warn(`Could not open ${PROVIDER_LABELS[provider]} store; keeping existing indexed rows`);
              }
            }
          } else {
            warn(`No ${PROVIDER_LABELS[provider]} store path is configured; keeping existing indexed rows`);
          }
          progress({ phase: "indexing", provider, done: 1, total: totalCount });
          if (scanComplete && !preserveExisting) {
            progress({ phase: "pruning", provider });
            bump("removed", pruneBySeen(deps.db, "hermes", seenPaths, seenDbIds));
          }
        } else {
          // opencode — single SQLite store
          const dbPath = settings.opencodePath;
          progress({
            phase: "scanning",
            provider,
            message: `Scanning ${PROVIDER_LABELS[provider]} (${dbPath})`,
          });
          const seenDbIds = new Set<string>();
          const storePath = resolveHome(dbPath);
          const storeIdentity = regularFileIdentity(storePath);
          const odb = openOpenCodeDb(dbPath);
          if (odb) {
            try {
              const rows: OpenCodeSessionRow[] = readOpenCodeSessions(odb);
              totalCount = rows.length;
              doneCount = 0;
              for (let i = 0; i < rows.length; i++) {
                if (shouldAbort(scanSignal)) return;
                const row = rows[i];
                const stableDbId = boundedProviderSessionId(row.id, "opencode-session");
                seenDbIds.add(stableDbId);
                const key = `opencode:${stableDbId}`;
                const existing = deps.db
                  .prepare("SELECT updated_at, message_count FROM sessions WHERE id = ?")
                  .get(key) as { updated_at: number | null; message_count: number } | undefined;
                const updated = row.timeUpdated ?? row.timeCreated;
                if (!opts.force && existing && existing.updated_at === updated) {
                  // Unchanged session (time_updated bumps on new messages).
                  bump("skipped", 1);
                  continue;
                }
                const conversation = readOpenCodeConversation(odb, row.id);
                if (conversation.parseFailed || conversation.sourceTruncated) {
                  warn(
                    conversation.sourceTruncated
                      ? `Could not fully read a ${PROVIDER_LABELS[provider]} session; the provider row limit was reached and its existing indexed row was kept`
                      : `Could not fully parse a ${PROVIDER_LABELS[provider]} session; keeping its existing indexed row`,
                  );
                  continue;
                }
                const meta = openCodeSessionToMeta(
                  row,
                  conversation.messages,
                  conversation.trace,
                  conversation.traceTruncated,
                  conversation.toolCalls,
                  conversation.toolErrors,
                );
                if (meta) {
                  upsertSession(deps.db, meta);
                  bump("indexed", 1);
                } else if (existing) {
                  deleteSession(deps.db, key);
                  bump("removed", 1);
                }
                progress({
                  phase: "indexing",
                  provider,
                  done: i + 1,
                  total: totalCount,
                });
              }
              const currentIdentity = regularFileIdentity(storePath);
              if (
                !storeIdentity ||
                !currentIdentity ||
                !sameFileIdentity(storeIdentity, currentIdentity)
              ) {
                warn(`The ${PROVIDER_LABELS[provider]} store changed during the scan; keeping existing indexed rows`);
                preserveExisting = true;
              }
            } catch (err) {
              warn(safeDiagnostic(`Could not fully scan ${PROVIDER_LABELS[provider]}`, err));
            } finally {
              odb.close();
            }
          } else {
            const missingDefaultStore =
              source.defaultRoots.some((root) => resolveHome(root) === resolveHome(dbPath)) &&
              !pathIsPresent(resolveHome(dbPath));
            if (missingDefaultStore) {
              preserveExisting = true;
            } else {
              warn(`Could not open ${PROVIDER_LABELS[provider]} store; keeping existing indexed rows`);
            }
          }
          if (scanComplete && !preserveExisting) {
            progress({ phase: "pruning", provider });
            bump("removed", pruneBySeen(deps.db, "opencode", seenPaths, seenDbIds));
          }
        }
        if (scanComplete) markSourceSuccess(provider);
        byProvider[provider] = pStats;
      };

      try {
        settings = await deps.getSettings();
        if (shouldAbort(scanSignal)) return cancelledResult();
        const providerFilterValid = opts.providers === undefined || opts.providers.every(isKnownProviderId);
        const explicit = providerFilterValid ? opts.providers ?? [] : [];
        // An omitted provider filter means "all enabled sources". An explicit
        // empty or invalid filter is a no-op and never clears health state.
        if (opts.providers !== undefined && (!providerFilterValid || opts.providers.length === 0)) {
          return { indexed: 0, removed: 0, skipped: 0, byProvider, completedProviders };
        }
        const want = opts.providers !== undefined
          ? [...new Set(explicit.map((id) => getSource(id)!).filter(Boolean))]
          : PROVIDER_SOURCES.filter((s) => sourceEnabled(settings, s.id));
        for (const source of want) {
          await doSource(source);
          if (shouldAbort(scanSignal)) return cancelledResult();
        }
        const incompleteProviders = want
          .map((source) => source.id)
          .filter((provider) => !completedProviders.includes(provider));
        const total = countSessions(deps.db);
        if (incompleteProviders.length > 0) {
          lastError = `Index completed with warnings for ${incompleteProviders.join(", ")}`;
          writeIndexState(deps.db, DB_LAST_ERROR, lastError);
          progress({
            phase: "error",
            totalSessions: total,
            message: `${lastError}; existing indexed rows were kept`,
          });
        } else {
          await deps.kv.set(KV_LAST_INDEX, Date.now());
          progress({
            phase: "done",
            totalSessions: total,
            message: `Index complete: ${indexed} new/updated, ${removed} pruned, ${skipped} unchanged, ${total} total`,
          });
        }
        return { indexed, removed, skipped, byProvider, completedProviders };
      } catch (err) {
        if (shouldAbort(scanSignal)) return cancelledResult();
        lastError = safeDiagnostic("Index failed", err);
        writeIndexState(deps.db, DB_LAST_ERROR, lastError);
        progress({ phase: "error", message: `Index failed: ${lastError}` });
        throw err;
      }
    })();
    running = current;
    const finish = (result?: IndexResult, error?: unknown) => {
      if (running !== current) return;
      running = null;
      const next = pending;
      pending = null;
      if (next) {
        const nextRun = ensureIndexed(next.opts);
        nextRun.then(next.resolve, next.reject);
      }
      if (error !== undefined) return;
      void result;
    };
    current.then(
      (result) => finish(result),
      (error) => finish(undefined, error),
    );
    return resultForCaller(current, opts.signal);
  }

  function dbGetByFilePath(
    db: Database.Database,
    provider: ProviderId,
    filePath: string,
  ): { sessionId: string; sizeBytes: number | null; mtimeMs: number | null } | undefined {
    const row = db
      .prepare(`
        SELECT f.session_id, f.size_bytes, f.mtime_ms
        FROM session_files f
        WHERE f.provider = ? AND f.file_path = ?
        UNION ALL
        SELECT s.id AS session_id, s.size_bytes, s.mtime_ms
        FROM sessions s
        WHERE s.provider = ? AND s.file_path = ?
          AND NOT EXISTS (
            SELECT 1 FROM session_files f
            WHERE f.provider = s.provider AND f.file_path = s.file_path
          )
        LIMIT 1
      `)
      .get(provider, filePath, provider, filePath) as
      | { session_id: string; size_bytes: number | null; mtime_ms: number | null }
      | undefined;
    if (!row) return undefined;
    return { sessionId: row.session_id, sizeBytes: row.size_bytes, mtimeMs: row.mtime_ms };
  }

  function countSessions(db: Database.Database): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c;
  }

  function status(
    settings: IndexSettings,
    lastIndexAt: number | null,
    bbProviderIds: ReadonlySet<string> = new Set(),
  ): StatusSnapshot {
    // A warning from a disabled source is no longer actionable and must not
    // reappear if that source is enabled again later.
    for (const source of PROVIDER_SOURCES) {
      if (!sourceEnabled(settings, source.id)) {
        sourceWarnings.delete(source.id);
        writeIndexState(deps.db, sourceWarningKey(source.id), null);
      }
    }
    const rows = deps.db
      .prepare("SELECT provider, COUNT(*) AS c FROM sessions GROUP BY provider")
      .all() as Array<{ provider: string; c: number }>;
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    const probeKey = JSON.stringify({
      settings: PROVIDER_SOURCES.map((source) => [
        source.id,
        settings[`${source.id}Enabled`],
        settings[`${source.id}Path`],
      ]),
      bbProviderIds: [...bbProviderIds].sort(),
    });
    if (sourceProbeCache?.key !== probeKey) {
      sourceProbeCache = { key: probeKey, probes: probeSources(settings, bbProviderIds) };
    }
    const probes: SourceProbe[] = sourceProbeCache.probes;
    return {
      providers: probes.map((p) => {
        const r = byProvider.get(p.id);
        return {
          id: p.id,
          label: p.label,
          enabled: p.enabled,
          detected: p.detected,
          supported: p.supported,
          root: p.detected ? p.root : null,
          count: r?.c ?? 0,
          // `indexed_at` is a row mutation time, not a successful source
          // scan. Use the durable completion marker so partial scans cannot
          // masquerade as fresh data.
          lastIndexedAt: sourceLastSuccess.get(p.id) ?? null,
          lastWarning: sourceWarnings.get(p.id) ?? null,
        };
      }),
      totalSessions: countSessions(deps.db),
      indexing: {
        active,
        phase,
        provider: activeProvider,
        done: doneCount,
        total: totalCount,
      },
      lastIndexAt,
      error: lastError,
    };
  }

  function countFor(
    sql: string,
    params: unknown[],
  ): number {
    const r = deps.db.prepare(sql).get(...(params as never[])) as
      | { c: number }
      | undefined;
    return r?.c ?? 0;
  }

  function scopeFilter(scope: SessionScope | undefined, alias = ""): {
    sql: string;
    params: Array<string | number>;
  } {
    if (scope === undefined) return { sql: "1 = 1", params: [] };
    return buildScopeFilter(scope.roots, alias);
  }

  /** Shared search implementation: filtered rows + total match count. */
  function searchWithTotal(
    query: string,
    providers?: ProviderId[],
    limit = 50,
    scope?: SessionScope,
  ): { rows: SessionRow[]; total: number } {
    if (providers !== undefined && (!providers.length || !providers.every(isKnownProviderId))) {
      return { rows: [], total: 0 };
    }
    const provFilter = providers === undefined
      ? [...PROVIDER_IDS]
      : [...new Set(providers)];
    if (provFilter.length === 0) return { rows: [], total: 0 };
    const placeholders = provFilter.map(() => "?").join(",");
    const scopeSql = scopeFilter(scope);
    const rawQuery = query.trim();
    const q = rawQuery.replace(/[\u0000-\u001F]/g, " ").trim();
    if (rawQuery && !q) return { rows: [], total: 0 };
    const searchColumns = `
      id, provider, provider_session_id, file_path, archived, title, cwd, git_repo_root,
      started_at, updated_at, activity_at, model, origin, message_count,
      summary, first_user_message, size_bytes, mtime_ms, indexed_at, status
    `;
    if (!q) {
      const sql = `SELECT ${searchColumns} FROM sessions WHERE provider IN (${placeholders})
                   AND (${scopeSql.sql}) ORDER BY activity_at DESC LIMIT ?`;
      const rows = deps.db
        .prepare(sql)
        .all(...provFilter, ...scopeSql.params, limit) as Record<string, unknown>[];
      const total = countFor(
        `SELECT COUNT(*) AS c FROM sessions WHERE provider IN (${placeholders}) AND (${scopeSql.sql})`,
        [...provFilter, ...scopeSql.params],
      );
      return { rows: rows.map(mapSearchRow), total };
    }
    // FTS5 match with quoted terms; fall back to LIKE on parse failure.
    const terms = q.split(/\s+/).filter(Boolean).slice(0, 8);
    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" ");
    try {
      const sql = `SELECT s.${searchColumns.replaceAll("\n", " ").trim().replaceAll(", ", ", s.")} FROM sessions_fts f
                   JOIN sessions s ON s.rowid = f.rowid
                   WHERE sessions_fts MATCH ? AND s.provider IN (${placeholders}) AND (${scopeFilter(scope, "s").sql})
                   ORDER BY bm25(sessions_fts), s.activity_at DESC
                   LIMIT ?`;
      const rows = deps.db
        .prepare(sql)
        .all(ftsQuery, ...provFilter, ...scopeFilter(scope, "s").params, limit) as Record<string, unknown>[];
      const total = countFor(
        `SELECT COUNT(*) AS c FROM sessions_fts f
         JOIN sessions s ON s.rowid = f.rowid
         WHERE sessions_fts MATCH ? AND s.provider IN (${placeholders}) AND (${scopeFilter(scope, "s").sql})`,
        [ftsQuery, ...provFilter, ...scopeFilter(scope, "s").params],
      );
      return { rows: rows.map(mapSearchRow), total };
    } catch {
      const like = `%${q}%`;
      const sql = `SELECT ${searchColumns} FROM sessions
                   WHERE provider IN (${placeholders}) AND (${scopeSql.sql})
                     AND (title LIKE ? OR first_user_message LIKE ? OR transcript LIKE ? OR cwd LIKE ? OR file_path LIKE ? OR trace_json LIKE ?)
                   ORDER BY activity_at DESC LIMIT ?`;
      const rows = deps.db
        .prepare(sql)
        .all(...provFilter, ...scopeSql.params, like, like, like, like, like, like, limit) as Record<string, unknown>[];
      const total = countFor(
        `SELECT COUNT(*) AS c FROM sessions
         WHERE provider IN (${placeholders}) AND (${scopeSql.sql})
           AND (title LIKE ? OR first_user_message LIKE ? OR transcript LIKE ? OR cwd LIKE ? OR file_path LIKE ? OR trace_json LIKE ?)`,
        [...provFilter, ...scopeSql.params, like, like, like, like, like, like],
      );
      return { rows: rows.map(mapSearchRow), total };
    }
  }

  function search(
    query: string,
    providers?: ProviderId[],
    limit = 50,
  ): SessionRow[] {
    return searchWithTotal(query, providers, limit).rows;
  }

  function get(id: string, scope?: SessionScope): SessionRow | undefined {
    const scoped = scopeFilter(scope);
    const row = deps.db.prepare(`
      SELECT id, provider, provider_session_id, file_path, title, cwd, git_repo_root,
             archived,
             started_at, updated_at, activity_at, model, origin, message_count,
             summary, first_user_message, substr(transcript, 1, 120000) AS transcript,
             length(transcript) AS transcript_length,
             truncated, size_bytes, mtime_ms, trace_json, trace_truncated, indexed_at,
             status, duration_ms, turn_count, tool_calls, tool_errors, input_tokens,
             cached_input_tokens, cached_write_tokens, output_tokens, reasoning_tokens,
             total_tokens, context_peak, compaction_count, failure_count,
             delegated_count, cost_usd, cost_estimated, coverage_json
      FROM sessions WHERE id = ? AND (${scoped.sql})
    `).get(id, ...scoped.params) as
      | Record<string, unknown>
      | undefined;
    return row ? mapRow(row) : undefined;
  }

  return {
    ensureIndexed,
    status,
    search,
    searchWithTotal,
    get,
    dispose() {
      disposed = true;
      disposeController.abort();
    },
    async waitForIdle() {
      // A dispose may race a queued scoped scan. Drain both the active and
      // queued promises so the owning plugin can close SQLite only after no
      // parser or transaction can touch it.
      while (running || pending) {
        const activeRun = running;
        const queuedRun = pending?.promise;
        await Promise.all([
          activeRun?.catch(() => undefined),
          queuedRun?.catch(() => undefined),
        ]);
      }
    },
  };
}
