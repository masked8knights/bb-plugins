import type Database from "better-sqlite3";
import type {
  CapabilityReport,
  EvidenceRef,
  FindingRecord,
  LinkRecord,
  NormalizedBbEvent,
  NormalizedItem,
  NormalizedTurn,
  ProviderSessionRecord,
  SessionDetailResult,
  SourceStatusRecord,
  UsageSnapshot,
} from "./types";
import { emptyCapabilities } from "./types";

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS analytics_sources (
     id TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     label TEXT NOT NULL,
     host_id TEXT NOT NULL,
     store_kind TEXT NOT NULL,
     path_label TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     detected INTEGER NOT NULL DEFAULT 0,
     supported INTEGER NOT NULL DEFAULT 0,
     count INTEGER NOT NULL DEFAULT 0,
     capabilities_json TEXT NOT NULL DEFAULT '{}',
     cursor TEXT,
     last_success_at INTEGER,
     last_error TEXT,
     remote_database_unsupported INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS analytics_sessions (
     id TEXT PRIMARY KEY,
     source TEXT NOT NULL,
     provider TEXT NOT NULL,
     host_id TEXT NOT NULL,
     provider_session_id TEXT,
     bb_thread_id TEXT,
     title TEXT NOT NULL,
     cwd TEXT,
     project_id TEXT,
     model TEXT,
     origin TEXT,
     status TEXT NOT NULL,
     started_at INTEGER,
     updated_at INTEGER,
     duration_ms INTEGER,
     message_count INTEGER NOT NULL DEFAULT 0,
     turn_count INTEGER NOT NULL DEFAULT 0,
     tool_calls INTEGER NOT NULL DEFAULT 0,
     tool_errors INTEGER NOT NULL DEFAULT 0,
     input_tokens INTEGER,
     cached_input_tokens INTEGER,
     output_tokens INTEGER,
     reasoning_tokens INTEGER,
     total_tokens INTEGER,
     context_peak REAL,
     compaction_count INTEGER NOT NULL DEFAULT 0,
     failure_count INTEGER NOT NULL DEFAULT 0,
     delegated_count INTEGER NOT NULL DEFAULT 0,
     archived INTEGER NOT NULL DEFAULT 0,
     coverage_json TEXT NOT NULL DEFAULT '{}',
     store_label TEXT NOT NULL,
     fingerprint TEXT,
     link_state TEXT NOT NULL DEFAULT 'none',
     finding_count INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS analytics_turns (
     id TEXT NOT NULL,
     session_id TEXT NOT NULL,
     started_at INTEGER,
     ended_at INTEGER,
     status TEXT NOT NULL,
     duration_ms INTEGER,
     steps INTEGER NOT NULL DEFAULT 0,
     tool_calls INTEGER NOT NULL DEFAULT 0,
     tool_errors INTEGER NOT NULL DEFAULT 0,
     input_tokens INTEGER,
     cached_input_tokens INTEGER,
     output_tokens INTEGER,
     reasoning_tokens INTEGER,
     total_tokens INTEGER,
     context_peak REAL,
     source_sequence_start INTEGER,
     source_sequence_end INTEGER,
     PRIMARY KEY (session_id, id)
   )`,
  `CREATE TABLE IF NOT EXISTS analytics_items (
     id TEXT NOT NULL,
     session_id TEXT NOT NULL,
     turn_id TEXT,
     kind TEXT NOT NULL,
     tool_name TEXT,
     status TEXT NOT NULL,
     duration_ms INTEGER,
     error_category TEXT,
     approval_status TEXT,
     source_sequence INTEGER NOT NULL,
     at INTEGER,
     PRIMARY KEY (session_id, id)
   )`,
  `CREATE TABLE IF NOT EXISTS analytics_usage (
     session_id TEXT NOT NULL,
     turn_id TEXT,
     source_sequence INTEGER NOT NULL,
     input_tokens INTEGER,
     cached_input_tokens INTEGER,
     output_tokens INTEGER,
     reasoning_tokens INTEGER,
     total_tokens INTEGER,
     context_used REAL,
     context_limit REAL,
     estimated INTEGER NOT NULL DEFAULT 0,
     at INTEGER,
     PRIMARY KEY (session_id, source_sequence)
   )`,
  `CREATE TABLE IF NOT EXISTS analytics_events (
     session_id TEXT NOT NULL,
     source_sequence INTEGER NOT NULL,
     event_type TEXT NOT NULL,
     turn_id TEXT,
     at INTEGER,
     classification TEXT NOT NULL,
     status TEXT,
     duration_ms INTEGER,
     tool_name TEXT,
     error_category TEXT,
     approval_status TEXT,
     input_tokens INTEGER,
     cached_input_tokens INTEGER,
     output_tokens INTEGER,
     reasoning_tokens INTEGER,
     total_tokens INTEGER,
     context_used REAL,
     context_limit REAL,
     estimated INTEGER NOT NULL DEFAULT 0,
     provider_session_id TEXT,
     PRIMARY KEY (session_id, source_sequence)
   )`,
  `CREATE TABLE IF NOT EXISTS analytics_evidence (
     session_id TEXT NOT NULL,
     source_sequence INTEGER,
     event_type TEXT NOT NULL,
     source TEXT NOT NULL,
     at INTEGER,
     PRIMARY KEY (session_id, source_sequence, event_type)
   )`,
  `CREATE TABLE IF NOT EXISTS analytics_session_links (
     provider_record_id TEXT PRIMARY KEY,
     bb_thread_id TEXT NOT NULL,
     strategy TEXT NOT NULL,
     confidence REAL NOT NULL,
     policy TEXT NOT NULL,
     evidence_json TEXT NOT NULL DEFAULT '[]',
     matched_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS analytics_findings (
     id TEXT PRIMARY KEY,
     rule_id TEXT NOT NULL,
     severity TEXT NOT NULL,
     source TEXT NOT NULL,
     provider TEXT NOT NULL,
     scope TEXT NOT NULL,
     scope_id TEXT,
     title TEXT NOT NULL,
     summary TEXT NOT NULL,
     recommendation TEXT NOT NULL,
     metric_value REAL,
     threshold REAL,
     sample_size INTEGER NOT NULL,
     coverage_note TEXT NOT NULL,
     evidence_json TEXT NOT NULL DEFAULT '[]',
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_analytics_sessions_provider ON analytics_sessions(provider)`,
  `CREATE INDEX IF NOT EXISTS idx_analytics_sessions_source ON analytics_sessions(source)`,
  `CREATE INDEX IF NOT EXISTS idx_analytics_sessions_updated ON analytics_sessions(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_analytics_sessions_model ON analytics_sessions(model)`,
  `CREATE INDEX IF NOT EXISTS idx_analytics_items_tool ON analytics_items(tool_name)`,
  `CREATE INDEX IF NOT EXISTS idx_analytics_findings_severity ON analytics_findings(severity)`,
  `ALTER TABLE analytics_sources ADD COLUMN last_warning TEXT`,
  `ALTER TABLE analytics_sessions ADD COLUMN cached_write_tokens INTEGER`,
  `ALTER TABLE analytics_turns ADD COLUMN cached_write_tokens INTEGER`,
  `ALTER TABLE analytics_sessions ADD COLUMN cost_usd REAL`,
  `ALTER TABLE analytics_sessions ADD COLUMN cost_estimated INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE analytics_sessions ADD COLUMN source_path TEXT`,
  `CREATE TABLE IF NOT EXISTS analytics_source_files (
     provider TEXT NOT NULL,
     host_id TEXT NOT NULL,
     path TEXT NOT NULL,
     fingerprint TEXT NOT NULL,
     session_id TEXT,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (provider, host_id, path)
   )`,
  `CREATE TABLE IF NOT EXISTS telemetry_prices (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
];

type Row = Record<string, unknown>;

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sessionFromRow(row: Row): ProviderSessionRecord {
  return {
    id: String(row.id),
    source: row.source === "bb" ? "bb" : "provider",
    provider: String(row.provider) as ProviderSessionRecord["provider"],
    hostId: String(row.host_id ?? "primary"),
    providerSessionId: typeof row.provider_session_id === "string" ? row.provider_session_id : null,
    bbThreadId: typeof row.bb_thread_id === "string" ? row.bb_thread_id : null,
    title: String(row.title ?? "Untitled session"),
    cwd: typeof row.cwd === "string" ? row.cwd : null,
    projectId: typeof row.project_id === "string" ? row.project_id : null,
    model: typeof row.model === "string" ? row.model : null,
    origin: typeof row.origin === "string" ? row.origin : null,
    status: String(row.status ?? "unknown") as ProviderSessionRecord["status"],
    startedAt: nullableNumber(row.started_at),
    updatedAt: nullableNumber(row.updated_at),
    durationMs: nullableNumber(row.duration_ms),
    messageCount: Number(row.message_count ?? 0),
    turnCount: Number(row.turn_count ?? 0),
    toolCalls: Number(row.tool_calls ?? 0),
    toolErrors: Number(row.tool_errors ?? 0),
    inputTokens: nullableNumber(row.input_tokens),
    cachedInputTokens: nullableNumber(row.cached_input_tokens),
    cachedWriteTokens: nullableNumber(row.cached_write_tokens),
    outputTokens: nullableNumber(row.output_tokens),
    reasoningTokens: nullableNumber(row.reasoning_tokens),
    totalTokens: nullableNumber(row.total_tokens),
    contextPeak: nullableNumber(row.context_peak),
    compactionCount: Number(row.compaction_count ?? 0),
    failureCount: Number(row.failure_count ?? 0),
    delegatedCount: Number(row.delegated_count ?? 0),
    archived: Number(row.archived ?? 0) === 1,
    costUsd: nullableNumber(row.cost_usd),
    costEstimated: Number(row.cost_estimated ?? 0) === 1,
    coverage: json<CapabilityReport>(row.coverage_json, emptyCapabilities()),
    storeLabel: String(row.store_label ?? "provider store"),
    sourcePath: typeof row.source_path === "string" ? row.source_path : null,
    fingerprint: typeof row.fingerprint === "string" ? row.fingerprint : null,
    linkState: String(row.link_state ?? "none") as ProviderSessionRecord["linkState"],
    findingCount: Number(row.finding_count ?? 0),
  };
}

function sourceFromRow(row: Row): SourceStatusRecord {
  return {
    id: String(row.id),
    provider: String(row.provider) as SourceStatusRecord["provider"],
    label: String(row.label),
    hostId: String(row.host_id),
    storeKind: row.store_kind === "sqlite" ? "sqlite" : "jsonl",
    pathLabel: String(row.path_label),
    enabled: Number(row.enabled ?? 0) === 1,
    detected: Number(row.detected ?? 0) === 1,
    supported: Number(row.supported ?? 0) === 1,
    count: Number(row.count ?? 0),
    capabilities: json<CapabilityReport>(row.capabilities_json, emptyCapabilities()),
    cursor: typeof row.cursor === "string" ? row.cursor : null,
    lastSuccessAt: nullableNumber(row.last_success_at),
    lastError: typeof row.last_error === "string" ? row.last_error : null,
    lastWarning: typeof row.last_warning === "string" ? row.last_warning : null,
    remoteDatabaseUnsupported: Number(row.remote_database_unsupported ?? 0) === 1,
  };
}

function turnFromRow(row: Row): NormalizedTurn {
  return {
    id: String(row.id),
    startedAt: nullableNumber(row.started_at),
    endedAt: nullableNumber(row.ended_at),
    status: String(row.status ?? "unknown") as NormalizedTurn["status"],
    durationMs: nullableNumber(row.duration_ms),
    steps: Number(row.steps ?? 0),
    toolCalls: Number(row.tool_calls ?? 0),
    toolErrors: Number(row.tool_errors ?? 0),
    inputTokens: nullableNumber(row.input_tokens),
    cachedInputTokens: nullableNumber(row.cached_input_tokens),
    cachedWriteTokens: nullableNumber(row.cached_write_tokens),
    outputTokens: nullableNumber(row.output_tokens),
    reasoningTokens: nullableNumber(row.reasoning_tokens),
    totalTokens: nullableNumber(row.total_tokens),
    contextPeak: nullableNumber(row.context_peak),
    costUsd: null,
    costEstimated: false,
    sourceSequenceStart: nullableNumber(row.source_sequence_start),
    sourceSequenceEnd: nullableNumber(row.source_sequence_end),
  };
}

function itemFromRow(row: Row): NormalizedItem {
  return {
    sessionId: String(row.session_id),
    id: String(row.id),
    turnId: typeof row.turn_id === "string" ? row.turn_id : null,
    kind: String(row.kind),
    toolName: typeof row.tool_name === "string" ? row.tool_name : null,
    status: String(row.status ?? "unknown") as NormalizedItem["status"],
    durationMs: nullableNumber(row.duration_ms),
    errorCategory: typeof row.error_category === "string" ? row.error_category : null,
    approvalStatus: typeof row.approval_status === "string" ? row.approval_status : null,
    sourceSequence: Number(row.source_sequence ?? 0),
    at: nullableNumber(row.at),
  };
}

function evidenceFromRow(row: Row): EvidenceRef {
  return {
    source: row.source === "bb" ? "bb" : "provider",
    sourceRecordId: String(row.session_id),
    sourceSequence: nullableNumber(row.source_sequence),
    eventType: String(row.event_type),
    at: nullableNumber(row.at),
  };
}

export class AnalyticsStore {
  constructor(private readonly db: Database.Database) {}

  migrate(migrate: (db: Database.Database, statements: string[]) => void): void {
    migrate(this.db, MIGRATIONS);
  }

  replaceProviderSession(
    session: ProviderSessionRecord,
    turns: NormalizedTurn[],
    items: NormalizedItem[],
    usage: UsageSnapshot[],
    evidence: EvidenceRef[],
  ): void {
    this.replaceSession(session, turns, items, usage, evidence, []);
  }

  replaceBbSession(
    session: ProviderSessionRecord,
    events: NormalizedBbEvent[],
    turns: NormalizedTurn[],
    items: NormalizedItem[],
    usage: UsageSnapshot[],
    evidence: EvidenceRef[],
  ): void {
    this.replaceSession(session, turns, items, usage, evidence, events);
  }

  updateBbSessionMetadata(session: ProviderSessionRecord): void {
    this.db.prepare(`
      UPDATE analytics_sessions SET
        provider = @provider,
        host_id = @hostId,
        title = @title,
        cwd = @cwd,
        project_id = @projectId,
        model = @model,
        origin = @origin,
        status = @status,
        started_at = @startedAt,
        updated_at = @updatedAt,
        archived = @archived
      WHERE id = @id AND source = 'bb'
    `).run({
      ...session,
      hostId: session.hostId,
      projectId: session.projectId,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      archived: session.archived ? 1 : 0,
    });
  }

  private replaceSession(
    session: ProviderSessionRecord,
    turns: NormalizedTurn[],
    items: NormalizedItem[],
    usage: UsageSnapshot[],
    evidence: EvidenceRef[],
    events: NormalizedBbEvent[],
  ): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM analytics_turns WHERE session_id = ?").run(session.id);
      this.db.prepare("DELETE FROM analytics_items WHERE session_id = ?").run(session.id);
      this.db.prepare("DELETE FROM analytics_usage WHERE session_id = ?").run(session.id);
      this.db.prepare("DELETE FROM analytics_events WHERE session_id = ?").run(session.id);
      this.db.prepare("DELETE FROM analytics_evidence WHERE session_id = ?").run(session.id);
      this.db.prepare(`
        INSERT INTO analytics_sessions (
          id, source, provider, host_id, provider_session_id, bb_thread_id,
          title, cwd, project_id, model, origin, status, started_at, updated_at,
          duration_ms, message_count, turn_count, tool_calls, tool_errors,
          input_tokens, cached_input_tokens, cached_write_tokens, output_tokens,
          reasoning_tokens, total_tokens, context_peak, compaction_count, failure_count,
          delegated_count, archived, cost_usd, cost_estimated, coverage_json, store_label, source_path, fingerprint,
          link_state, finding_count
        ) VALUES (
          @id, @source, @provider, @hostId, @providerSessionId, @bbThreadId,
          @title, @cwd, @projectId, @model, @origin, @status, @startedAt, @updatedAt,
          @durationMs, @messageCount, @turnCount, @toolCalls, @toolErrors,
          @inputTokens, @cachedInputTokens, @cachedWriteTokens, @outputTokens, @reasoningTokens,
          @totalTokens, @contextPeak, @compactionCount, @failureCount,
          @delegatedCount, @archived, @costUsd, @costEstimated, @coverageJson, @storeLabel, @sourcePath, @fingerprint,
          @linkState, @findingCount
        ) ON CONFLICT(id) DO UPDATE SET
          source = excluded.source, provider = excluded.provider, host_id = excluded.host_id,
          provider_session_id = excluded.provider_session_id, bb_thread_id = excluded.bb_thread_id,
          title = excluded.title, cwd = excluded.cwd, project_id = excluded.project_id,
          model = excluded.model, origin = excluded.origin, status = excluded.status,
          started_at = excluded.started_at, updated_at = excluded.updated_at,
          duration_ms = excluded.duration_ms, message_count = excluded.message_count,
          turn_count = excluded.turn_count, tool_calls = excluded.tool_calls,
          tool_errors = excluded.tool_errors, input_tokens = excluded.input_tokens,
          cached_input_tokens = excluded.cached_input_tokens,
          cached_write_tokens = excluded.cached_write_tokens,
          output_tokens = excluded.output_tokens,
          reasoning_tokens = excluded.reasoning_tokens, total_tokens = excluded.total_tokens,
          context_peak = excluded.context_peak, compaction_count = excluded.compaction_count,
          failure_count = excluded.failure_count, delegated_count = excluded.delegated_count,
          archived = excluded.archived, cost_usd = excluded.cost_usd,
          cost_estimated = excluded.cost_estimated, coverage_json = excluded.coverage_json,
          store_label = excluded.store_label, source_path = excluded.source_path,
          fingerprint = excluded.fingerprint,
          link_state = excluded.link_state, finding_count = excluded.finding_count
      `).run({
        id: session.id,
        source: session.source,
        provider: session.provider,
        hostId: session.hostId,
        providerSessionId: session.providerSessionId,
        bbThreadId: session.bbThreadId,
        title: session.title,
        cwd: session.cwd,
        projectId: session.projectId,
        model: session.model,
        origin: session.origin,
        status: session.status,
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
        durationMs: session.durationMs,
        messageCount: session.messageCount,
        turnCount: session.turnCount,
        toolCalls: session.toolCalls,
        toolErrors: session.toolErrors,
        inputTokens: session.inputTokens,
        cachedInputTokens: session.cachedInputTokens,
        cachedWriteTokens: session.cachedWriteTokens,
        outputTokens: session.outputTokens,
        reasoningTokens: session.reasoningTokens,
        totalTokens: session.totalTokens,
        contextPeak: session.contextPeak,
        compactionCount: session.compactionCount,
        failureCount: session.failureCount,
        delegatedCount: session.delegatedCount,
        archived: session.archived ? 1 : 0,
        costUsd: session.costUsd,
        costEstimated: session.costEstimated ? 1 : 0,
        coverageJson: JSON.stringify(session.coverage),
        storeLabel: session.storeLabel,
        sourcePath: session.sourcePath,
        fingerprint: session.fingerprint,
        linkState: session.linkState,
        findingCount: session.findingCount,
      });
      const turnInsert = this.db.prepare(`INSERT INTO analytics_turns (
        id, session_id, started_at, ended_at, status, duration_ms, steps, tool_calls,
        tool_errors, input_tokens, cached_input_tokens, cached_write_tokens, output_tokens, reasoning_tokens,
        total_tokens, context_peak, source_sequence_start, source_sequence_end
      ) VALUES (@id, @sessionId, @startedAt, @endedAt, @status, @durationMs, @steps,
        @toolCalls, @toolErrors, @inputTokens, @cachedInputTokens, @cachedWriteTokens, @outputTokens,
        @reasoningTokens, @totalTokens, @contextPeak, @sourceSequenceStart, @sourceSequenceEnd)`);
      for (const turn of turns) turnInsert.run({ ...turn, sessionId: session.id });
      const itemInsert = this.db.prepare(`INSERT INTO analytics_items (
        id, session_id, turn_id, kind, tool_name, status, duration_ms, error_category,
        approval_status, source_sequence, at
      ) VALUES (@id, @sessionId, @turnId, @kind, @toolName, @status, @durationMs,
        @errorCategory, @approvalStatus, @sourceSequence, @at)`);
      for (const item of items) itemInsert.run({ ...item, sessionId: session.id });
      const usageInsert = this.db.prepare(`INSERT INTO analytics_usage (
        session_id, turn_id, source_sequence, input_tokens, cached_input_tokens,
        output_tokens, reasoning_tokens, total_tokens, context_used, context_limit,
        estimated, at
      ) VALUES (@sessionId, @turnId, @sourceSequence, @inputTokens, @cachedInputTokens,
        @outputTokens, @reasoningTokens, @totalTokens, @contextUsed, @contextLimit,
        @estimated, @at)`);
      for (const row of usage) usageInsert.run({ ...row, sessionId: session.id, estimated: row.estimated ? 1 : 0 });
      const eventInsert = this.db.prepare(`INSERT INTO analytics_events (
        session_id, source_sequence, event_type, turn_id, at, classification, status,
        duration_ms, tool_name, error_category, approval_status, input_tokens,
        cached_input_tokens, output_tokens, reasoning_tokens, total_tokens,
        context_used, context_limit, estimated, provider_session_id
      ) VALUES (@sessionId, @sourceSequence, @eventType, @turnId, @at, @classification,
        @status, @durationMs, @toolName, @errorCategory, @approvalStatus, @inputTokens,
        @cachedInputTokens, @outputTokens, @reasoningTokens, @totalTokens,
        @contextUsed, @contextLimit, @estimated, @providerSessionId)`);
      for (const event of events) eventInsert.run({ ...event, sessionId: session.id, estimated: event.estimated ? 1 : 0 });
      const evidenceInsert = this.db.prepare(`INSERT OR REPLACE INTO analytics_evidence (
        session_id, source_sequence, event_type, source, at
      ) VALUES (@sessionId, @sourceSequence, @eventType, @source, @at)`);
      for (const row of evidence) evidenceInsert.run({ ...row, sessionId: session.id });
    });
    transaction();
  }

  /**
   * Wipe every indexed session, source status, link, and finding so a full
   * rescan starts from a clean slate. The models.dev price cache is kept.
   */
  clearAll(): void {
    const transaction = this.db.transaction(() => {
      for (const table of ["analytics_turns", "analytics_items", "analytics_usage", "analytics_events", "analytics_evidence"]) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
      this.db.prepare("DELETE FROM analytics_session_links").run();
      this.db.prepare("DELETE FROM analytics_findings").run();
      this.db.prepare("DELETE FROM analytics_sessions").run();
      this.db.prepare("DELETE FROM analytics_sources").run();
      this.db.prepare("DELETE FROM analytics_source_files").run();
    });
    transaction();
  }

  upsertSource(source: SourceStatusRecord, now = Date.now()): void {
    this.db.prepare(`INSERT INTO analytics_sources (
      id, provider, label, host_id, store_kind, path_label, enabled, detected,
      supported, count, capabilities_json, cursor, last_success_at, last_error,
      last_warning, remote_database_unsupported, updated_at
    ) VALUES (@id, @provider, @label, @hostId, @storeKind, @pathLabel, @enabled,
      @detected, @supported, @count, @capabilitiesJson, @cursor, @lastSuccessAt,
      @lastError, @lastWarning, @remoteDatabaseUnsupported, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, label=excluded.label,
      host_id=excluded.host_id, store_kind=excluded.store_kind, path_label=excluded.path_label,
      enabled=excluded.enabled, detected=excluded.detected, supported=excluded.supported,
      count=excluded.count, capabilities_json=excluded.capabilities_json, cursor=excluded.cursor,
      last_success_at=excluded.last_success_at, last_error=excluded.last_error,
      last_warning=excluded.last_warning,
      remote_database_unsupported=excluded.remote_database_unsupported, updated_at=excluded.updated_at`).run({
      ...source,
      enabled: source.enabled ? 1 : 0,
      detected: source.detected ? 1 : 0,
      supported: source.supported ? 1 : 0,
      capabilitiesJson: JSON.stringify(source.capabilities),
      remoteDatabaseUnsupported: source.remoteDatabaseUnsupported ? 1 : 0,
      updatedAt: now,
    });
  }

  private deleteSession(id: string): void {
    for (const table of ["analytics_turns", "analytics_items", "analytics_usage", "analytics_events", "analytics_evidence"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(id);
    }
    this.db.prepare("DELETE FROM analytics_session_links WHERE provider_record_id = ?").run(id);
    this.db.prepare("DELETE FROM analytics_sessions WHERE id = ?").run(id);
  }

  pruneProvider(provider: ProviderSessionRecord["provider"], hostId: string, seen: Set<string>, preserveStoreLabels = new Set<string>()): number {
    const rows = this.db.prepare("SELECT id, store_label FROM analytics_sessions WHERE source = 'provider' AND provider = ? AND host_id = ?").all(provider, hostId) as Row[];
    let removed = 0;
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        const id = String(row.id);
        if (seen.has(id)) continue;
        if (typeof row.store_label === "string" && preserveStoreLabels.has(row.store_label)) continue;
        this.deleteSession(id);
        removed += 1;
      }
    });
    transaction();
    return removed;
  }

  pruneCodexBarSessions(): number {
    const rows = this.db.prepare(`
      SELECT id FROM analytics_sessions
      WHERE source = 'provider'
        AND (
          lower(COALESCE(cwd, '')) LIKE '%codexbar%'
          OR lower(COALESCE(store_label, '')) LIKE '%codexbar%'
        )
    `).all() as Row[];
    let removed = 0;
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        this.deleteSession(String(row.id));
        removed += 1;
      }
    });
    transaction();
    return removed;
  }

  getSessions(): ProviderSessionRecord[] {
    return (this.db.prepare("SELECT * FROM analytics_sessions ORDER BY COALESCE(updated_at, 0) DESC").all() as Row[]).map(sessionFromRow);
  }

  getSession(id: string): ProviderSessionRecord | null {
    const row = this.db.prepare("SELECT * FROM analytics_sessions WHERE id = ?").get(id) as Row | undefined;
    return row ? sessionFromRow(row) : null;
  }

  /**
   * Find a provider-store session with the same content fingerprint under a
   * different provider. Pi and Prime Agent share `~/.prime/agent/sessions`,
   * so identical files must not be indexed twice (once per provider); the
   * first scan to claim a file keeps it.
   */
  getSessionByFingerprint(fingerprint: string, excludeProvider: string): ProviderSessionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM analytics_sessions WHERE source = 'provider' AND fingerprint = ? AND provider != ? LIMIT 1")
      .get(fingerprint, excludeProvider) as Row | undefined;
    return row ? sessionFromRow(row) : null;
  }

  /**
   * Per-file fingerprints for incremental scans. Keyed by file path (not
   * session) because one Codex session can span many rollout files that all
   * share the same session id — a session row alone can only remember one.
   */
  getSourceFileFingerprints(provider: string, hostId: string): Map<string, { fingerprint: string; sessionId: string | null }> {
    const rows = this.db
      .prepare("SELECT path, fingerprint, session_id FROM analytics_source_files WHERE provider = ? AND host_id = ?")
      .all(provider, hostId) as Row[];
    const map = new Map<string, { fingerprint: string; sessionId: string | null }>();
    for (const row of rows) {
      if (typeof row.path !== "string" || typeof row.fingerprint !== "string") continue;
      map.set(row.path, {
        fingerprint: row.fingerprint,
        sessionId: typeof row.session_id === "string" ? row.session_id : null,
      });
    }
    return map;
  }

  upsertSourceFile(provider: string, hostId: string, path: string, fingerprint: string, sessionId: string | null, now = Date.now()): void {
    this.db
      .prepare(`INSERT INTO analytics_source_files (provider, host_id, path, fingerprint, session_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, host_id, path) DO UPDATE SET
          fingerprint = excluded.fingerprint, session_id = excluded.session_id, updated_at = excluded.updated_at`)
      .run(provider, hostId, path, fingerprint, sessionId, now);
  }

  /** Forget fingerprint rows for paths that are no longer listed on disk. */
  pruneSourceFiles(provider: string, hostId: string, keepPaths: Set<string>): number {
    const rows = this.db
      .prepare("SELECT path FROM analytics_source_files WHERE provider = ? AND host_id = ?")
      .all(provider, hostId) as Row[];
    let removed = 0;
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        const path = String(row.path);
        if (keepPaths.has(path)) continue;
        this.db.prepare("DELETE FROM analytics_source_files WHERE provider = ? AND host_id = ? AND path = ?").run(provider, hostId, path);
        removed += 1;
      }
    });
    transaction();
    return removed;
  }

  countProviderSessions(provider: string, hostId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM analytics_sessions WHERE source = 'provider' AND provider = ? AND host_id = ?")
      .get(provider, hostId) as Row | undefined;
    return Number(row?.c ?? 0);
  }

  updateSourceCount(provider: string, hostId: string, count: number, now = Date.now()): void {
    this.db
      .prepare("UPDATE analytics_sources SET count = ?, updated_at = ? WHERE provider = ? AND host_id = ?")
      .run(count, now, provider, hostId);
  }

  getTurns(sessionId: string): NormalizedTurn[] {
    return (this.db.prepare("SELECT * FROM analytics_turns WHERE session_id = ? ORDER BY COALESCE(started_at, 0)").all(sessionId) as Row[]).map(turnFromRow);
  }

  getItems(sessionId: string): NormalizedItem[] {
    return (this.db.prepare("SELECT * FROM analytics_items WHERE session_id = ? ORDER BY source_sequence").all(sessionId) as Row[]).map(itemFromRow);
  }

  getEvidence(sessionId: string): EvidenceRef[] {
    return (this.db.prepare("SELECT * FROM analytics_evidence WHERE session_id = ? ORDER BY COALESCE(source_sequence, 0)").all(sessionId) as Row[]).map(evidenceFromRow);
  }

  getSources(): SourceStatusRecord[] {
    return (this.db.prepare("SELECT * FROM analytics_sources ORDER BY provider, host_id").all() as Row[]).map(sourceFromRow);
  }

  getSource(provider: string, hostId: string): SourceStatusRecord | null {
    const row = this.db.prepare("SELECT * FROM analytics_sources WHERE provider = ? AND host_id = ?").get(provider, hostId) as Row | undefined;
    return row ? sourceFromRow(row) : null;
  }

  getItemsForSessions(ids: Set<string>): NormalizedItem[] {
    if (!ids.size) return [];
    const placeholders = [...ids].map(() => "?").join(",");
    return (this.db.prepare(`SELECT * FROM analytics_items WHERE session_id IN (${placeholders})`).all(...ids) as Row[]).map(itemFromRow);
  }

  replaceLinks(links: LinkRecord[]): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM analytics_session_links").run();
      this.db.prepare("UPDATE analytics_sessions SET link_state = 'none', bb_thread_id = CASE WHEN source = 'bb' THEN bb_thread_id ELSE NULL END").run();
      const insert = this.db.prepare(`INSERT INTO analytics_session_links (
        provider_record_id, bb_thread_id, strategy, confidence, policy, evidence_json, matched_at
      ) VALUES (@providerRecordId, @bbThreadId, @strategy, @confidence, @policy, @evidenceJson, @matchedAt)`);
      const update = this.db.prepare("UPDATE analytics_sessions SET link_state = ?, bb_thread_id = ? WHERE id = ?");
      const updateBb = this.db.prepare("UPDATE analytics_sessions SET link_state = ? WHERE id = ?");
      for (const link of links) {
        insert.run({
          providerRecordId: link.providerSessionId,
          bbThreadId: link.bbThreadId,
          strategy: link.strategy,
          confidence: link.confidence,
          policy: link.policy,
          evidenceJson: JSON.stringify(link.evidence),
          matchedAt: link.matchedAt,
        });
        update.run(link.policy === "accepted" ? "linked" : "suggested", link.bbThreadId, link.providerSessionId);
        updateBb.run(link.policy === "accepted" ? "linked" : "suggested", `bb:${link.bbThreadId}`);
      }
    });
    transaction();
  }

  getLinksForSession(sessionId: string): LinkRecord[] {
    const rows = this.db.prepare("SELECT * FROM analytics_session_links WHERE provider_record_id = ? OR bb_thread_id = ?").all(sessionId, sessionId.replace(/^bb:/, "")) as Row[];
    return rows.map((row) => ({
      providerSessionId: String(row.provider_record_id),
      bbThreadId: String(row.bb_thread_id),
      strategy: String(row.strategy) as LinkRecord["strategy"],
      confidence: Number(row.confidence),
      policy: String(row.policy) as LinkRecord["policy"],
      evidence: json(row.evidence_json, []),
      matchedAt: Number(row.matched_at),
    }));
  }

  replaceFindings(findings: FindingRecord[]): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM analytics_findings").run();
      this.db.prepare("UPDATE analytics_sessions SET finding_count = 0").run();
      const insert = this.db.prepare(`INSERT INTO analytics_findings (
        id, rule_id, severity, source, provider, scope, scope_id, title, summary,
        recommendation, metric_value, threshold, sample_size, coverage_note,
        evidence_json, created_at
      ) VALUES (@id, @ruleId, @severity, @source, @provider, @scope, @scopeId, @title,
        @summary, @recommendation, @metricValue, @threshold, @sampleSize, @coverageNote,
        @evidenceJson, @createdAt)`);
      for (const finding of findings) {
        insert.run({ ...finding, ruleId: finding.ruleId, scopeId: finding.scopeId, metricValue: finding.metricValue, evidenceJson: JSON.stringify(finding.evidence), createdAt: finding.createdAt });
        if (finding.scope === "session" && finding.scopeId) {
          this.db.prepare("UPDATE analytics_sessions SET finding_count = finding_count + 1 WHERE id = ?").run(finding.scopeId);
        }
      }
    });
    transaction();
  }

  getFindings(): FindingRecord[] {
    return (this.db.prepare("SELECT * FROM analytics_findings ORDER BY CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END DESC, created_at DESC").all() as Row[]).map((row) => ({
      id: String(row.id),
      ruleId: String(row.rule_id),
      severity: String(row.severity) as FindingRecord["severity"],
      source: row.source === "bb" ? "bb" : "provider",
      provider: String(row.provider) as FindingRecord["provider"],
      scope: String(row.scope) as FindingRecord["scope"],
      scopeId: typeof row.scope_id === "string" ? row.scope_id : null,
      title: String(row.title),
      summary: String(row.summary),
      recommendation: String(row.recommendation),
      metricValue: nullableNumber(row.metric_value),
      threshold: nullableNumber(row.threshold),
      sampleSize: Number(row.sample_size ?? 0),
      coverageNote: String(row.coverage_note),
      evidence: json(row.evidence_json, []),
      createdAt: Number(row.created_at),
    }));
  }

  getSessionDetail(id: string): SessionDetailResult | null {
    const session = this.getSession(id);
    if (!session) return null;
    const source = this.getSources().find((candidate) => candidate.provider === session.provider && candidate.hostId === session.hostId) ?? null;
    const findings = this.getFindings().filter((finding) => finding.scopeId === id || (finding.scope === "provider" && finding.provider === session.provider));
    return {
      session,
      source,
      turns: this.getTurns(id),
      items: this.getItems(id),
      findings,
      links: this.getLinksForSession(id),
      evidence: this.getEvidence(id),
      cost: null,
      costCoverage: "unavailable",
    };
  }

  latestEventSequence(sessionId: string): number {
    const row = this.db.prepare("SELECT MAX(source_sequence) AS maxSeq FROM analytics_events WHERE session_id = ?").get(sessionId) as Row | undefined;
    return Number(row?.maxSeq ?? 0);
  }

  getPriceCache<T>(key: string): { value: T; updatedAt: number } | null {
    const row = this.db.prepare("SELECT value, updated_at FROM telemetry_prices WHERE key = ?").get(key) as Row | undefined;
    if (!row) return null;
    const value = json<T>(row.value, null as T);
    if (value === null || typeof value !== "object") return null;
    return { value, updatedAt: Number(row.updated_at) };
  }

  setPriceCache(key: string, value: unknown, now = Date.now()): void {
    this.db.prepare(`INSERT INTO telemetry_prices (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(key, JSON.stringify(value), now);
  }

  pruneRetention(days: number, now = Date.now()): number {
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const rows = this.db.prepare("SELECT id FROM analytics_sessions WHERE COALESCE(updated_at, started_at, 0) < ?").all(cutoff) as Row[];
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        const id = String(row.id);
        for (const table of ["analytics_turns", "analytics_items", "analytics_usage", "analytics_events", "analytics_evidence"]) {
          this.db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(id);
        }
        this.db.prepare("DELETE FROM analytics_session_links WHERE provider_record_id = ? OR bb_thread_id = ?").run(id, id.replace(/^bb:/, ""));
        this.db.prepare("DELETE FROM analytics_sessions WHERE id = ?").run(id);
      }
    });
    transaction();
    return rows.length;
  }

  dispose(): void {
    // The host owns the database handle and closes it during plugin disposal.
  }
}

export { sessionFromRow, sourceFromRow };
