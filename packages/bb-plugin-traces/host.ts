import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  compactStorage,
  ensureSchema,
  TraceIndexer,
  type RootSpec,
  type SqliteDb,
} from "./src/indexer";
import { traceHostContract, traceHostSignals } from "./src/host-contract";

type WorkerState = {
  dataDir: string;
  db: DatabaseSync;
  indexer: TraceIndexer;
  compaction: {
    running: boolean;
    lastResult: { changed: boolean; vacuumed: boolean };
    done: Promise<void> | null;
  };
};

let state: WorkerState | null = null;

function openState(dataDir: string): WorkerState {
  if (state?.dataDir === dataDir) return state;
  state?.db.close();
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(resolve(dataDir, "..", "data.db"));
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  const sqlite = db as unknown as SqliteDb;
  ensureSchema(sqlite);
  state = {
    dataDir,
    db,
    indexer: new TraceIndexer(sqlite),
    compaction: {
      running: false,
      lastResult: { changed: false, vacuumed: false },
      done: null,
    },
  };
  return state;
}

async function closeState(): Promise<void> {
  if (!state) return;
  const closing = state;
  state = null;
  if (closing.compaction.done) await closing.compaction.done;
  try {
    closing.db.close();
  } catch {
    // The daemon may already have closed the worker's database during reload.
  }
}

type RetainedWorkerLease = { dispose(): Promise<void> };

function compactResult(current: WorkerState, running = current.compaction.running) {
  return { ...current.compaction.lastResult, running };
}

function startCompaction(current: WorkerState, context: { experimental_retainWorker(): RetainedWorkerLease }): void {
  if (current.compaction.running || current.compaction.lastResult.vacuumed) return;
  const lease = context.experimental_retainWorker();
  current.compaction.running = true;
  current.compaction.done = new Promise<void>((resolve) => {
    setImmediate(() => {
      try {
        current.compaction.lastResult = compactStorage(current.db as unknown as SqliteDb);
      } catch (error) {
        console.warn("[traces] storage compaction deferred", error);
      } finally {
        current.compaction.running = false;
        current.compaction.done = null;
        void lease.dispose().catch(() => {});
        resolve();
      }
    });
  });
}

export default experimental_defineHostEntry({
  contract: traceHostContract,
  experimental_signals: traceHostSignals,
  handlers: {
    compact(_input, context) {
      const current = openState(context.experimental_paths.dataDir);
      if (context.signal.aborted) return compactResult(current);
      startCompaction(current, context);
      return compactResult(current);
    },

    async scan(input, context) {
      const current = openState(context.experimental_paths.dataDir);
      if (context.signal.aborted) {
        return { changed: false, complete: false, processedPaths: [], failedPaths: [] };
      }
      const failedSessionPaths = new Set<string>();
      const result = await current.indexer.scan(input.roots as RootSpec[], context.signal, {
        forceFingerprintPaths: new Set(input.forceFingerprintPaths),
        forceFingerprintAll: input.forceFingerprintAll,
        failedSessionPaths,
        maxFiles: input.maxFiles,
      });
      return { ...result, failedPaths: [...failedSessionPaths] };
    },

    stats(input, context) {
      if (context.signal.aborted) {
        return {
          sessions: 0,
          events: 0,
          bytes: 0,
          lastScanAt: input.lastScanAt,
          indexing: input.indexing,
          lastError: input.lastError,
        };
      }
      const stats = currentState(context).indexer.stats(input.lastScanAt, false, input.lastError);
      return { ...stats, indexing: input.indexing };
    },

    listSessions(input, context) {
      if (context.signal.aborted) return { sessions: [], total: 0 };
      return currentState(context).indexer.listSessions(input);
    },

    getSession(input, context) {
      if (context.signal.aborted) return { session: null, events: [], totalEvents: 0 };
      return currentState(context).indexer.getSession(input.id, input.limit, input.offset, {
        query: input.query,
        categories: input.categories,
        toolTypes: input.toolTypes,
        errorFilter: input.errorFilter,
      });
    },

    getSessionFacets({ id }, context) {
      if (context.signal.aborted) return { categories: [], toolTypes: [], errorCount: 0, totalEvents: 0 };
      return currentState(context).indexer.getSessionFacets(id);
    },

    async rawEvent({ id }, context) {
      if (context.signal.aborted) return { raw: null, truncated: false };
      return openState(context.experimental_paths.dataDir).indexer.rawEvent(id);
    },
  },
  dispose: closeState,
});

function currentState(context: { experimental_paths: { dataDir: string } }): WorkerState {
  return openState(context.experimental_paths.dataDir);
}
