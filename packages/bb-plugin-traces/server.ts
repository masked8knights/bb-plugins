import { createHash } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  defaultArtifactRoots,
  defaultSessionRoots,
  ensureSchema,
  expandConfiguredPaths,
  sourceLabel,
  TraceIndexer,
  type ArtifactSummary,
  type RootSpec,
  type SessionSummary,
  type TraceSourceId,
} from "./src/indexer";
import { shouldScanAfterSettingsChange } from "./src/settings";

const rootSchema = z.object({
  id: z.string(),
  source: z.string(),
  label: z.string(),
  path: z.string(),
  kind: z.enum(["session", "artifact"]),
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
  rawJson: z.string(),
  rawTruncated: z.boolean(),
});

const artifactSchema = z.object({
  id: z.string(),
  source: z.literal("artifacts"),
  title: z.string(),
  filePath: z.string(),
  kind: z.enum(["decision", "context"]),
  updatedAt: z.number(),
  sizeBytes: z.number(),
  preview: z.string(),
});

const statusSchema = z.object({
  localOnly: z.literal(true),
  state: z.enum(["idle", "indexing", "error"]),
  sessions: z.number(),
  events: z.number(),
  artifacts: z.number(),
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
  listArtifacts: {
    input: z
      .object({
        query: z.string().max(500).optional(),
        kind: z.enum(["decision", "context"]).optional(),
        limit: z.number().int().min(1).max(200).default(100),
        offset: z.number().int().min(0).max(100_000).default(0),
      })
      .strict(),
    output: z.object({
      artifacts: z.array(artifactSchema),
      total: z.number(),
    }),
  },
  getArtifact: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ artifact: artifactSchema.nullable() }),
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
export type TraceArtifact = z.infer<typeof artifactSchema>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseInterval(value: string): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) return 5_000;
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

function customRoots(raw: string, kind: "session" | "artifact"): RootSpec[] {
  return expandConfiguredPaths(raw).map((path) => ({
    id: "custom-" + kind + "-" + createHash("sha1").update(path).digest("hex").slice(0, 16),
    source: kind === "session" ? "custom" : "artifacts",
    label: kind === "session" ? "Custom session root" : "Custom workspace root",
    path,
    kind,
    ...(kind === "session" ? { format: "jsonl" as const } : {}),
  }));
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    autoIndex: {
      type: "boolean",
      label: "Auto-index local traces",
      description: "Keep the local session and artifact index fresh while BB is running.",
      default: true,
    },
    scanIntervalSeconds: {
      type: "string",
      label: "Scan interval (seconds)",
      description: "How often the local index checks append-only session files for new events.",
      default: "5",
    },
    additionalSessionRoots: {
      type: "string",
      label: "Additional session roots",
      description: "Optional absolute paths, one per line, containing JSONL sessions from another harness.",
      default: "",
    },
    workspaceRoots: {
      type: "string",
      label: "Additional decision/workspace roots",
      description: "Optional absolute paths, one per line. Decision, plan, handoff, and state files are indexed locally.",
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
  let activeScan: Promise<void> | null = null;

  async function roots(): Promise<{ sessions: RootSpec[]; artifacts: RootSpec[] }> {
    const current = await settings.get();
    return {
      sessions: dedupeRoots(defaultSessionRoots().concat(customRoots(current.additionalSessionRoots, "session"))),
      artifacts: dedupeRoots(defaultArtifactRoots().concat(customRoots(current.workspaceRoots, "artifact"))),
    };
  }

  function publish(): void {
    try {
      bb.realtime.publish("traces", { type: "index-updated", at: Date.now() });
    } catch {
      // Realtime is an acceleration; the panel can always refetch durable state.
    }
  }

  async function status(): Promise<TraceStatus> {
    const stats = indexer.stats(lastScanAt, indexing, lastError);
    return {
      localOnly: true,
      state: indexing ? "indexing" : lastError ? "error" : "idle",
      sessions: stats.sessions,
      events: stats.events,
      artifacts: stats.artifacts,
      bytes: stats.bytes,
      lastScanAt: stats.lastScanAt,
      lastError: stats.lastError,
      sources: indexer.roots().map((root) => ({
        ...root,
        format: root.format,
      })),
    };
  }

  async function scanNow(signal?: AbortSignal): Promise<void> {
    if (activeScan) return activeScan;
    activeScan = (async () => {
      indexing = true;
      lastError = null;
      let changed = false;
      try {
        const configured = await roots();
        const before = indexer.stats(null, false, null);
        await indexer.scan(configured.sessions, configured.artifacts, signal);
        const after = indexer.stats(null, false, null);
        changed = before.sessions !== after.sessions || before.events !== after.events || before.artifacts !== after.artifacts || before.bytes !== after.bytes;
        if (!signal?.aborted) lastScanAt = Date.now();
      } catch (error) {
        lastError = errorText(error);
        bb.log.warn("Trace index scan failed: " + lastError);
      } finally {
        indexing = false;
        activeScan = null;
        if (changed || lastError) publish();
      }
    })();
    return activeScan;
  }

  bb.rpc.register(rpcContract, {
    status,
    listSessions(input) {
      return indexer.listSessions(input);
    },
    getSession(input) {
      return indexer.getSession(input.id, input.limit, input.offset);
    },
    listArtifacts(input) {
      return indexer.listArtifacts(input);
    },
    getArtifact({ id }) {
      return { artifact: indexer.getArtifact(id) };
    },
    getEventRaw({ id }) {
      return indexer.rawEvent(id);
    },
    async rescan() {
      scanRequested = false;
      await scanNow();
      return status();
    },
  });

  settings.onChange((next, previous) => {
    scanRequested = shouldScanAfterSettingsChange(next, previous);
    publish();
  });

  bb.background.service("indexer", {
    async start(signal) {
      let nextScanAt = 0;
      while (!signal.aborted) {
        try {
          const current = await settings.get();
          if (current.autoIndex && Date.now() >= nextScanAt) scanRequested = true;
          if (scanRequested) {
            scanRequested = false;
            await scanNow(signal);
            nextScanAt = Date.now() + parseInterval(current.scanIntervalSeconds);
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
    },
  });

  bb.log.info("loaded; local trace indexer enabled for " + sourceLabel("codex") + ", Claude, Pi, OMP, and DeepSeek Harness");
}
