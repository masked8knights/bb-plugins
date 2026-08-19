import { createHash } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  defaultSessionRoots,
  ensureSchema,
  expandConfiguredPaths,
  sourceLabel,
  TraceIndexer,
  type RootSpec,
  type SessionSummary,
  type TraceSourceId,
} from "./src/indexer";
import { shouldScanAfterSettingsChange } from "./src/settings";

const SCAN_BATCH_FILES = 1;
const DETAIL_EVENT_RAW_PREVIEW_BYTES = 256;

const rootSchema = z.object({
  id: z.string(),
  source: z.string(),
  label: z.string(),
  path: z.string(),
  kind: z.literal("session"),
  format: z.enum(["jsonl", "zstd"]).optional(),
  exists: z.boolean(),
  fileCount: z.number(),
  byteCount: z.number(),
  lastScanAt: z.number().nullable(),
  error: z.string().nullable(),
});

const sessionSchema = z.object({
  id: z.string(),
  source: z.string(),
  title: z.string(),
  filePath: z.string(),
  model: z.string().nullable(),
  cwd: z.string().nullable(),
  startedAt: z.number().nullable(),
  updatedAt: z.number().nullable(),
  eventCount: z.number(),
  userCount: z.number(),
  assistantCount: z.number(),
  toolCount: z.number(),
  errorCount: z.number(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  durationMs: z.number().nullable(),
  status: z.enum(["active", "completed", "unknown"]),
  fileSizeBytes: z.number(),
});

const eventSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  line: z.number(),
  type: z.string(),
  kind: z.enum(["message", "tool", "step", "turn", "reasoning", "telemetry", "system"]),
  role: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  timestamp: z.number().nullable(),
  durationMs: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  usageIsTotal: z.boolean(),
  turn: z.number().nullable(),
  step: z.number().nullable(),
  depth: z.number(),
  model: z.string().nullable(),
  cwd: z.string().nullable(),
  rawJson: z.string().max(DETAIL_EVENT_RAW_PREVIEW_BYTES),
  rawTruncated: z.boolean(),
});

const statusSchema = z.object({
  localOnly: z.literal(true),
  state: z.enum(["idle", "indexing", "error"]),
  sessions: z.number(),
  events: z.number(),
  bytes: z.number(),
  lastScanAt: z.number().nullable(),
  lastError: z.string().nullable(),
  sources: z.array(rootSchema),
});

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: statusSchema,
  },
  listSessions: {
    input: z
      .object({
        query: z.string().max(500).optional(),
        source: z.string().max(80).optional(),
        sort: z.enum(["updated", "started", "events", "duration"]).optional(),
        limit: z.number().int().min(1).max(200).default(100),
        offset: z.number().int().min(0).max(100_000).default(0),
      })
      .strict(),
    output: z.object({
      sessions: z.array(sessionSchema),
      total: z.number(),
    }),
  },
  getSession: {
    input: z
      .object({
        id: z.string().min(1),
        limit: z.number().int().min(1).max(2_000).default(1_000),
        offset: z.number().int().min(0).max(100_000).default(0),
      })
      .strict(),
    output: z.object({
      session: sessionSchema.nullable(),
      events: z.array(eventSchema),
      totalEvents: z.number(),
    }),
  },
  getEventRaw: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ raw: z.string().nullable(), truncated: z.boolean() }),
  },
  rescan: {
    input: z.null(),
    output: statusSchema,
  },
});

export type TraceStatus = z.infer<typeof statusSchema>;
export type TraceSession = z.infer<typeof sessionSchema>;
export type TraceEvent = z.infer<typeof eventSchema>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseInterval(value: string): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) return 60_000;
  return Math.min(60_000, Math.max(1_000, Math.round(parsed * 1_000)));
}

function dedupeRoots(roots: RootSpec[]): RootSpec[] {
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = root.kind + "\0" + root.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function customRoots(raw: string): RootSpec[] {
  return expandConfiguredPaths(raw).map((path) => ({
    id: "custom-session-" + createHash("sha1").update(path).digest("hex").slice(0, 16),
    source: "custom",
    label: "Custom session root",
    path,
    kind: "session",
    format: "jsonl",
  }));
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    autoIndex: {
      type: "boolean",
      label: "Auto-index local traces",
      description: "Keep the local session index fresh while BB is running.",
      default: true,
    },
    scanIntervalSeconds: {
      type: "string",
      label: "Safety scan interval (seconds)",
      description: "How often the local index checks session roots for new or changed files. File changes trigger faster refreshes.",
      default: "60",
    },
    additionalSessionRoots: {
      type: "string",
      label: "Additional session roots",
      description: "Optional absolute paths, one per line, containing JSONL sessions from another harness.",
      default: "",
    },
  });

  const db = bb.storage.database();
  const ftsEnabled = ensureSchema(db);
  const indexer = new TraceIndexer(db, ftsEnabled, (message) => bb.log.warn(message));
  let indexing = false;
  let lastScanAt: number | null = null;
  let lastError: string | null = null;
  let scanRequested = false;
  let activeScan: Promise<boolean> | null = null;
  let autoIndexEnabled = true;
  let manualScanPending = false;
  let rootWatchers: FSWatcher[] = [];
  let watchedRootKey = "";
  let watcherScanTimer: ReturnType<typeof setTimeout> | null = null;
  let nextSafetyScanAt = 0;
  let dirtySessionPaths = new Set<string>();
  let watcherGeneration = 0;

  async function roots(): Promise<RootSpec[]> {
    const current = await settings.get();
    return dedupeRoots(defaultSessionRoots().concat(customRoots(current.additionalSessionRoots)));
  }

  function publish(): void {
    try {
      bb.realtime.publish("traces", { type: "index-updated", at: Date.now() });
    } catch {
      // Realtime is an acceleration; the panel can always refetch durable state.
    }
  }

  function closeRootWatchers(): void {
    watcherGeneration += 1;
    if (watcherScanTimer) {
      clearTimeout(watcherScanTimer);
      watcherScanTimer = null;
    }
    for (const watcher of rootWatchers) watcher.close();
    rootWatchers = [];
    watchedRootKey = "";
  }

  function requestScanFromWatcher(generation: number, rootPath: string, filename: string | Buffer | null): void {
    if (generation !== watcherGeneration) return;
    if (!autoIndexEnabled) return;
    if (filename !== null && String(filename).length > 0) {
      dirtySessionPaths.add(join(rootPath, String(filename)));
    }
    if (watcherScanTimer) clearTimeout(watcherScanTimer);
    watcherScanTimer = setTimeout(() => {
      watcherScanTimer = null;
      if (autoIndexEnabled) scanRequested = true;
    }, 250);
  }

  function configureRootWatchers(configured: RootSpec[]): void {
    if (!autoIndexEnabled) {
      closeRootWatchers();
      return;
    }
    const rootsToWatch = configured;
    const key = rootsToWatch
      .map((root) => root.kind + "\0" + root.path + "\0" + (existsSync(root.path) ? "1" : "0"))
      .sort()
      .join("\n");
    if (key === watchedRootKey) return;
    closeRootWatchers();
    watchedRootKey = key;
    const generation = watcherGeneration;
    for (const root of rootsToWatch) {
      if (!existsSync(root.path)) continue;
      try {
        const watcher = watch(root.path, { recursive: true }, (_eventType, filename) => requestScanFromWatcher(generation, root.path, filename));
        watcher.on("error", (error) => {
          if (generation !== watcherGeneration) return;
          watcher.close();
          if (watchedRootKey === key) {
            watchedRootKey = "";
            scanRequested = true;
          }
          bb.log.warn("Trace watcher failed for " + root.path + ": " + errorText(error));
        });
        rootWatchers.push(watcher);
      } catch (error) {
        // Some platforms do not support recursive watchers. The safety sweep
        // remains the fallback, and a later root existence change retries it.
        bb.log.warn("Could not watch trace root " + root.path + ": " + errorText(error));
      }
    }
  }

  async function status(): Promise<TraceStatus> {
    const scanInProgress = indexing || scanRequested || activeScan !== null;
    const stats = indexer.stats(lastScanAt, scanInProgress, lastError);
    return {
      localOnly: true,
      state: scanInProgress ? "indexing" : lastError ? "error" : "idle",
      sessions: stats.sessions,
      events: stats.events,
      bytes: stats.bytes,
      lastScanAt: stats.lastScanAt,
      lastError: stats.lastError,
      sources: indexer.roots().map((root) => ({
        ...root,
        format: root.format,
      })),
    };
  }

  async function scanNow(signal?: AbortSignal): Promise<boolean> {
    if (activeScan) return activeScan;
    activeScan = (async () => {
      indexing = true;
      lastError = null;
      let changed = false;
      let drainedDirtySessionPaths = new Set<string>();
      let scanDrainedWatcherState = false;
      let scanCompleted = false;
      let scanComplete = false;
      let scanFailed = false;
      const restoreWatcherState = () => {
        if (!scanDrainedWatcherState || scanCompleted) return;
        for (const path of drainedDirtySessionPaths) dirtySessionPaths.add(path);
      };
      try {
        const configured = await roots();
        drainedDirtySessionPaths = dirtySessionPaths;
        const failedSessionPaths = new Set<string>();
        dirtySessionPaths = new Set();
        scanDrainedWatcherState = true;
        const result = await indexer.scan(configured, signal, {
          forceFingerprintPaths: drainedDirtySessionPaths,
          failedSessionPaths,
          maxFiles: SCAN_BATCH_FILES,
        });
        changed = result.changed;
        const processedPaths = new Set(result.processedPaths);
        for (const path of drainedDirtySessionPaths) {
          if (!processedPaths.has(path)) dirtySessionPaths.add(path);
        }
        for (const path of failedSessionPaths) dirtySessionPaths.add(path);
        changed = changed || failedSessionPaths.size > 0;
        scanComplete = result.complete;
        scanCompleted = !signal?.aborted;
        if (!signal?.aborted && scanComplete) lastScanAt = Date.now();
      } catch (error) {
        scanFailed = true;
        restoreWatcherState();
        lastError = errorText(error);
        bb.log.warn("Trace index scan failed: " + lastError);
      } finally {
        restoreWatcherState();
        indexing = false;
        activeScan = null;
        if (scanComplete) manualScanPending = false;
        if (!signal?.aborted && !scanFailed && !scanComplete && (autoIndexEnabled || manualScanPending)) scanRequested = true;
        if (changed || lastError) publish();
      }
      return scanComplete;
    })();
    return activeScan;
  }

  bb.rpc.register(rpcContract, {
    status,
    listSessions(input) {
      return indexer.listSessions(input);
    },
    getSession(input) {
      const detail = indexer.getSession(input.id, input.limit, input.offset);
      return {
        ...detail,
        events: detail.events.map((event) => ({
          ...event,
          rawJson: event.rawJson.slice(0, DETAIL_EVENT_RAW_PREVIEW_BYTES),
          rawTruncated: event.rawTruncated || event.rawJson.length > DETAIL_EVENT_RAW_PREVIEW_BYTES,
        })),
      };
    },
    async getEventRaw({ id }) {
      return indexer.rawEvent(id);
    },
    async rescan() {
      scanRequested = true;
      manualScanPending = true;
      nextSafetyScanAt = 0;
      publish();
      return status();
    },
  });

  settings.onChange((next, previous) => {
    autoIndexEnabled = next.autoIndex;
    const rootsChanged = next.additionalSessionRoots !== previous.additionalSessionRoots;
    const shouldScan = shouldScanAfterSettingsChange(next, previous);
    if (!next.autoIndex && !rootsChanged) {
      scanRequested = false;
      manualScanPending = false;
    } else {
      scanRequested = scanRequested || shouldScan;
      if (shouldScan && (!next.autoIndex || rootsChanged)) manualScanPending = true;
    }
    if (next.scanIntervalSeconds !== previous.scanIntervalSeconds) nextSafetyScanAt = 0;
    if (!next.autoIndex) closeRootWatchers();
    publish();
  });

  bb.background.service("indexer", {
    async start(signal) {
      try {
        while (!signal.aborted) {
          try {
            const current = await settings.get();
            autoIndexEnabled = current.autoIndex;
            const configured = await roots();
            configureRootWatchers(configured);
            if (current.autoIndex && Date.now() >= nextSafetyScanAt) {
              scanRequested = true;
            }
            if (scanRequested) {
              scanRequested = false;
              const scanComplete = await scanNow(signal);
              nextSafetyScanAt = scanComplete
                ? Date.now() + parseInterval(current.scanIntervalSeconds)
                : Date.now() + (lastError ? 10_000 : 1_000);
            }
          } catch (error) {
            lastError = errorText(error);
            bb.log.warn("Trace indexer loop failed: " + lastError);
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1_000);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });
        }
      } finally {
        closeRootWatchers();
        // Do not let a reload unload this service while its SQLite transaction
        // is still active. The next plugin instance must be able to acquire
        // the same durable database without racing the previous scan.
        if (activeScan) await activeScan;
      }
    },
  });

  bb.log.info("loaded; local trace indexer enabled for " + sourceLabel("codex") + ", Claude, Pi, OMP, and DeepSeek Harness");
}
