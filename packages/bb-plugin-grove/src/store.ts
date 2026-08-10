import type Database from "better-sqlite3";
import { z } from "zod";
import type { BindingRecord, BindingStatus, DocumentSource } from "./types";

export const migrations = [
  `CREATE TABLE IF NOT EXISTS grove_bindings (
     id TEXT PRIMARY KEY,
     path TEXT NOT NULL,
     source_kind TEXT NOT NULL,
     thread_id TEXT,
     environment_id TEXT,
     project_id TEXT,
     host_id TEXT,
     title TEXT NOT NULL,
     owner_thread_id TEXT NOT NULL,
     status TEXT NOT NULL,
     last_sha256 TEXT,
     last_error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE(path, source_kind, environment_id, host_id)
   )`,
  `CREATE TABLE IF NOT EXISTS grove_dictation_queue (
     id TEXT PRIMARY KEY,
     binding_id TEXT NOT NULL,
     transcript TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     sent_at INTEGER,
     error TEXT,
     FOREIGN KEY (binding_id) REFERENCES grove_bindings(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_grove_bindings_owner
     ON grove_bindings(owner_thread_id)`,
  `CREATE INDEX IF NOT EXISTS idx_grove_dictation_binding
     ON grove_dictation_queue(binding_id, created_at DESC)`,
  `UPDATE grove_bindings
     SET host_id = NULL
     WHERE source_kind = 'workspace';
     UPDATE grove_bindings
     SET environment_id = NULL, host_id = NULL
     WHERE source_kind = 'thread-storage';
     CREATE TEMP TABLE grove_binding_rekey (
     old_id TEXT PRIMARY KEY,
     winner_id TEXT NOT NULL
   );
   INSERT INTO grove_binding_rekey (old_id, winner_id)
   SELECT losing.id, winning.id
   FROM grove_bindings AS losing
   JOIN grove_bindings AS winning
     ON (
       (
         losing.source_kind = 'workspace'
         AND winning.source_kind = 'workspace'
         AND losing.path = winning.path
         AND losing.environment_id IS winning.environment_id
       )
       OR (
         losing.source_kind = 'host'
         AND winning.source_kind = 'host'
         AND losing.path = winning.path
         AND losing.host_id IS winning.host_id
       )
       OR (
         losing.source_kind = 'thread-storage'
         AND winning.source_kind = 'thread-storage'
         AND losing.path = winning.path
         AND losing.thread_id IS NOT NULL
         AND losing.thread_id IS winning.thread_id
       )
     )
   WHERE losing.id <> winning.id
     AND (
       winning.updated_at > losing.updated_at
       OR (winning.updated_at = losing.updated_at AND winning.id > losing.id)
     );
   UPDATE grove_dictation_queue
   SET binding_id = (
     SELECT winner_id FROM grove_binding_rekey
     WHERE old_id = grove_dictation_queue.binding_id
   )
   WHERE binding_id IN (SELECT old_id FROM grove_binding_rekey);
   DELETE FROM grove_bindings
   WHERE id IN (SELECT old_id FROM grove_binding_rekey);
   DROP TABLE grove_binding_rekey;
   CREATE UNIQUE INDEX IF NOT EXISTS idx_grove_bindings_workspace_source
     ON grove_bindings(path, source_kind, environment_id)
     WHERE source_kind = 'workspace'
       AND environment_id IS NOT NULL;
   CREATE UNIQUE INDEX IF NOT EXISTS idx_grove_bindings_host_without_host_source
     ON grove_bindings(path, source_kind)
     WHERE source_kind = 'host' AND host_id IS NULL;
   CREATE UNIQUE INDEX IF NOT EXISTS idx_grove_bindings_host_source
     ON grove_bindings(path, source_kind, host_id)
     WHERE source_kind = 'host' AND host_id IS NOT NULL;
   CREATE UNIQUE INDEX IF NOT EXISTS idx_grove_bindings_thread_storage_source
     ON grove_bindings(path, source_kind, thread_id)
     WHERE source_kind = 'thread-storage' AND thread_id IS NOT NULL`,
];

const bindingRowSchema = z
  .object({
    id: z.string(),
    path: z.string(),
    source_kind: z.enum(["workspace", "host", "thread-storage"]),
    thread_id: z.string().nullable(),
    environment_id: z.string().nullable(),
    project_id: z.string().nullable(),
    host_id: z.string().nullable(),
    title: z.string(),
    owner_thread_id: z.string(),
    status: z.enum(["ready", "working", "error", "orphaned"]),
    last_sha256: z.string().nullable(),
    last_error: z.string().nullable(),
    created_at: z.number(),
    updated_at: z.number(),
  })
  .strict();

function rowToBinding(row: unknown): BindingRecord {
  const parsed = bindingRowSchema.parse(row);
  const source: DocumentSource = {
    kind: parsed.source_kind,
    threadId: parsed.thread_id,
    environmentId: parsed.environment_id,
    projectId: parsed.project_id,
    hostId: parsed.host_id,
  };
  return {
    id: parsed.id,
    path: parsed.path,
    title: parsed.title,
    source,
    ownerThreadId: parsed.owner_thread_id,
    status: parsed.status,
    lastSha256: parsed.last_sha256,
    lastError: parsed.last_error,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
}

export interface NewBindingRecord {
  id: string;
  path: string;
  title: string;
  source: DocumentSource;
  ownerThreadId: string;
  status: BindingStatus;
  lastSha256: string | null;
}

export class GroveStore {
  constructor(private readonly db: Database.Database) {}

  migrate(apply: (db: Database.Database, statements: string[]) => void) {
    apply(this.db, migrations);
  }

  listBindings(): BindingRecord[] {
    return bindingRowSchema
      .array()
      .parse(
        this.db
          .prepare("SELECT * FROM grove_bindings ORDER BY updated_at DESC")
          .all(),
      )
      .map((row) => rowToBinding(row));
  }

  getBinding(id: string): BindingRecord | null {
    const row = this.db
      .prepare("SELECT * FROM grove_bindings WHERE id = ?")
      .get(id);
    return row === undefined ? null : rowToBinding(row);
  }

  getBindingForThread(threadId: string): BindingRecord | null {
    const row = this.db
      .prepare("SELECT * FROM grove_bindings WHERE owner_thread_id = ?")
      .get(threadId);
    return row === undefined ? null : rowToBinding(row);
  }

  findBySource(source: DocumentSource, filePath: string): BindingRecord | null {
    const row =
      source.kind === "thread-storage"
        ? this.db
            .prepare(
              `SELECT * FROM grove_bindings
               WHERE path = ? AND source_kind = ?
                 AND thread_id IS ?`,
            )
            .get(filePath, source.kind, source.threadId)
        : source.kind === "host"
          ? this.db
              .prepare(
                `SELECT * FROM grove_bindings
                 WHERE path = ? AND source_kind = ?
                   AND host_id IS ?`,
              )
              .get(filePath, source.kind, source.hostId)
          : this.db
              .prepare(
                `SELECT * FROM grove_bindings
                 WHERE path = ? AND source_kind = ?
                   AND environment_id IS ? AND host_id IS ?`,
              )
              .get(filePath, source.kind, source.environmentId, source.hostId);
    return row === undefined ? null : rowToBinding(row);
  }

  createBinding(binding: NewBindingRecord): BindingRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO grove_bindings (
           id, path, source_kind, thread_id, environment_id, project_id,
           host_id, title, owner_thread_id, status, last_sha256, last_error,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        binding.id,
        binding.path,
        binding.source.kind,
        binding.source.threadId,
        binding.source.environmentId,
        binding.source.projectId,
        binding.source.hostId,
        binding.title,
        binding.ownerThreadId,
        binding.status,
        binding.lastSha256,
        now,
        now,
      );
    const created = this.getBinding(binding.id);
    if (!created) throw new Error("Grove failed to persist the document binding");
    return created;
  }

  reassignBinding(
    id: string,
    ownerThreadId: string,
    status: BindingStatus,
    lastSha256: string | null,
  ): BindingRecord {
    this.db
      .prepare(
        `UPDATE grove_bindings
         SET owner_thread_id = ?, status = ?, last_sha256 = ?,
             last_error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(ownerThreadId, status, lastSha256, Date.now(), id);
    const updated = this.getBinding(id);
    if (!updated) throw new Error("Grove binding disappeared while it was reassigned");
    return updated;
  }

  updateStatus(id: string, status: BindingStatus, error: string | null): void {
    this.db
      .prepare(
        `UPDATE grove_bindings
         SET status = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, error, Date.now(), id);
  }

  updateSha(id: string, sha256: string): void {
    this.db
      .prepare(
        `UPDATE grove_bindings
         SET last_sha256 = ?, last_error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(sha256, Date.now(), id);
  }

  insertDictation(id: string, bindingId: string, transcript: string): void {
    this.db
      .prepare(
        `INSERT INTO grove_dictation_queue
           (id, binding_id, transcript, status, created_at)
         VALUES (?, ?, ?, 'queued', ?)`,
      )
      .run(id, bindingId, transcript, Date.now());
  }

  markDictationSent(id: string): void {
    this.db
      .prepare(
        `UPDATE grove_dictation_queue
         SET status = 'sent', sent_at = ?, error = NULL
         WHERE id = ?`,
      )
      .run(Date.now(), id);
  }

  markDictationFailed(id: string, error: string): void {
    this.db
      .prepare(
        `UPDATE grove_dictation_queue
         SET status = 'failed', error = ?
         WHERE id = ?`,
      )
      .run(error, id);
  }
}
