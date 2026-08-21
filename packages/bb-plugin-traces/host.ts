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
  };
  return state;
}

function closeState(): void {
  if (!state) return;
  try {
    state.db.close();
  } finally {
    state = null;
  }
}

export default experimental_defineHostEntry({
  contract: traceHostContract,
  experimental_signals: traceHostSignals,
  handlers: {
    compact(_input, context) {
      if (context.signal.aborted) return { changed: false, vacuumed: false };
      return compactStorage(openState(context.experimental_paths.dataDir).db as unknown as SqliteDb);
    },

    async scan(input, context) {
      const current = openState(context.experimental_paths.dataDir);
      if (context.signal.aborted) {
        return { changed: false, complete: false, processedPaths: [], failedPaths: [] };
      }
      try {
        compactStorage(current.db as unknown as SqliteDb);
      } catch (error) {
        // Logical cleanup is retried on the next worker call. An unavailable
        // VACUUM must not prevent new session files from being indexed.
        console.warn("[traces] storage compaction deferred", error);
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
