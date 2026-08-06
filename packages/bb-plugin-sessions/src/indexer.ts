// Session index: auto-discovering provider stores, parsing, persistence, search.

import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import type Database from "better-sqlite3";
import {
  isCoveredBySource,
  isKnownProviderId,
  getSource,
  probeSources,
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
  parseClaudeFile,
  parseCodexFile,
  parseOmpJsonlFile,
  parsePrimeJsonlFile,
  readHermesMessages,
  readHermesSessions,
  readOpenCodeMessages,
  readOpenCodeSessions,
  hermesSessionToMeta,
  openCodeSessionToMeta,
  resolveHome,
  type HermesSessionRow,
  type OpenCodeSessionRow,
} from "./parsers";
import type { IndexSettings, SessionMeta } from "./types";

export interface IndexProgress {
  phase: "scanning" | "indexing" | "pruning" | "done" | "error";
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
  title: string;
  cwd: string | null;
  gitRepoRoot: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  model: string | null;
  origin: string | null;
  messageCount: number;
  summary: string | null;
  firstUserMessage: string | null;
  transcript: string;
  truncated: number;
  sizeBytes: number | null;
  mtimeMs: number | null;
  indexedAt: number | null;
}

export function migrateDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      file_path TEXT,
      title TEXT,
      cwd TEXT,
      git_repo_root TEXT,
      started_at INTEGER,
      updated_at INTEGER,
      model TEXT,
      origin TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      first_user_message TEXT,
      transcript TEXT NOT NULL DEFAULT '',
      truncated INTEGER NOT NULL DEFAULT 0,
      size_bytes INTEGER,
      mtime_ms INTEGER,
      indexed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      provider, title, cwd, body,
      tokenize = 'porter unicode61'
    );
  `);
}

function mapRow(r: Record<string, unknown>): SessionRow {
  return {
    id: r.id as string,
    provider: r.provider as ProviderId,
    providerSessionId: r.provider_session_id as string,
    filePath: (r.file_path as string | null) ?? null,
    title: (r.title as string) ?? "",
    cwd: (r.cwd as string | null) ?? null,
    gitRepoRoot: (r.git_repo_root as string | null) ?? null,
    startedAt: (r.started_at as number | null) ?? null,
    updatedAt: (r.updated_at as number | null) ?? null,
    model: (r.model as string | null) ?? null,
    origin: (r.origin as string | null) ?? null,
    messageCount: (r.message_count as number) ?? 0,
    summary: (r.summary as string | null) ?? null,
    firstUserMessage: (r.first_user_message as string | null) ?? null,
    transcript: (r.transcript as string) ?? "",
    truncated: (r.truncated as number) ?? 0,
    sizeBytes: (r.size_bytes as number | null) ?? null,
    mtimeMs: (r.mtime_ms as number | null) ?? null,
    indexedAt: (r.indexed_at as number | null) ?? null,
  };
}

const upsertSql = `
  INSERT INTO sessions (
    id, provider, provider_session_id, file_path, title, cwd, git_repo_root,
    started_at, updated_at, model, origin, message_count, summary,
    first_user_message, transcript, truncated, size_bytes, mtime_ms, indexed_at
  ) VALUES (
    @id, @provider, @providerSessionId, @filePath, @title, @cwd, @gitRepoRoot,
    @startedAt, @updatedAt, @model, @origin, @messageCount, @summary,
    @firstUserMessage, @transcript, @truncated, @sizeBytes, @mtimeMs, @indexedAt
  )
  ON CONFLICT(id) DO UPDATE SET
    provider = excluded.provider,
    provider_session_id = excluded.provider_session_id,
    file_path = excluded.file_path,
    title = excluded.title,
    cwd = excluded.cwd,
    git_repo_root = excluded.git_repo_root,
    started_at = excluded.started_at,
    updated_at = excluded.updated_at,
    model = excluded.model,
    origin = excluded.origin,
    message_count = excluded.message_count,
    summary = excluded.summary,
    first_user_message = excluded.first_user_message,
    transcript = excluded.transcript,
    truncated = excluded.truncated,
    size_bytes = excluded.size_bytes,
    mtime_ms = excluded.mtime_ms,
    indexed_at = excluded.indexed_at
`;

export function upsertSession(db: Database.Database, s: SessionMeta): void {
  const params = {
    id: s.id,
    provider: s.provider,
    providerSessionId: s.providerSessionId,
    filePath: s.filePath,
    title: s.title,
    cwd: s.cwd,
    gitRepoRoot: s.gitRepoRoot,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    model: s.model,
    origin: s.origin,
    messageCount: s.messageCount,
    summary: s.summary,
    firstUserMessage: s.firstUserMessage,
    transcript: s.transcript,
    truncated: s.truncated ? 1 : 0,
    sizeBytes: s.sizeBytes,
    mtimeMs: s.mtimeMs,
    indexedAt: Date.now(),
  };
  const run = db.transaction(() => {
    db.prepare(upsertSql).run(params as never);
    const row = db.prepare("SELECT rowid FROM sessions WHERE id = ?").get(s.id) as
      | { rowid: number }
      | undefined;
    if (row) {
      db.prepare("DELETE FROM sessions_fts WHERE rowid = ?").run(row.rowid);
      db.prepare(
        "INSERT INTO sessions_fts (rowid, provider, title, cwd, body) VALUES (?, ?, ?, ?, ?)",
      ).run(
        row.rowid,
        s.provider,
        s.title ?? "",
        s.cwd ?? "",
        `${s.firstUserMessage ?? ""}\n${s.transcript}`,
      );
    }
  });
  run();
}

export function deleteSession(db: Database.Database, id: string): void {
  const run = db.transaction(() => {
    const row = db.prepare("SELECT rowid FROM sessions WHERE id = ?").get(id) as
      | { rowid: number }
      | undefined;
    if (row) db.prepare("DELETE FROM sessions_fts WHERE rowid = ?").run(row.rowid);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  });
  run();
}

// ---------------------------------------------------------------------------
// Scanning helpers
// ---------------------------------------------------------------------------

interface WalkedFile {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

function walkJsonl(root: string): WalkedFile[] {
  const out: WalkedFile[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile() && extname(e.name) === ".jsonl") {
        try {
          const st = statSync(p);
          out.push({ path: p, mtimeMs: st.mtimeMs, sizeBytes: st.size });
        } catch {
          // skip unreadable files
        }
      }
    }
  }
  return out;
}

function pruneBySeen(
  db: Database.Database,
  provider: ProviderId,
  seenPaths: Set<string>,
  seenDbIds?: Set<string>,
): number {
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
    if (!seenPaths.has(fp)) {
      deleteSession(db, r.id);
      removed++;
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Indexer
// ---------------------------------------------------------------------------

export interface IndexResult {
  indexed: number;
  removed: number;
  skipped: number;
  byProvider: Partial<Record<ProviderId, { indexed: number; removed: number; skipped: number }>>;
}

export interface Indexer {
  ensureIndexed(opts?: {
    force?: boolean;
    providers?: ProviderId[];
  }): Promise<IndexResult>;
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
  ): { rows: SessionRow[]; total: number };
  get(id: string): SessionRow | undefined;
  dispose(): void;
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
  }>;
  totalSessions: number;
  indexing: { active: boolean; phase: string; provider: string | null; done: number; total: number };
  lastIndexAt: number | null;
  error: string | null;
}

const KV_LAST_INDEX = "lastIndexAt";

export function createIndexer(deps: IndexerDeps): Indexer {
  let running: Promise<IndexResult> | null = null;
  let active = false;
  let phase = "idle";
  let activeProvider: ProviderId | null = null;
  let doneCount = 0;
  let totalCount = 0;
  let lastError: string | null = null;
  let disposed = false;

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
    }
    if (p.message) deps.log(p.message);
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

  async function ensureIndexed(opts: {
    force?: boolean;
    providers?: ProviderId[];
  } = {}): Promise<IndexResult> {
    if (running) return running;
    if (disposed) return { indexed: 0, removed: 0, skipped: 0, byProvider: {} };
    running = (async () => {
      const settings = await deps.getSettings();
      const explicit = opts.providers?.filter(isKnownProviderId) ?? [];
      // Default: discover which sources are actually present and enabled.
      const want =
        explicit.length > 0
          ? explicit.map((id) => getSource(id)!).filter(Boolean)
          : PROVIDER_SOURCES.filter(
              (s) => sourceEnabled(settings, s.id),
            );
      let indexed = 0;
      let removed = 0;
      let skipped = 0;
      const byProvider: IndexResult["byProvider"] = {};

      const doSource = async (source: ProviderSource) => {
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

        if (source.kind === "codex" || source.kind === "claude" || source.kind === "omp") {
          const root = resolveHome(settings[`${provider}Path`]);
          progress({
            phase: "scanning",
            provider,
            message: `Scanning ${PROVIDER_LABELS[provider]} at ${root}`,
          });
          const files = walkJsonl(root);
          totalCount = files.length;
          doneCount = 0;
          const parse =
            source.kind === "codex"
              ? parseCodexFile
              : source.kind === "claude"
                ? parseClaudeFile
                : parseOmpJsonlFile;
          for (let i = 0; i < files.length; i++) {
            if (disposed) return;
            const f = files[i];
            seenPaths.add(f.path);
            const existing = dbGetByFilePath(deps.db, provider, f.path);
            if (
              !opts.force &&
              existing &&
              existing.mtimeMs === f.mtimeMs &&
              existing.sizeBytes === f.sizeBytes
            ) {
              bump("skipped", 1);
            } else {
              const parsed = parse(f.path, f.mtimeMs, f.sizeBytes);
              if (parsed) {
                upsertSession(deps.db, parsed);
                bump("indexed", 1);
              } else {
                // file no longer parses to a session; drop any stale row
                if (existing) {
                  deleteSession(deps.db, existing.id);
                  bump("removed", 1);
                }
              }
            }
            if (i % 40 === 0 || i === files.length - 1) {
              progress({ phase: "indexing", provider, done: i + 1, total: files.length });
            }
          }
          progress({ phase: "pruning", provider });
          bump("removed", pruneBySeen(deps.db, provider, seenPaths));
        } else if (source.kind === "prime") {
          // jsonl dir + hermes db
          const jsonlRoot = resolveHome(settings.primePath);
          progress({
            phase: "scanning",
            provider,
            message: `Scanning ${PROVIDER_LABELS[provider]} (${jsonlRoot} + hermes db)`,
          });
          const files = walkJsonl(jsonlRoot);
          totalCount = files.length + 1;
          doneCount = 0;
          for (let i = 0; i < files.length; i++) {
            if (disposed) return;
            const f = files[i];
            seenPaths.add(f.path);
            const existing = dbGetByFilePath(deps.db, "prime", f.path);
            if (
              !opts.force &&
              existing &&
              existing.mtimeMs === f.mtimeMs &&
              existing.sizeBytes === f.sizeBytes
            ) {
              bump("skipped", 1);
            } else {
              const parsed = parsePrimeJsonlFile(f.path, f.mtimeMs, f.sizeBytes);
              if (parsed) {
                upsertSession(deps.db, parsed);
                bump("indexed", 1);
              } else if (existing) {
                deleteSession(deps.db, existing.id);
                bump("removed", 1);
              }
            }
            if (i % 40 === 0 || i === files.length - 1) {
              progress({ phase: "indexing", provider, done: i + 1, total: totalCount });
            }
          }
          // hermes db
          progress({ phase: "indexing", provider, done: files.length + 1, total: totalCount });
          const dbPath = settings.primeDbPath;
          const seenDbIds = new Set<string>();
          if (dbPath.trim()) {
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
                  if (disposed) return;
                  seenDbIds.add(row.id);
                  const key = `prime:${row.id}`;
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
                  const messages = readHermesMessages(hdb, row.id);
                  const meta = hermesSessionToMeta(row, messages);
                  if (meta) {
                    upsertSession(deps.db, meta);
                    bump("indexed", 1);
                  } else if (existing) {
                    deleteSession(deps.db, key);
                    bump("removed", 1);
                  }
                }
              } finally {
                hdb.close();
              }
            }
          }
          progress({ phase: "pruning", provider });
          bump("removed", pruneBySeen(deps.db, "prime", seenPaths, seenDbIds));
        } else {
          // opencode — single SQLite store
          const dbPath = settings.opencodePath;
          progress({
            phase: "scanning",
            provider,
            message: `Scanning ${PROVIDER_LABELS[provider]} (${dbPath})`,
          });
          const seenDbIds = new Set<string>();
          const odb = openOpenCodeDb(dbPath);
          if (odb) {
            try {
              const rows: OpenCodeSessionRow[] = readOpenCodeSessions(odb);
              totalCount = rows.length;
              doneCount = 0;
              for (let i = 0; i < rows.length; i++) {
                if (disposed) return;
                const row = rows[i];
                seenDbIds.add(row.id);
                const key = `opencode:${row.id}`;
                const existing = deps.db
                  .prepare("SELECT updated_at, message_count FROM sessions WHERE id = ?")
                  .get(key) as { updated_at: number | null; message_count: number } | undefined;
                const updated = row.timeUpdated ?? row.timeCreated;
                if (!opts.force && existing && existing.updated_at === updated) {
                  // Unchanged session (time_updated bumps on new messages).
                  bump("skipped", 1);
                  continue;
                }
                const messages = readOpenCodeMessages(odb, row.id);
                const meta = openCodeSessionToMeta(row, messages);
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
            } finally {
              odb.close();
            }
          }
          progress({ phase: "pruning", provider });
          bump("removed", pruneBySeen(deps.db, "opencode", seenPaths, seenDbIds));
        }
        byProvider[provider] = pStats;
      };

      try {
        for (const source of want) {
          await doSource(source);
        }
        const total = countSessions(deps.db);
        await deps.kv.set(KV_LAST_INDEX, Date.now());
        progress({
          phase: "done",
          totalSessions: total,
          message: `Index complete: ${indexed} new/updated, ${removed} pruned, ${skipped} unchanged, ${total} total`,
        });
        return { indexed, removed, skipped, byProvider };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        progress({ phase: "error", message: `Index failed: ${lastError}` });
        throw err;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  function dbGetByFilePath(
    db: Database.Database,
    provider: ProviderId,
    filePath: string,
  ): SessionRow | undefined {
    const row = db
      .prepare("SELECT * FROM sessions WHERE provider = ? AND file_path = ?")
      .get(provider, filePath) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : undefined;
  }

  function countSessions(db: Database.Database): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c;
  }

  function status(
    settings: IndexSettings,
    lastIndexAt: number | null,
    bbProviderIds: ReadonlySet<string> = new Set(),
  ): StatusSnapshot {
    const rows = deps.db
      .prepare(
        "SELECT provider, COUNT(*) AS c, MAX(indexed_at) AS last FROM sessions GROUP BY provider",
      )
      .all() as Array<{ provider: string; c: number; last: number | null }>;
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    const probes: SourceProbe[] = probeSources(settings, bbProviderIds);
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
          lastIndexedAt: r?.last ?? null,
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

  /** Shared search implementation: filtered rows + total match count. */
  function searchWithTotal(
    query: string,
    providers?: ProviderId[],
    limit = 50,
  ): { rows: SessionRow[]; total: number } {
    const provFilter =
      providers && providers.length > 0
        ? providers.filter(isKnownProviderId)
        : [...PROVIDER_IDS];
    if (provFilter.length === 0) return { rows: [], total: 0 };
    const placeholders = provFilter.map(() => "?").join(",");
    const q = query.trim();
    if (!q) {
      const sql = `SELECT * FROM sessions WHERE provider IN (${placeholders})
                   ORDER BY updated_at DESC LIMIT ?`;
      const rows = deps.db
        .prepare(sql)
        .all(...provFilter, limit) as Record<string, unknown>[];
      const total = countFor(
        `SELECT COUNT(*) AS c FROM sessions WHERE provider IN (${placeholders})`,
        provFilter,
      );
      return { rows: rows.map(mapRow), total };
    }
    // FTS5 match with quoted terms; fall back to LIKE on parse failure.
    const terms = q.split(/\s+/).filter(Boolean).slice(0, 8);
    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" ");
    try {
      const sql = `SELECT s.* FROM sessions_fts f
                   JOIN sessions s ON s.rowid = f.rowid
                   WHERE sessions_fts MATCH ? AND s.provider IN (${placeholders})
                   ORDER BY bm25(sessions_fts), s.updated_at DESC
                   LIMIT ?`;
      const rows = deps.db
        .prepare(sql)
        .all(ftsQuery, ...provFilter, limit) as Record<string, unknown>[];
      const total = countFor(
        `SELECT COUNT(*) AS c FROM sessions_fts f
         JOIN sessions s ON s.rowid = f.rowid
         WHERE sessions_fts MATCH ? AND s.provider IN (${placeholders})`,
        [ftsQuery, ...provFilter],
      );
      return { rows: rows.map(mapRow), total };
    } catch {
      const like = `%${q}%`;
      const sql = `SELECT * FROM sessions
                   WHERE provider IN (${placeholders})
                     AND (title LIKE ? OR first_user_message LIKE ? OR transcript LIKE ? OR cwd LIKE ?)
                   ORDER BY updated_at DESC LIMIT ?`;
      const rows = deps.db
        .prepare(sql)
        .all(...provFilter, like, like, like, like, limit) as Record<string, unknown>[];
      const total = countFor(
        `SELECT COUNT(*) AS c FROM sessions
         WHERE provider IN (${placeholders})
           AND (title LIKE ? OR first_user_message LIKE ? OR transcript LIKE ? OR cwd LIKE ?)`,
        [...provFilter, like, like, like, like],
      );
      return { rows: rows.map(mapRow), total };
    }
  }

  function search(
    query: string,
    providers?: ProviderId[],
    limit = 50,
  ): SessionRow[] {
    return searchWithTotal(query, providers, limit).rows;
  }

  function get(id: string): SessionRow | undefined {
    const row = deps.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
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
    },
  };
}
