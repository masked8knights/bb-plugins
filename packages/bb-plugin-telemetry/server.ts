import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { AnalyticsStore } from "./src/db";
import { buildDashboard, sessionFilter } from "./src/aggregate";
import { analyzeFindings } from "./src/findings";
import { indexBbThreads } from "./src/bb-indexer";
import { explicitProviderLinkKey, linkProviderSessions } from "./src/linker";
import {
  currentPriceTable,
  lookupModelPrice,
  modelsDevToTable,
  parsePriceOverrides,
  PRICES_REFRESH_MS,
  providerFallbackPrices,
  setRuntimePriceTable,
  withSessionCost,
} from "./src/pricing";
import { PROVIDER_LABELS, PROVIDER_SOURCES, defaultSettings, isProviderId } from "./src/source-registry";
import { resolveHost, scanProviderSource } from "./src/source-reader";
import type {
  DashboardInput,
  DashboardResult,
  FindingRecord,
  ModelPrice,
  PriceOverrides,
  ProviderId,
  RangeId,
  SourceStatusRecord,
  SourceKind,
  SourceSettings,
} from "./src/types";

const providerSchema = z.enum(["codex", "claude", "pi", "prime", "opencode", "omp", "other"]);
const sourceSchema = z.enum(["provider", "bb"]);
const rangeSchema = z.enum(["1h", "6h", "24h", "7d", "30d", "lifetime"]);
const capabilityLevelSchema = z.enum(["complete", "partial", "unavailable"]);
const capabilitySchema = z.object({
  metadata: capabilityLevelSchema,
  turns: capabilityLevelSchema,
  tools: capabilityLevelSchema,
  tokens: capabilityLevelSchema,
  context: capabilityLevelSchema,
  errors: capabilityLevelSchema,
  latency: capabilityLevelSchema,
  models: capabilityLevelSchema,
});
const evidenceSchema = z.object({
  source: sourceSchema,
  sourceRecordId: z.string(),
  sourceSequence: z.number().nullable(),
  eventType: z.string(),
  at: z.number().nullable(),
});
const costSchema = z.object({
  totalUsd: z.number(),
  estimated: z.boolean(),
  priceSource: z.enum(["model", "provider-fallback", "provider"]),
  model: z.string().nullable(),
  pricedTokens: z.number(),
});
const sessionSchema = z.object({
  id: z.string(),
  source: sourceSchema,
  provider: providerSchema,
  hostId: z.string(),
  providerSessionId: z.string().nullable(),
  bbThreadId: z.string().nullable(),
  title: z.string(),
  cwd: z.string().nullable(),
  projectId: z.string().nullable(),
  model: z.string().nullable(),
  origin: z.string().nullable(),
  status: z.enum(["active", "completed", "failed", "unknown"]),
  startedAt: z.number().nullable(),
  updatedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  messageCount: z.number(),
  turnCount: z.number(),
  toolCalls: z.number(),
  toolErrors: z.number(),
  inputTokens: z.number().nullable(),
  cachedInputTokens: z.number().nullable(),
  cachedWriteTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  reasoningTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  contextPeak: z.number().nullable(),
  costUsd: z.number().nullable(),
  costEstimated: z.boolean(),
  compactionCount: z.number(),
  failureCount: z.number(),
  delegatedCount: z.number(),
  archived: z.boolean(),
  coverage: capabilitySchema,
  storeLabel: z.string(),
  sourcePath: z.string().nullable(),
  fingerprint: z.string().nullable(),
  linkState: z.enum(["none", "suggested", "linked"]),
  findingCount: z.number(),
});
const sourceStatusSchema = z.object({
  id: z.string(),
  provider: providerSchema,
  label: z.string(),
  hostId: z.string(),
  storeKind: z.enum(["jsonl", "sqlite"]),
  pathLabel: z.string(),
  enabled: z.boolean(),
  detected: z.boolean(),
  supported: z.boolean(),
  count: z.number(),
  capabilities: capabilitySchema,
  cursor: z.string().nullable(),
  lastSuccessAt: z.number().nullable(),
  lastError: z.string().nullable(),
  lastWarning: z.string().nullable(),
  remoteDatabaseUnsupported: z.boolean(),
});
const findingSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  severity: z.enum(["info", "warning", "critical"]),
  source: sourceSchema,
  provider: providerSchema,
  scope: z.enum(["range", "provider", "session", "turn", "tool"]),
  scopeId: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  recommendation: z.string(),
  metricValue: z.number().nullable(),
  threshold: z.number().nullable(),
  sampleSize: z.number(),
  coverageNote: z.string(),
  evidence: z.array(evidenceSchema),
  createdAt: z.number(),
});

const dashboardInputSchema = z.object({
  view: z.enum(["provider", "unified", "bb"]),
  range: rangeSchema,
  providers: z.array(z.string()).optional(),
  source: sourceSchema.optional(),
  hostId: z.string().optional(),
  projectId: z.string().optional(),
  model: z.string().optional(),
  archived: z.boolean().optional(),
}).strict();

type StatusDto = {
  generatedAt: number;
  sources: SourceStatusRecord[];
  providers: DashboardResult["providers"];
  totalSessions: number;
  lastIndexedAt: number | null;
  error: string | null;
  indexing: JobState;
};

const totalsSchema = z.object({
  sessions: z.number(),
  active: z.number(),
  failed: z.number(),
  turns: z.number(),
  messages: z.number(),
  toolCalls: z.number(),
  toolErrors: z.number(),
  inputTokens: z.number().nullable(),
  cachedInputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  reasoningTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
  costEstimated: z.boolean(),
  contextPeak: z.number().nullable(),
  compactions: z.number(),
  sampleSize: z.number(),
});
const providerSummarySchema = z.object({
  provider: providerSchema,
  label: z.string(),
  sessions: z.number(),
  active: z.number(),
  failed: z.number(),
  turns: z.number(),
  messages: z.number(),
  toolCalls: z.number(),
  toolErrors: z.number(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
  costEstimated: z.boolean(),
  contextIssues: z.number(),
  lastActivityAt: z.number().nullable(),
  sampleSize: z.number(),
  coverage: capabilitySchema,
});
const statusOutputSchema = z.object({
  generatedAt: z.number(),
  sources: z.array(sourceStatusSchema),
  providers: z.array(providerSummarySchema),
  defaultView: z.enum(["provider", "unified", "bb"]),
  defaultRange: rangeSchema,
  totalSessions: z.number(),
  lastIndexedAt: z.number().nullable(),
  error: z.string().nullable(),
  indexing: z.object({ active: z.boolean(), phase: z.string(), provider: z.string().nullable(), done: z.number(), total: z.number() }),
});
const dashboardOutputSchema = z.object({
  view: z.enum(["provider", "unified", "bb"]),
  range: rangeSchema,
  generatedAt: z.number(),
  stale: z.boolean(),
  totals: totalsSchema,
  providers: z.array(providerSummarySchema),
  findings: z.array(findingSchema),
  sessions: z.array(sessionSchema),
  tools: z.array(z.object({ provider: providerSchema, name: z.string(), calls: z.number(), failures: z.number(), failureRate: z.number().nullable(), p50LatencyMs: z.number().nullable(), p95LatencyMs: z.number().nullable() })),
  daily: z.array(z.object({
    date: z.string(),
    sessions: z.number(),
    turns: z.number(),
    toolErrors: z.number(),
    totalTokens: z.number().nullable(),
    byProvider: z.record(z.string(), z.object({ sessions: z.number(), turns: z.number(), toolErrors: z.number(), totalTokens: z.number().nullable() })),
  })),
  models: z.array(z.object({ model: z.string(), provider: providerSchema, sessions: z.number(), totalTokens: z.number().nullable() })),
  coverage: z.array(z.object({ provider: providerSchema, capability: z.enum(["metadata", "turns", "tools", "tokens", "context", "errors", "latency", "models"]), level: capabilityLevelSchema, note: z.string() })),
});
export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: statusOutputSchema,
  },
  dashboard: {
    input: dashboardInputSchema,
    output: dashboardOutputSchema,
  },
  listSessions: {
    input: dashboardInputSchema.extend({ limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() }).strict(),
    output: z.object({ sessions: z.array(sessionSchema), total: z.number() }),
  },
  reindex: {
    input: z.object({ full: z.boolean().optional(), clear: z.boolean().optional(), providers: z.array(z.string()).optional(), hostId: z.string().optional() }).strict(),
    output: z.object({ started: z.boolean() }),
  },
  findings: {
    input: dashboardInputSchema.extend({ severity: z.enum(["info", "warning", "critical"]).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    output: z.object({ findings: z.array(findingSchema), total: z.number() }),
  },
});

export type RpcContract = typeof rpcContract;

type JobState = { active: boolean; phase: string; provider: string | null; done: number; total: number };
type SyncOptions = { full?: boolean; providers?: ProviderId[]; hostId?: string };
type QueuedSync = {
  options: SyncOptions;
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
};

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

const MODELS_DEV_URL = "https://models.dev/api.json";
const PRICE_CACHE_KEY = "models-dev-price-table";

function bool(value: string | boolean | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function text(value: string | boolean | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

function isDashboardView(value: string): value is DashboardInput["view"] {
  return value === "provider" || value === "unified" || value === "bb";
}

function isRangeId(value: string): value is RangeId {
  return value === "1h" || value === "6h" || value === "24h" || value === "7d" || value === "30d" || value === "lifetime";
}

function isSeverity(value: string): value is FindingRecord["severity"] {
  return value === "info" || value === "warning" || value === "critical";
}

function parseSettings(values: Record<string, string | boolean | undefined>): SourceSettings {
  const defaults = defaultSettings();
  const defaultView = text(values.defaultView, defaults.defaultView);
  const defaultRange = text(values.defaultRange, defaults.defaultRange);
  // Pre-split settings lived under `prime*` keys (the old "Pi / Prime Agent"
  // source); they describe Pi's store, so carry them over to the `pi*` keys.
  const legacyKeys: Record<string, string> = { pi: "prime" };
  const valueFor = (source: (typeof PROVIDER_SOURCES)[number], suffix: "Enabled" | "Path" | "HostId"): string | boolean | undefined => {
    const current = values[`${source.id}${suffix}`];
    if (current !== undefined) return current;
    const legacy = legacyKeys[source.id];
    return legacy ? values[`${legacy}${suffix}`] : undefined;
  };
  return {
    ...defaults,
    autoIndex: bool(values.autoIndex, defaults.autoIndex),
    includeArchived: bool(values.includeArchived, defaults.includeArchived),
    excludeCodexBar: bool(values.excludeCodexBar, defaults.excludeCodexBar),
    defaultView: isDashboardView(defaultView) ? defaultView : defaults.defaultView,
    defaultRange: isRangeId(defaultRange) ? defaultRange : defaults.defaultRange,
    retentionDays: Number(values.retentionDays ?? defaults.retentionDays) || defaults.retentionDays,
    hostId: text(values.hostId, defaults.hostId),
    priceOverrides: parsePriceOverrides(values.priceTable),
    sources: Object.fromEntries(PROVIDER_SOURCES.map((source) => [source.id, {
      enabled: bool(valueFor(source, "Enabled"), true),
      path: text(valueFor(source, "Path") ?? source.defaultPath, source.defaultPath),
      hostId: text(valueFor(source, "HostId") ?? "", ""),
    }])) as SourceSettings["sources"],
  };
}

function cliFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function hasFlag(argv: string[], ...names: string[]): boolean {
  return names.some((name) => argv.includes(name));
}

function filterSessionsForSettings(
  sessions: import("./src/types").ProviderSessionRecord[],
  settings: SourceSettings,
): import("./src/types").ProviderSessionRecord[] {
  return sessions.filter((session) => {
    if (session.source === "bb") return true;
    const source = settings.sources[session.provider as ProviderId];
    return source === undefined || source.enabled;
  });
}

export default async function plugin(bb: BbPluginApi) {
  const database = bb.storage.database();
  const store = new AnalyticsStore(database);
  store.migrate((db, statements) => bb.storage.migrate(db, statements));
  const settingsHandle = bb.settings.define({
    autoIndex: { type: "boolean", label: "Index provider sessions automatically", default: true },
    includeArchived: { type: "boolean", label: "Include archived bb threads", default: true },
    excludeCodexBar: { type: "boolean", label: "Exclude CodexBar sessions", default: true },
    defaultView: { type: "select", label: "Default telemetry view", options: ["provider", "unified", "bb"], default: "provider" },
    defaultRange: { type: "select", label: "Default time range", options: ["1h", "6h", "24h", "7d", "30d", "lifetime"], default: "7d" },
    retentionDays: { type: "string", label: "Retention days", default: "90" },
    hostId: { type: "string", label: "Default source host", description: "Leave empty to use the primary host.", default: "" },
    priceTable: { type: "string", label: "Price table overrides (JSON)", description: "Optional verified prices, keyed by provider then model: {\"codex\": {\"gpt-5\": {\"inputPerM\": 1.25, \"cachedInputPerM\": 0.125, \"outputPerM\": 10}}}. Costs for models without a price use provider fallback pricing and are marked estimated.", default: "" },
    ...Object.fromEntries(PROVIDER_SOURCES.flatMap((source) => [
      [`${source.id}Enabled`, { type: "boolean", label: `Index ${source.label} sessions`, default: true }],
      [`${source.id}Path`, { type: "string", label: `${source.label} store path`, default: source.defaultPath }],
      [`${source.id}HostId`, { type: "string", label: `${source.label} source host`, default: "" }],
    ])),
  } as Parameters<typeof bb.settings.define>[0]);

  const getSettings = async (): Promise<SourceSettings> => parseSettings(await settingsHandle.get());
  let job: JobState = { active: false, phase: "idle", provider: null, done: 0, total: 0 };
  let lastError: string | null = null;
  let lastIndexedAt: number | null = (await bb.storage.kv.get<number>("lastIndexedAt")) ?? null;
  let running: Promise<void> | null = null;
  let queued: QueuedSync | null = null;

  const publish = (payload: unknown) => {
    try { bb.realtime.publish("telemetry-index", payload); } catch { /* best effort */ }
  };

  async function bbProviderIds(): Promise<Set<string>> {
    try { return new Set((await bb.sdk.providers.list()).map((provider) => provider.id)); } catch { return new Set(); }
  }

  function findingsFor(
    sessions: import("./src/types").ProviderSessionRecord[],
    sources: SourceStatusRecord[],
    input: DashboardInput,
    now: number,
  ): FindingRecord[] {
    const visible = sessionFilter(sessions, input, now);
    const ids = new Set(visible.map((session) => session.id));
    return analyzeFindings(visible, store.getItemsForSessions(ids), sources, now);
  }

  let pricesRefreshing: Promise<void> | null = null;

  async function refreshPrices(force = false): Promise<void> {
    if (pricesRefreshing) return pricesRefreshing;
    const task = (async () => {
      const cached = store.getPriceCache<Record<string, ModelPrice>>(PRICE_CACHE_KEY);
      if (cached && !force && Date.now() - cached.updatedAt < PRICES_REFRESH_MS) {
        setRuntimePriceTable(cached.value);
        return;
      }
      try {
        const response = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`models.dev responded with ${response.status}`);
        const payload: unknown = await response.json();
        const table = modelsDevToTable(payload);
        if (!Object.keys(table).length) throw new Error("models.dev returned no priced models");
        store.setPriceCache(PRICE_CACHE_KEY, table);
        setRuntimePriceTable(table);
        bb.log.info(`Telemetry prices refreshed from models.dev (${Object.keys(table).length} models).`);
      } catch (error) {
        if (cached) setRuntimePriceTable(cached.value);
        bb.log.warn(`Telemetry price refresh failed; using ${cached ? "cached" : "bundled fallback"} prices. ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    pricesRefreshing = task;
    void task.finally(() => {
      if (pricesRefreshing === task) pricesRefreshing = null;
    });
    return task;
  }

  async function sync(options: SyncOptions = {}): Promise<void> {
    if (running) {
      if (!options.full && !options.providers?.length && !options.hostId) return running;
      if (queued) {
        queued.options = {
          full: queued.options.full || options.full,
          providers: options.full && !options.providers ? undefined : options.providers ?? queued.options.providers,
          hostId: options.hostId ?? queued.options.hostId,
        };
        return queued.promise;
      }
      let resolve!: () => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
      queued = { options, promise, resolve, reject };
      return promise;
    }
    const task = (async () => {
      const current = await getSettings();
      const host = await resolveHost(bb, options.hostId ?? current.hostId);
      const wanted = options.providers?.length ? options.providers : PROVIDER_SOURCES.map((source) => source.id).filter((provider) => current.sources[provider].enabled);
      job = { active: true, phase: "provider-scan", provider: null, done: 0, total: wanted.length + 1 };
      publish(job);
      const providerSessions = [] as import("./src/types").ProviderSessionRecord[];
      let done = 0;
      for (const provider of wanted) {
        job = { ...job, provider, done };
        publish(job);
        // The scan consults the per-file skip cache before reading anything;
        // resolve the effective source host the same way scanProviderSource does.
        const scanHostId = current.sources[provider].hostId || current.hostId || host.id;
        const existingFiles = store.getSourceFileFingerprints(provider, scanHostId);
        const result = await scanProviderSource(bb, current, provider, host, {
          full: Boolean(options.full),
          existingFiles,
        });
        const bbIds = await bbProviderIds();
        const sourceStatus = {
          id: `${provider}:${result.hostId}`,
          provider,
          label: PROVIDER_LABELS[provider],
          hostId: result.hostId,
          storeKind: result.storeKind,
          pathLabel: result.pathLabel,
          enabled: current.sources[provider].enabled,
          detected: result.detected,
          supported: PROVIDER_SOURCES.find((source) => source.id === provider)?.bbProviderIds.some((id) => bbIds.has(id)) ?? false,
          count: result.count,
          capabilities: result.capabilities,
          cursor: result.records.at(-1)?.session.fingerprint ?? null,
          lastSuccessAt: result.error ? store.getSource(provider, result.hostId)?.lastSuccessAt ?? null : Date.now(),
          lastError: result.error,
          lastWarning: result.warning,
          remoteDatabaseUnsupported: result.remoteDatabaseUnsupported,
        } as const;
        store.upsertSource(sourceStatus);
        const seen = new Set<string>();
        for (const parsed of result.records) {
          // If an explicit configuration points Pi and Prime Agent at the
          // same historical JSONL store, identical files must not be indexed
          // under both providers. Prime yields to Pi (the canonical owner).
          if (parsed.session.provider === "prime" && parsed.session.fingerprint) {
            const claimed = store.getSessionByFingerprint(parsed.session.fingerprint, "prime");
            if (claimed) continue;
          }
          seen.add(parsed.session.id);
          const existing = store.getSession(parsed.session.id);
          if (!options.full && existing?.fingerprint && existing.fingerprint === parsed.session.fingerprint) {
            providerSessions.push(existing);
            continue;
          }
          store.replaceProviderSession(parsed.session, parsed.turns, parsed.items, parsed.usage, parsed.evidence);
          providerSessions.push(parsed.session);
        }
        if (!result.error && !result.truncated) {
          store.pruneProvider(provider, result.hostId, seen, new Set(result.skippedStoreLabels));
          // Unchanged files are skipped by the scan, so result.count only
          // reflects new/changed sessions; show the store's real total.
          store.updateSourceCount(provider, result.hostId, store.countProviderSessions(provider, result.hostId));
        }
        // Persist the skip-cache for every listed file and forget paths that
        // disappeared from disk.
        for (const [path, info] of result.files) {
          store.upsertSourceFile(provider, result.hostId, path, info.fingerprint, info.sessionId);
        }
        if (!result.error && !result.truncated) store.pruneSourceFiles(provider, result.hostId, new Set(result.files.keys()));
        done += 1;
        job = { ...job, done };
        publish(job);
      }
      if (current.excludeCodexBar) store.pruneCodexBarSessions();

      job = { ...job, phase: "bb-thread-scan", provider: null, done, total: wanted.length + 1 };
      publish(job);
      const bbResult = await indexBbThreads(bb, store, { full: options.full, includeArchived: current.includeArchived, log: (message) => bb.log.warn(message) });
      store.pruneRetention(current.retentionDays);
      const all = store.getSessions();
      const bbSessions = all.filter((session) => session.source === "bb");
      const explicit = bbResult.explicitProviderIds;
      for (const session of bbSessions) {
        if (session.providerSessionId) {
          const key = explicitProviderLinkKey(session.provider, session.hostId, session.providerSessionId);
          if (!explicit.has(key)) explicit.set(key, { bbThreadId: session.bbThreadId ?? session.id.replace(/^bb:/, ""), sourceSequence: null });
        }
      }
      const links = linkProviderSessions(all.filter((session) => session.source === "provider"), bbSessions, explicit);
      store.replaceLinks(links);
      const linkedSessions = filterSessionsForSettings(store.getSessions(), current);
      const findings = findingsFor(linkedSessions, store.getSources(), { view: "unified", range: "lifetime" }, Date.now());
      store.replaceFindings(findings);
      lastIndexedAt = Date.now();
      lastError = null;
      await bb.storage.kv.set("lastIndexedAt", lastIndexedAt);
      job = { active: false, phase: "done", provider: null, done: wanted.length + 1, total: wanted.length + 1 };
      publish({ ...job, totalSessions: linkedSessions.length, indexed: bbResult.indexed });
    })().catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      job = { ...job, active: false, phase: "error", provider: null };
      publish({ ...job, error: lastError });
      bb.log.error(`telemetry index failed: ${lastError}`);
    });
    running = task;
    void task.finally(() => {
      if (running !== task) return;
      running = null;
      const pending = queued;
      queued = null;
      if (pending) {
        void sync(pending.options).then(pending.resolve, pending.reject);
      }
    });
    return task;
  }

  async function status() {
    const current = await getSettings();
    const host = await resolveHost(bb, current.hostId);
    const sources = store.getSources();
    const resolvedHosts = new Map<string, Promise<Awaited<ReturnType<typeof resolveHost>>>>();
    const sourceHost = (requestedHostId: string): Promise<Awaited<ReturnType<typeof resolveHost>>> => {
      const effectiveHostId = requestedHostId || host.id;
      const existing = resolvedHosts.get(effectiveHostId);
      if (existing) return existing;
      const resolved = effectiveHostId === host.id
        ? Promise.resolve(host)
        : resolveHost(bb, effectiveHostId);
      resolvedHosts.set(effectiveHostId, resolved);
      return resolved;
    };
    const sourceRows: SourceStatusRecord[] = await Promise.all(PROVIDER_SOURCES.map(async (source) => {
      const configuredHostId = current.sources[source.id].hostId || current.hostId;
      const selectedHost = await sourceHost(configuredHostId);
      const configuredPath = current.sources[source.id].path;
      const pathLabel = source.archivePath && source.archivePath !== configuredPath
        ? `${configuredPath} + ${source.archivePath}`
        : configuredPath;
      const stored = sources.find((row) => row.provider === source.id && row.hostId === selectedHost.id);
      return stored ? {
        ...stored,
        enabled: current.sources[source.id].enabled,
        pathLabel,
      } : {
        id: `${source.id}:${selectedHost.id}`,
        provider: source.id,
        label: source.label,
        hostId: selectedHost.id,
        storeKind: source.storeKind,
        pathLabel,
        enabled: current.sources[source.id].enabled,
        detected: false,
        supported: false,
        count: 0,
        capabilities: { metadata: "unavailable", turns: "unavailable", tools: "unavailable", tokens: "unavailable", context: "unavailable", errors: "unavailable", latency: "unavailable", models: "unavailable" } as SourceStatusRecord["capabilities"],
        cursor: null,
        lastSuccessAt: null,
        lastError: null,
        lastWarning: null,
        remoteDatabaseUnsupported: false,
      };
    }));
    const sessions = filterSessionsForSettings(store.getSessions(), current);
    const now = Date.now();
    const input: DashboardInput = { view: current.defaultView, range: current.defaultRange };
    const dashboard = buildDashboard(sessions, store.getItemsForSessions(new Set(sessions.map((session) => session.id))), findingsFor(sessions, sourceRows, input, now), sourceRows, input, now, current.priceOverrides);
    return {
      generatedAt: Date.now(),
      sources: sourceRows,
      providers: dashboard.providers,
      defaultView: current.defaultView,
      defaultRange: current.defaultRange,
      totalSessions: sessions.length,
      lastIndexedAt,
      error: lastError,
      indexing: job,
    };
  }

  bb.rpc.register(rpcContract, {
    async status() { return status(); },
    async dashboard(input) {
      const current = await getSettings();
      const sources = store.getSources();
      const sessions = filterSessionsForSettings(store.getSessions(), current);
      const validProviders = (input.providers ?? []).filter(isProviderId) as ProviderId[];
      const normalized: DashboardInput = { ...input, range: input.range, view: input.view, providers: validProviders };
      const now = Date.now();
      return buildDashboard(sessions, store.getItemsForSessions(new Set(sessions.map((session) => session.id))), findingsFor(sessions, sources, normalized, now), sources, normalized, now, current.priceOverrides);
    },
    async listSessions(input) {
      const current = await getSettings();
      const sessions = filterSessionsForSettings(store.getSessions(), current);
      const validProviders = (input.providers ?? []).filter(isProviderId) as ProviderId[];
      const normalized: DashboardInput = { ...input, providers: validProviders };
      const filtered = sessionFilter(sessions, normalized, Date.now());
      const offset = input.offset ?? 0;
      return { sessions: filtered.slice(offset, offset + (input.limit ?? 100)).map((session) => withSessionCost(session, current.priceOverrides)), total: filtered.length };
    },
    async reindex(input) {
      const providers = (input.providers ?? []).filter(isProviderId) as ProviderId[];
      if (input.clear) {
        store.clearAll();
        bb.log.info("Telemetry store cleared; rescanning everything.");
      }
      void sync({ full: input.full || Boolean(input.clear), providers: providers.length ? providers : undefined, hostId: input.hostId }).catch(() => undefined);
      return { started: true };
    },
    async findings(input) {
      const current = await getSettings();
      const validProviders = (input.providers ?? []).filter(isProviderId) as ProviderId[];
      const normalized: DashboardInput = { ...input, providers: validProviders };
      const sources = store.getSources();
      const now = Date.now();
      let findings = findingsFor(filterSessionsForSettings(store.getSessions(), current), sources, normalized, now);
      if (input.severity) findings = findings.filter((finding) => finding.severity === input.severity);
      const offset = 0;
      return { findings: findings.slice(offset, input.limit ?? 100), total: findings.length };
    },
  });

  bb.cli.register({
    name: "telemetry",
    summary: "Compare provider sessions and bb agent telemetry",
    commands: [
      { name: "status", summary: "Show source health and index status", usage: "bb telemetry status [--json]" },
      { name: "providers", summary: "Show provider-specific summaries", usage: "bb telemetry providers [--json]" },
      { name: "reindex", summary: "Scan provider stores and bb threads", usage: "bb telemetry reindex [--full] [--clear] [--provider <id>] [--machine <hostId>] [--json]" },
      { name: "summary", summary: "Show provider-aware telemetry totals", usage: "bb telemetry summary [--view provider|unified|bb] [--provider <id>] [--range 7d] [--json]" },
      { name: "prices", summary: "Show the effective model price table", usage: "bb telemetry prices [--refresh] [--model <id>] [--json]" },
      { name: "findings", summary: "Show evidence-backed findings", usage: "bb telemetry findings [--provider <id>] [--range 7d] [--severity warning] [--json]" },
    ],
    async run(argv) {
      const [command, ...rest] = argv;
      const jsonOutput = hasFlag(rest, "--json");
      const output = (value: unknown, human: string) => ({ exitCode: 0, stdout: `${jsonOutput ? JSON.stringify(value, null, 2) : human}\n` });
      if (command === "status") {
        const result = await status();
        const human = [
          `Sessions indexed: ${result.totalSessions}`,
          `Last index: ${result.lastIndexedAt ? new Date(result.lastIndexedAt).toISOString() : "never"}`,
          result.indexing.active ? `Indexing: ${result.indexing.phase} ${result.indexing.done}/${result.indexing.total}` : "Indexing: idle",
          ...result.sources.map((source) => `  ${source.label} [${source.provider}] — ${source.detected ? `${source.count} records` : "not detected"}; ${source.enabled ? "enabled" : "disabled"}${source.lastError ? `; ${source.lastError}` : ""}${source.lastWarning ? `; ${source.lastWarning}` : ""}`),
        ].join("\n");
        return output(result, human);
      }
      if (command === "providers") {
        const result = await status();
        return output({ providers: result.providers }, result.providers.map((provider) => `${String(provider.label)} [${String(provider.provider)}] — ${String(provider.sessions)} sessions, ${String(provider.turns)} turns, cost ${provider.costUsd === null ? "Not available" : formatUsd(provider.costUsd)}${provider.costEstimated ? " (estimated)" : ""}`).join("\n"));
      }
      if (command === "reindex") {
        const provider = cliFlag(rest, "--provider");
        if (provider && !isProviderId(provider)) return { exitCode: 2, stderr: `Unknown provider: ${provider}\n` };
        if (hasFlag(rest, "--clear")) {
          store.clearAll();
          bb.log.info("Telemetry store cleared; rescanning everything.");
        }
        await sync({ full: hasFlag(rest, "--full") || hasFlag(rest, "--clear"), providers: provider ? [provider as ProviderId] : undefined, hostId: cliFlag(rest, "--machine") });
        return output({ started: true, status: await status() }, "Telemetry index refreshed.");
      }
      if (command === "summary") {
        const current = await getSettings();
        const viewArg = cliFlag(rest, "--view");
        const rangeArg = cliFlag(rest, "--range");
        if (viewArg && !isDashboardView(viewArg)) return { exitCode: 2, stderr: "--view must be provider, unified, or bb\n" };
        if (rangeArg && !isRangeId(rangeArg)) return { exitCode: 2, stderr: "--range must be 1h, 6h, 24h, 7d, 30d, or lifetime\n" };
        const view = viewArg && isDashboardView(viewArg) ? viewArg : current.defaultView;
        const range = rangeArg && isRangeId(rangeArg) ? rangeArg : current.defaultRange;
        const provider = cliFlag(rest, "--provider");
        if (provider && !isProviderId(provider)) return { exitCode: 2, stderr: `Unknown provider: ${provider}\n` };
        const input: DashboardInput = { view, range, providers: provider && isProviderId(provider) ? [provider] : undefined };
        const sessions = filterSessionsForSettings(store.getSessions(), current);
        const sources = store.getSources();
        const now = Date.now();
        const result = buildDashboard(sessions, store.getItemsForSessions(new Set(sessions.map((session) => session.id))), findingsFor(sessions, sources, input, now), sources, input, now, current.priceOverrides);
        const human = [`View: ${view}`, `Range: ${range}`, `Sessions: ${result.totals.sessions}`, `Turns: ${result.totals.turns}`, `Tool errors: ${result.totals.toolErrors}/${result.totals.toolCalls}`, `Total tokens: ${result.totals.totalTokens ?? "Not available"}`, `Estimated cost: ${result.totals.costUsd === null ? "Not available" : formatUsd(result.totals.costUsd)}${result.totals.costEstimated ? " (some models use fallback pricing)" : ""}`, ...result.providers.filter((provider) => provider.sampleSize > 0).map((provider) => `  ${provider.label} [${provider.provider}] — ${provider.sessions} sessions, ${provider.turns} turns, tokens ${provider.totalTokens ?? "Not available"}, cost ${provider.costUsd === null ? "Not available" : formatUsd(provider.costUsd)}${provider.costEstimated ? " (estimated)" : ""}`)].join("\n");
        return output(result, human);
      }
      if (command === "prices") {
        if (hasFlag(rest, "--refresh")) await refreshPrices(true);
        const current = await getSettings();
        const modelArg = cliFlag(rest, "--model");
        const cached = store.getPriceCache<Record<string, ModelPrice>>(PRICE_CACHE_KEY);
        const sourceLine = cached
          ? `Source: models.dev (fetched ${new Date(cached.updatedAt).toISOString()}, ${Object.keys(cached.value).length} models)`
          : "Source: bundled fallback table (models.dev not fetched yet; run with --refresh)";
        if (modelArg) {
          const lookup = lookupModelPrice(modelArg, current.priceOverrides);
          if (!lookup) return output({ model: modelArg, price: null }, `No price found for ${modelArg}; provider fallback pricing applies.`);
          const human = `${sourceLine}\n${lookup.model} (${lookup.origin}): ${formatUsd(lookup.price.inputPerM)}/M in, ${formatUsd(lookup.price.cachedInputPerM)}/M cached, ${formatUsd(lookup.price.outputPerM)}/M out`;
          return output({ model: lookup.model, origin: lookup.origin, price: lookup.price }, human);
        }
        const table = currentPriceTable();
        const fallbacks = providerFallbackPrices();
        const overrides = current.priceOverrides;
        const human = [
          sourceLine,
          `Models priced: ${Object.keys(table).length}`,
          ...Object.entries(fallbacks).map(([provider, fallback]) => `${PROVIDER_LABELS[provider as ProviderId] ?? provider} [${provider}] fallback: ${formatUsd(fallback.inputPerM)}/M in, ${formatUsd(fallback.cachedInputPerM)}/M cached, ${formatUsd(fallback.outputPerM)}/M out`),
          ...Object.entries(overrides).flatMap(([provider, models]) => Object.entries(models).map(([model, price]) => `  ${model} [${provider}] (override): ${formatUsd(price.inputPerM)}/M in, ${formatUsd(price.cachedInputPerM)}/M cached, ${formatUsd(price.outputPerM)}/M out`)),
          "Use --model <id> to look up one model, or --json for the full table.",
        ].join("\n");
        return output({ source: cached ? "models-dev" : "bundled", fetchedAt: cached?.updatedAt ?? null, modelCount: Object.keys(table).length, fallbacks, overrides, models: table }, human);
      }
      if (command === "findings") {
        const current = await getSettings();
        const provider = cliFlag(rest, "--provider");
        const rangeArg = cliFlag(rest, "--range");
        const severity = cliFlag(rest, "--severity");
        if (provider && !isProviderId(provider)) return { exitCode: 2, stderr: `Unknown provider: ${provider}\n` };
        if (rangeArg && !isRangeId(rangeArg)) return { exitCode: 2, stderr: "--range must be 1h, 6h, 24h, 7d, 30d, or lifetime\n" };
        if (severity && !isSeverity(severity)) return { exitCode: 2, stderr: "--severity must be info, warning, or critical\n" };
        const range = rangeArg && isRangeId(rangeArg) ? rangeArg : current.defaultRange;
        const input: DashboardInput = { view: "provider", range, providers: provider && isProviderId(provider) ? [provider] : undefined };
        const sessions = filterSessionsForSettings(store.getSessions(), current);
        let findings = findingsFor(sessions, store.getSources(), input, Date.now());
        if (severity) findings = findings.filter((finding) => finding.severity === severity);
        return output({ findings, total: findings.length }, findings.length ? findings.map((finding) => `[${finding.severity}] ${finding.title} — ${finding.summary}`).join("\n") : "No findings.");
      }
      return { exitCode: 1, stderr: "Unknown command. Try: status | providers | reindex | summary | prices | findings\n" };
    },
  });

  for (const event of ["thread.created", "thread.active", "thread.idle", "thread.failed", "thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, () => { void sync({ full: false }).catch(() => undefined); });
  }

  bb.background.service("indexer", {
    async start(signal) {
      const current = await getSettings();
      if (current.autoIndex) {
        await refreshPrices(false);
        await sync({ full: false });
      }
      while (!signal.aborted) {
        await sleep(5 * 60 * 1000, signal);
        if (!signal.aborted && (await getSettings()).autoIndex) {
          await refreshPrices(false);
          await sync({ full: false });
        }
      }
    },
  });

  if ((await getSettings()).autoIndex && !lastIndexedAt) void sync({ full: false }).catch(() => undefined);
  bb.onDispose(() => store.dispose());
}

export type { DashboardInput, FindingRecord, SourceKind };
