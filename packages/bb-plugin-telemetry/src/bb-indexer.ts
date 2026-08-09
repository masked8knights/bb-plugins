import type { BbPluginApi } from "@bb/plugin-sdk";
import { canonicalProvider } from "./source-registry";
import { normalizeBbEvent } from "./normalize-events";
import { AnalyticsStore } from "./db";
import { explicitProviderLinkKey } from "./linker";
import type {
  EvidenceRef,
  NormalizedBbEvent,
  NormalizedItem,
  NormalizedTurn,
  ProviderSessionRecord,
  UsageSnapshot,
} from "./types";

type RecordLike = Record<string, unknown>;

function record(value: unknown): RecordLike {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : {};
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function numberValue(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function contextRatio(used: number | null, limit: number | null): number | null {
  if (used === null) return null;
  if (limit !== null && limit > 0) return used / limit;
  return used >= 0 && used <= 1 ? used : null;
}

function threadList(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const value = record(result);
  return Array.isArray(value.threads) ? value.threads : Array.isArray(value.items) ? value.items : [];
}

function eventRows(result: unknown): unknown[] {
  return Array.isArray(result) ? result : Array.isArray(record(result).events) ? (record(result).events as unknown[]) : [];
}

const THREAD_EVENT_PAGE_SIZE = 1000;

async function listThreadEvents(
  bb: BbPluginApi,
  threadId: string,
  afterSeq?: number,
): Promise<unknown[]> {
  const events: unknown[] = [];
  let cursor = afterSeq ?? 0;
  for (let page = 0; page < 100; page += 1) {
    const response = await bb.sdk.threads.events.list({
      threadId,
      afterSeq: cursor > 0 ? String(cursor) : undefined,
      limit: String(THREAD_EVENT_PAGE_SIZE),
    });
    const rows = eventRows(response);
    if (!rows.length) break;
    events.push(...rows);
    const nextCursor = rows.reduce<number>((max, row) => Math.max(max, normalizeBbEvent(row).sourceSequence), cursor);
    if (rows.length < THREAD_EVENT_PAGE_SIZE || nextCursor <= cursor) break;
    cursor = nextCursor;
  }
  return events;
}

function eventStatus(event: NormalizedBbEvent): NormalizedTurn["status"] {
  if (event.status?.includes("fail") || event.errorCategory) return "failed";
  if (event.status?.includes("complete") || event.status?.includes("success") || event.eventType.includes("completed")) return "completed";
  if (event.status?.includes("run") || event.eventType.includes("started")) return "active";
  return "unknown";
}

function threadStatus(value: unknown): ProviderSessionRecord["status"] {
  const status = stringValue(value)?.toLowerCase();
  if (status === "error" || status === "failed") return "failed";
  if (status === "idle" || status === "completed") return "completed";
  if (status === "active" || status === "starting" || status === "stopping") return "active";
  return "unknown";
}

function deriveThreadSession(thread: RecordLike, events: NormalizedBbEvent[]): {
  session: ProviderSessionRecord;
  turns: NormalizedTurn[];
  items: NormalizedItem[];
  usage: UsageSnapshot[];
  evidence: EvidenceRef[];
} {
  const id = stringValue(thread.id) ?? "unknown";
  const provider = canonicalProvider(stringValue(thread.providerId, thread.provider_id));
  const host = record(thread.host);
  const environment = record(thread.environment);
  const session: ProviderSessionRecord = {
    id: `bb:${id}`,
    source: "bb",
    provider,
    hostId: stringValue(thread.environmentHostId, host.id) ?? "primary",
    providerSessionId: events.find((event) => event.providerSessionId)?.providerSessionId ?? null,
    bbThreadId: id,
    title: stringValue(thread.title, thread.titleFallback) ?? "Untitled bb thread",
    cwd: stringValue(environment.path, environment.workspacePath, thread.cwd, thread.workspacePath, thread.workingDirectory),
    projectId: stringValue(thread.projectId, thread.project_id),
    model: stringValue(thread.model, thread.modelName, thread.providerModel, thread.provider_model),
    origin: stringValue(thread.originPluginId, thread.originKind) ?? "bb",
    status: threadStatus(thread.status),
    startedAt: numberValue(thread.createdAt, thread.created_at),
    updatedAt: numberValue(thread.updatedAt, thread.updated_at, thread.createdAt),
    durationMs: null,
    messageCount: 0,
    turnCount: 0,
    toolCalls: 0,
    toolErrors: 0,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    contextPeak: null,
    compactionCount: 0,
    failureCount: 0,
    delegatedCount: 0,
    archived: Boolean(thread.isArchived ?? thread.archived ?? thread.archivedAt != null),
    coverage: {
      metadata: "complete",
      turns: "unavailable",
      tools: "unavailable",
      tokens: "unavailable",
      context: "unavailable",
      errors: "unavailable",
      latency: "unavailable",
      models: "unavailable",
    },
    storeLabel: "bb event stream",
    fingerprint: null,
    linkState: "none",
    findingCount: 0,
  };
  const turns = new Map<string, NormalizedTurn>();
  const items = new Map<string, NormalizedItem>();
  const usage: UsageSnapshot[] = [];
  const evidence: EvidenceRef[] = [];
  const messageIds = new Set<string>();
  for (const event of events) {
    evidence.push({ source: "bb", sourceRecordId: session.id, sourceSequence: event.sourceSequence, eventType: event.eventType, at: event.at });
    if (event.classification === "turn" || event.turnId) {
      const turnId = event.turnId ?? `turn-${event.sourceSequence}`;
      const turn = turns.get(turnId) ?? {
        id: turnId,
        startedAt: event.at,
        endedAt: null,
        status: "unknown",
        durationMs: null,
        steps: 0,
        toolCalls: 0,
        toolErrors: 0,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        contextPeak: null,
        sourceSequenceStart: event.sourceSequence,
        sourceSequenceEnd: event.sourceSequence,
      } satisfies NormalizedTurn;
      turn.steps += 1;
      turn.sourceSequenceEnd = event.sourceSequence;
      const status = eventStatus(event);
      if (status !== "unknown") turn.status = status;
      if (event.eventType.includes("started")) turn.startedAt = event.at ?? turn.startedAt;
      if (event.eventType.includes("completed") || event.eventType.includes("failed")) {
        turn.endedAt = event.at;
        turn.durationMs = event.durationMs ?? (turn.startedAt !== null && event.at !== null ? Math.max(0, event.at - turn.startedAt) : null);
      }
      turns.set(turnId, turn);
    }
    if (event.classification === "tool") {
      const id = event.itemId ?? `item-${event.sourceSequence}`;
      const status = eventStatus(event) === "failed" ? "failed" : eventStatus(event) === "completed" ? "completed" : "unknown";
      const previous = items.get(id);
      items.set(id, previous ? {
        ...previous,
        ...{
          turnId: event.turnId ?? previous.turnId,
          toolName: event.toolName ?? previous.toolName,
          status: status === "unknown" ? previous.status : status,
          durationMs: event.durationMs ?? previous.durationMs,
          errorCategory: event.errorCategory,
          approvalStatus: event.approvalStatus ?? previous.approvalStatus,
          sourceSequence: event.sourceSequence,
          at: event.at ?? previous.at,
        },
      } : {
        sessionId: session.id,
        id,
        turnId: event.turnId,
        kind: "tool",
        toolName: event.toolName,
        status,
        durationMs: event.durationMs,
        errorCategory: event.errorCategory,
        approvalStatus: event.approvalStatus,
        sourceSequence: event.sourceSequence,
        at: event.at,
      });
    }
    if (event.classification === "usage" || event.inputTokens !== null || event.totalTokens !== null || event.contextUsed !== null) {
      usage.push({
        turnId: event.turnId,
        inputTokens: event.inputTokens,
        cachedInputTokens: event.cachedInputTokens,
        outputTokens: event.outputTokens,
        reasoningTokens: event.reasoningTokens,
        totalTokens: event.totalTokens,
        contextUsed: event.contextUsed,
        contextLimit: event.contextLimit,
        estimated: event.estimated,
        sourceSequence: event.sourceSequence,
        at: event.at,
      });
      if (event.turnId) {
        const turn = turns.get(event.turnId);
        if (turn) {
          turn.inputTokens = event.inputTokens;
          turn.cachedInputTokens = event.cachedInputTokens;
          turn.outputTokens = event.outputTokens;
          turn.reasoningTokens = event.reasoningTokens;
          turn.totalTokens = event.totalTokens;
          turn.contextPeak = contextRatio(event.contextUsed, event.contextLimit);
        }
      }
    }
    if (event.classification === "context" && event.eventType.includes("compact")) session.compactionCount += 1;
    if (event.classification === "delegation") session.delegatedCount += 1;
    if (event.eventType.toLowerCase().includes("message")) {
      const messageKey = event.messageId ?? event.itemId
        ?? (event.eventType.toLowerCase().includes("delta") ? `turn:${event.turnId ?? "unknown"}` : `event:${event.sourceSequence}`);
      messageIds.add(messageKey);
    }
    if (event.errorCategory && event.classification !== "tool") session.failureCount += 1;
  }
  const itemRows = [...items.values()];
  session.turnCount = turns.size;
  session.messageCount = messageIds.size;
  session.toolCalls = itemRows.length;
  session.toolErrors = itemRows.filter((item) => item.status === "failed" || item.errorCategory).length;
  for (const turn of turns.values()) {
    const turnItems = itemRows.filter((item) => item.turnId === turn.id);
    turn.toolCalls = turnItems.length;
    turn.toolErrors = turnItems.filter((item) => item.status === "failed" || item.errorCategory).length;
  }
  const latestByTurn = new Map<string, UsageSnapshot>();
  for (const row of usage) latestByTurn.set(row.turnId ?? `seq-${row.sourceSequence}`, row);
  const latest = [...latestByTurn.values()];
  const sum = (key: keyof UsageSnapshot): number | null => {
    const values = latest.map((row) => row[key]).filter((value): value is number => typeof value === "number");
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  session.inputTokens = sum("inputTokens");
  session.cachedInputTokens = sum("cachedInputTokens");
  session.outputTokens = sum("outputTokens");
  session.reasoningTokens = sum("reasoningTokens");
  session.totalTokens = sum("totalTokens");
  const contexts = latest.map((row) => contextRatio(row.contextUsed, row.contextLimit)).filter((value): value is number => typeof value === "number");
  session.contextPeak = contexts.length ? Math.max(...contexts) : null;
  session.coverage.turns = turns.size ? "complete" : "unavailable";
  session.coverage.tools = itemRows.length ? "complete" : "unavailable";
  session.coverage.tokens = usage.some((row) => row.totalTokens !== null || row.inputTokens !== null) ? "complete" : "unavailable";
  session.coverage.context = contexts.length ? "complete" : "unavailable";
  session.coverage.errors = session.failureCount ? "complete" : "partial";
  session.coverage.latency = [...turns.values()].some((turn) => turn.durationMs !== null) || itemRows.some((item) => item.durationMs !== null) ? "complete" : "unavailable";
  session.durationMs = session.startedAt !== null && session.updatedAt !== null ? Math.max(0, session.updatedAt - session.startedAt) : null;
  return { session, turns: [...turns.values()], items: itemRows, usage, evidence };
}

export async function indexBbThreads(
  bb: BbPluginApi,
  store: AnalyticsStore,
  options: { includeArchived: boolean; full?: boolean; log: (message: string) => void },
): Promise<{ sessions: ProviderSessionRecord[]; explicitProviderIds: Map<string, { bbThreadId: string; sourceSequence: number | null }>; indexed: number }> {
  const sessions: ProviderSessionRecord[] = [];
  const explicitProviderIds = new Map<string, { bbThreadId: string; sourceSequence: number | null }>();
  let offset = 0;
  let indexed = 0;
  for (;;) {
    const listed = await bb.sdk.threads.list({
      archived: options.includeArchived ? undefined : false,
      includeHidden: true,
      limit: 100,
      offset,
    });
    const rows = threadList(listed);
    if (!rows.length) break;
    for (const rawThread of rows) {
      const thread = record(rawThread);
      const threadId = stringValue(thread.id);
      if (!threadId) continue;
      const sessionId = `bb:${threadId}`;
      const lastSeq = store.latestEventSequence(sessionId);
      let incoming = [] as unknown[];
      try {
        incoming = options.full || lastSeq === 0
          ? await listThreadEvents(bb, threadId)
          : await listThreadEvents(bb, threadId, lastSeq);
      } catch (error) {
        options.log(`telemetry: failed to read bb events for ${threadId}: ${String(error)}`);
      }
      if (lastSeq > 0 && incoming.length > 0) {
        incoming = await listThreadEvents(bb, threadId);
      }
      if (lastSeq > 0 && incoming.length === 0) {
        const existing = store.getSession(sessionId);
        if (existing) {
          const refreshed = deriveThreadSession(thread, []).session;
          const metadata = {
            ...existing,
            provider: refreshed.provider,
            hostId: refreshed.hostId,
            title: refreshed.title,
            cwd: refreshed.cwd ?? existing.cwd,
            projectId: refreshed.projectId ?? existing.projectId,
            origin: refreshed.origin,
            status: refreshed.status,
            startedAt: refreshed.startedAt ?? existing.startedAt,
            updatedAt: refreshed.updatedAt ?? existing.updatedAt,
            archived: refreshed.archived,
            model: refreshed.model ?? existing.model,
          } satisfies ProviderSessionRecord;
          store.updateBbSessionMetadata(metadata);
          sessions.push(metadata);
        }
        continue;
      }
      const normalized = incoming.map(normalizeBbEvent).filter((event) => event.sourceSequence > 0);
      const derived = deriveThreadSession(thread, normalized);
      store.replaceBbSession(derived.session, normalized, derived.turns, derived.items, derived.usage, derived.evidence);
      sessions.push(derived.session);
      indexed += 1;
      for (const event of normalized) {
        if (event.providerSessionId) {
          explicitProviderIds.set(
            explicitProviderLinkKey(derived.session.provider, derived.session.hostId, event.providerSessionId),
            { bbThreadId: threadId, sourceSequence: event.sourceSequence },
          );
        }
      }
    }
    offset += rows.length;
    if (rows.length < 100) break;
  }
  return { sessions, explicitProviderIds, indexed };
}
