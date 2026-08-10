import {
  emptyCapabilities,
  type CapabilityName,
  type CapabilityReport,
  type NormalizedItem,
  type NormalizedTurn,
  type ParsedProviderSession,
  type ProviderId,
  type ProviderSessionRecord,
  type SessionStatus,
  type UsageSnapshot,
} from "../types";

type JsonRecord = Record<string, unknown>;

/** Whole-content reads (remote hosts) are capped; the primary host streams files line-by-line instead. */
export const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
/** A single line larger than this (corrupt file) is skipped instead of parsed whole. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function numberValue(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function booleanValue(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return null;
}

function timestamp(value: unknown): number | null {
  const numeric = numberValue(value);
  if (numeric !== null) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function nested(record: JsonRecord, ...keys: string[]): unknown {
  let current: unknown = record;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as JsonRecord)[key];
  }
  return current;
}

function payload(record: JsonRecord): JsonRecord {
  return asRecord(record.payload);
}

function contentBlocks(record: JsonRecord): JsonRecord[] {
  const candidates = [
    record.content,
    nested(record, "message", "content"),
    nested(record, "payload", "content"),
    nested(record, "payload", "message", "content"),
    nested(record, "data", "content"),
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.map(asRecord).filter((value) => Object.keys(value).length > 0);
  }
  const nestedPayload = payload(record);
  const payloadType = stringValue(nestedPayload.type)?.toLowerCase();
  if (payloadType && ["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "tool_use", "tool_result", "tool_call", "tool_result"].includes(payloadType)) {
    return [nestedPayload];
  }
  return [];
}

function anyNested(record: JsonRecord, paths: string[][]): unknown[] {
  return paths.map((path) => nested(record, ...path));
}

function eventType(record: JsonRecord): string {
  const base = stringValue(
    record.type,
    record.event,
    record.kind,
    nested(record, "event", "type"),
  ) ?? "record";
  const detail = stringValue(nested(record, "payload", "type"), nested(record, "event", "payload", "type"));
  return (detail && ["event_msg", "response_item"].includes(base.toLowerCase()) ? `${base}/${detail}` : base).toLowerCase();
}

function eventTimestamp(record: JsonRecord): number | null {
  for (const value of [
    record.timestamp,
    record.createdAt,
    record.created_at,
    record.time,
    record.ts,
    nested(record, "event", "timestamp"),
    nested(record, "message", "timestamp"),
  ]) {
    const parsed = timestamp(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function sessionId(record: JsonRecord, fallback: string): string {
  const type = eventType(record);
  return (
    stringValue(
      record.session_id,
      record.sessionId,
      record.thread_id,
      record.threadId,
      nested(record, "session", "id"),
      nested(record, "session", "sessionId"),
      nested(record, "payload", "session_id"),
      nested(record, "payload", "sessionId"),
      type === "session_meta" || type === "session" || type.endsWith("/session")
        ? nested(record, "payload", "id")
        : undefined,
      type === "session" || type.endsWith("/session") ? record.id : undefined,
    ) ?? fallback
  );
}

function turnId(record: JsonRecord, fallback: string): string | null {
  return stringValue(
    record.turn_id,
    record.turnId,
    record.run_id,
    record.runId,
    nested(record, "turn", "id"),
    nested(record, "turn", "turnId"),
    nested(record, "item", "turnId"),
    nested(record, "payload", "turn_id"),
    nested(record, "payload", "turnId"),
    nested(record, "payload", "turn", "id"),
    fallback,
  );
}

function statusFor(type: string, record: JsonRecord): SessionStatus {
  const blocks = contentBlocks(record);
  const failedBlock = blocks.some((block) => Boolean(block.is_error ?? block.isError) || stringValue(block.status)?.toLowerCase().includes("fail"));
  const completedBlock = blocks.some((block) => ["tool_result", "function_call_output", "custom_tool_call_output"].includes(stringValue(block.type)?.toLowerCase() ?? ""));
  const activeBlock = blocks.some((block) => ["tool_use", "tool_call", "function_call", "custom_tool_call"].includes(stringValue(block.type)?.toLowerCase() ?? ""));
  // Pi/omp report lifecycle in `status.taskState` (agent_status) and
  // `state.status` (session_state); omp closes sessions with a
  // `customType: "session_exit"` event.
  const taskState = stringValue(nested(record, "status", "taskState"))?.toLowerCase();
  const explicit = stringValue(record.status, nested(record, "turn", "status"), nested(record, "payload", "status"), nested(record, "state", "status"), taskState, record.customType, ...blocks.map((block) => block.status))?.toLowerCase();
  if (failedBlock) return "failed";
  if (completedBlock) return "completed";
  if (activeBlock) return "active";
  if (explicit?.includes("fail") || explicit?.includes("error")) return "failed";
  if (explicit?.includes("active") || explicit?.includes("run") || explicit?.includes("working") || explicit?.includes("busy") || explicit?.includes("in_progress")) return "active";
  // Pi/omp end each completed turn in `needs_input` (waiting on the user).
  if (explicit?.includes("complete") || explicit?.includes("success") || explicit?.includes("needs_input") || explicit === "idle" || explicit?.includes("exit")) {
    return "completed";
  }
  if (type.includes("error") || type.includes("fail") || type.includes("exception")) {
    return "failed";
  }
  if (type.includes("complete") || type.includes("finish") || type.includes("stop")) {
    return "completed";
  }
  if (type.includes("start") || type.includes("begin")) {
    return "active";
  }
  return "unknown";
}

function providerSessionTitle(record: JsonRecord, provider: ProviderId): string | null {
  const type = eventType(record);
  return stringValue(
    record.title,
    record.displayName,
    record.aiTitle,
    nested(record, "session", "title"),
    nested(record, "session", "name"),
    nested(record, "payload", "title"),
    nested(record, "payload", "name"),
    type === "session" ? record.name : undefined,
    provider === "omp" ? nested(record, "metadata", "title") : undefined,
  );
}

function modelName(record: JsonRecord): string | null {
  return stringValue(
    record.model,
    record.modelId,
    record.model_id,
    record.modelName,
    nested(record, "model", "id"),
    nested(record, "model", "name"),
    nested(record, "message", "model"),
    nested(record, "payload", "model"),
    nested(record, "payload", "modelId"),
    nested(record, "payload", "model_id"),
    nested(record, "completion", "model"),
    nested(record, "payload", "response", "model"),
    nested(record, "data", "model"),
    // Not a model: payload.model_provider is an API provider name ("openai", …).
  );
}

const USAGE_KEYS = [
  "input_tokens", "inputTokens", "prompt_tokens", "promptTokens", "input",
  "output_tokens", "outputTokens", "completion_tokens", "completionTokens", "output",
  "cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens", "cacheReadInputTokens", "cache_read", "cacheRead",
  "cache_write_input_tokens", "cacheWriteInputTokens", "cache_write", "cacheWrite", "cache_creation_input_tokens",
  "reasoning_tokens", "reasoningTokens", "reasoning_output_tokens", "reasoning",
  "total_tokens", "totalTokens", "total",
  "context_used", "contextUsed", "context_tokens", "context_limit", "contextLimit",
  "cost", "costUsd",
];

function usageObject(record: JsonRecord): JsonRecord {
  const recordPayload = payload(record);
  const candidates = [
    record.usage,
    record.token_usage,
    record.tokenUsage,
    record.tokens,
    nested(record, "message", "usage"),
    nested(record, "data", "usage"),
    nested(record, "result", "usage"),
    nested(record, "completion", "usage"),
    nested(record, "payload", "usage"),
    nested(record, "payload", "token_usage"),
    nested(record, "payload", "response", "usage"),
    nested(record, "payload", "info", "last_token_usage"),
    nested(record, "payload", "info", "total_token_usage"),
    // Last resort: usage keys directly on the record payload. Only accept the
    // payload when it actually carries usage fields so unrelated events don't
    // produce empty snapshots.
    USAGE_KEYS.some((key) => key in recordPayload) ? recordPayload : undefined,
  ];
  return candidates.find((candidate) => candidate && typeof candidate === "object") as JsonRecord ?? {};
}

function usageFrom(record: JsonRecord, sequence: number, at: number | null): UsageSnapshot | null {
  const usage = usageObject(record);
  if (!Object.keys(usage).length) return null;
  const inputTokens = numberValue(
    usage.input_tokens,
    usage.inputTokens,
    usage.prompt_tokens,
    usage.promptTokens,
    usage.input,
  );
  const cachedInputTokens = numberValue(
    usage.cached_input_tokens,
    usage.cachedInputTokens,
    usage.cache_read_input_tokens,
    usage.cacheReadInputTokens,
    usage.cache_read,
    usage.cacheRead,
  );
  const cachedWriteTokens = numberValue(
    usage.cache_write_tokens,
    usage.cacheWriteTokens,
    usage.cache_write,
    usage.cacheWrite,
    usage.cache_creation_input_tokens,
    usage.cacheCreationInputTokens,
  );
  const outputTokens = numberValue(
    usage.output_tokens,
    usage.outputTokens,
    usage.completion_tokens,
    usage.completionTokens,
    usage.output,
  );
  const reasoningTokens = numberValue(
    usage.reasoning_tokens,
    usage.reasoningTokens,
    usage.reasoning_output_tokens,
    usage.reasoning,
  );
  const totalTokens = numberValue(
    usage.total_tokens,
    usage.totalTokens,
    usage.total,
  );
  const contextUsed = numberValue(
    usage.context_used,
    usage.contextUsed,
    usage.context_tokens,
    nested(record, "context", "used"),
    nested(record, "payload", "contextUsed"),
    nested(record, "payload", "context_used"),
  );
  const contextLimit = numberValue(
    usage.context_limit,
    usage.contextLimit,
    nested(record, "context", "limit"),
    nested(record, "payload", "contextLimit"),
    nested(record, "payload", "context_limit"),
    nested(record, "payload", "info", "model_context_window"),
  );
  // Providers that report exact per-message cost (Pi/omp `usage.cost.total`,
  // Claude Code `completion.usage.cost` …) get it recorded directly; the
  // price table is only a fallback for harnesses that omit cost.
  const rawCost = usage.cost ?? usage.costUsd;
  const costUsd =
    typeof rawCost === "number" && Number.isFinite(rawCost) ? rawCost
      : rawCost !== null && typeof rawCost === "object" ? numberValue((rawCost as JsonRecord).total, (rawCost as JsonRecord).cost)
      : null;
  if ([inputTokens, cachedInputTokens, cachedWriteTokens, outputTokens, reasoningTokens, totalTokens, contextUsed, contextLimit, costUsd].every((value) => value === null)) {
    return null;
  }
  return {
    turnId: turnId(record, "") || null,
    inputTokens,
    cachedInputTokens,
    cachedWriteTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    contextUsed,
    contextLimit,
    costUsd,
    costEstimated: costUsd !== null ? false : booleanValue(usage.estimated, record.estimated) ?? false,
    estimated: booleanValue(usage.estimated, record.estimated) ?? false,
    sourceSequence: sequence,
    at,
  };
}

function isToolEvent(type: string, record: JsonRecord): boolean {
  const customType = stringValue(record.customType)?.toLowerCase() ?? "";
  return (
    type.includes("tool") ||
    type.includes("function") ||
    type.includes("command") ||
    customType.startsWith("tool") ||
    typeof record.tool_name === "string" ||
    typeof record.toolName === "string" ||
    typeof nested(record, "data", "toolName") === "string" ||
    typeof nested(record, "tool", "name") === "string" ||
    typeof nested(record, "function", "name") === "string" ||
    contentBlocks(record).some((block) => ["tool_use", "tool_result", "tool_call", "toolcall", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(stringValue(block.type)?.toLowerCase() ?? ""))
  );
}

function toolName(record: JsonRecord): string | null {
  const fromBlock = contentBlocks(record).map((block) => stringValue(
    block.name,
    block.toolName,
    block.tool_name,
    nested(block, "tool", "name"),
    nested(block, "function", "name"),
  )).find((value): value is string => Boolean(value));
  return fromBlock ?? stringValue(
    record.tool_name,
    record.toolName,
    record.name,
    nested(record, "data", "toolName"),
    nested(record, "payload", "name"),
    nested(record, "payload", "toolName"),
    nested(record, "tool", "name"),
    nested(record, "function", "name"),
    nested(record, "item", "name"),
  );
}

function safeCategory(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const normalized = value.trim().toLowerCase();
    if (normalized.includes("permission") || normalized.includes("approval") || normalized.includes("denied")) return "permission";
    if (normalized.includes("timeout")) return "timeout";
    if (normalized.includes("rate") || normalized.includes("limit")) return "rate-limit";
    if (normalized.includes("auth")) return "authentication";
    if (normalized.includes("interrupt") || normalized.includes("cancel")) return "interrupted";
    if (normalized.includes("tool")) return "tool-error";
    if (/^[a-z0-9][a-z0-9._:-]{0,48}$/.test(normalized)) return normalized;
  }
  return null;
}

function errorCategory(record: JsonRecord, type: string): string | null {
  const blockError = contentBlocks(record).some((block) => Boolean(block.is_error ?? block.isError));
  const explicitValues = [
    record.error_category,
    record.errorCategory,
    nested(record, "error", "category"),
    nested(record, "error", "type"),
    nested(record, "payload", "errorCategory"),
    nested(record, "payload", "error_category"),
  ];
  const explicit = safeCategory(...explicitValues);
  if (explicit) return explicit;
  if (explicitValues.some((value) => typeof value === "string" && value.trim())) return "provider-error";
  if (blockError) return "tool-error";
  if (type.includes("permission")) return "permission";
  if (type.includes("timeout")) return "timeout";
  if (type.includes("error") || type.includes("fail")) return "provider-error";
  return null;
}

function fileLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? "provider store";
}

function baseSession(provider: ProviderId, hostId: string, path: string, id: string): ProviderSessionRecord {
  return {
    id: `provider:${hostId}:${provider}:${id}`,
    source: "provider",
    provider,
    hostId,
    providerSessionId: id,
    bbThreadId: null,
    title: `Untitled ${providerLabel(provider)} session`,
    cwd: null,
    projectId: null,
    model: null,
    origin: provider,
    status: "unknown",
    startedAt: null,
    updatedAt: null,
    durationMs: null,
    messageCount: 0,
    turnCount: 0,
    toolCalls: 0,
    toolErrors: 0,
    inputTokens: null,
    cachedInputTokens: null,
    cachedWriteTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    contextPeak: null,
    compactionCount: 0,
    failureCount: 0,
    delegatedCount: 0,
    archived: false,
    costUsd: null,
    costEstimated: false,
    coverage: emptyCapabilities(),
    storeLabel: fileLabel(path),
    sourcePath: path,
    fingerprint: null,
    linkState: "none",
    findingCount: 0,
  };
}

function mergeUsage(session: ProviderSessionRecord, snapshots: UsageSnapshot[]): void {
  const latestByTurn = new Map<string, UsageSnapshot>();
  for (const snapshot of snapshots) {
    const key = snapshot.turnId ?? `sequence:${snapshot.sourceSequence}`;
    const existing = latestByTurn.get(key);
    if (!existing || (snapshot.at ?? 0) >= (existing.at ?? 0)) latestByTurn.set(key, snapshot);
  }
  const values = [...latestByTurn.values()];
  const sum = (key: keyof UsageSnapshot): number | null => {
    const numbers = values.map((value) => value[key]).filter((value): value is number => typeof value === "number");
    return numbers.length ? numbers.reduce((total, value) => total + value, 0) : null;
  };
  session.inputTokens = sum("inputTokens");
  session.cachedInputTokens = sum("cachedInputTokens");
  session.cachedWriteTokens = sum("cachedWriteTokens");
  session.outputTokens = sum("outputTokens");
  session.reasoningTokens = sum("reasoningTokens");
  session.totalTokens = sum("totalTokens");
  const costs = values.map((value) => value.costUsd).filter((value): value is number => typeof value === "number");
  session.costUsd = costs.length ? costs.reduce((total, value) => total + value, 0) : null;
  session.costEstimated = session.costUsd !== null && values.some((value) => value.costEstimated);
  const contexts = values.map(contextRatio).filter((value): value is number => typeof value === "number");
  session.contextPeak = contexts.length ? Math.max(...contexts) : null;
}

function contextRatio(snapshot: UsageSnapshot): number | null {
  if (snapshot.contextUsed === null) return null;
  if (snapshot.contextLimit !== null && snapshot.contextLimit > 0) return snapshot.contextUsed / snapshot.contextLimit;
  return snapshot.contextUsed >= 0 && snapshot.contextUsed <= 1 ? snapshot.contextUsed : null;
}

function applyCoverage(session: ProviderSessionRecord, saw: Set<CapabilityName>): void {
  session.coverage.metadata = session.providerSessionId ? "complete" : "partial";
  session.coverage.turns = session.turnCount ? "complete" : "unavailable";
  session.coverage.tools = saw.has("tools") ? "complete" : "unavailable";
  session.coverage.tokens = saw.has("tokens") ? "complete" : "unavailable";
  session.coverage.context = saw.has("context") ? "complete" : "unavailable";
  session.coverage.errors = saw.has("errors") ? "complete" : "unavailable";
  session.coverage.latency = saw.has("latency") ? "complete" : "unavailable";
  session.coverage.models = session.model ? "complete" : "unavailable";
}

export interface ProviderJsonlParser {
  /** Feed one raw JSONL line. `index` is the 0-based line number. */
  processLine(line: string, index: number): void;
  /** Finalize aggregation once all lines are fed; `fingerprint` is the content hash. */
  finish(fingerprint: string | null): ParsedProviderSession | null;
}

export function createProviderJsonlParser(
  provider: ProviderId,
  hostId: string,
  path: string,
): ProviderJsonlParser {
  const fallbackId = fileLabel(path).replace(/\.jsonl$/i, "") || "unknown";
  let currentSessionId = fallbackId;
  let session = baseSession(provider, hostId, path, currentSessionId);
  const turnMap = new Map<string, NormalizedTurn>();
  const itemMap = new Map<string, NormalizedItem>();
  const usage: UsageSnapshot[] = [];
  const evidence = [] as ParsedProviderSession["evidence"];
  const seen = new Set<CapabilityName>();
  let lastAt: number | null = null;
  let failureEvents = 0;

  const ensureTurn = (id: string, at: number | null): NormalizedTurn => {
    const existing = turnMap.get(id);
    if (existing) return existing;
    const next: NormalizedTurn = {
      id,
      startedAt: at,
      endedAt: null,
      status: "unknown",
      durationMs: null,
      steps: 0,
      toolCalls: 0,
      toolErrors: 0,
      inputTokens: null,
      cachedInputTokens: null,
      cachedWriteTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      contextPeak: null,
      costUsd: null,
      costEstimated: false,
      sourceSequenceStart: null,
      sourceSequenceEnd: null,
    };
    turnMap.set(id, next);
    return next;
  };

  const processLine = (rawLine: string, index: number): void => {
    const line = rawLine.trim();
    if (!line) return;

    // Codex compaction snapshots dominate session file size (multi-MB lines
    // carrying the compressed conversation) but telemetry only uses the event
    // type (compaction counter) and timestamp, so read those off the line
    // head instead of JSON.parse-ing the whole payload.
    if (line.length > 512) {
      const headType = /"type"\s*:\s*"([^"]+)"/.exec(line.slice(0, 512))?.[1]?.toLowerCase();
      if (headType === "compacted") {
        const atMatch = /"timestamp"\s*:\s*(?:"([^"]+)"|(\d+(?:\.\d+)?))/.exec(line.slice(0, 512));
        const at = atMatch ? timestamp(atMatch[1] ?? atMatch[2]) : null;
        if (at !== null) {
          session.startedAt = session.startedAt === null ? at : Math.min(session.startedAt, at);
          lastAt = lastAt === null ? at : Math.max(lastAt, at);
          session.updatedAt = Math.max(session.updatedAt ?? at, at);
        }
        session.compactionCount += 1;
        evidence.push({ source: "provider", sourceRecordId: session.id, sourceSequence: index + 1, eventType: "compacted", at });
        return;
      }
    }

    // A pathological single line (corrupt file) would be buffered and parsed
    // whole; skip it rather than letting it blow up memory.
    if (line.length > MAX_LINE_BYTES) return;

    let record: JsonRecord;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      return;
    }
    const type = eventType(record);
    const at = eventTimestamp(record);
    if (at !== null) {
      session.startedAt = session.startedAt === null ? at : Math.min(session.startedAt, at);
      lastAt = lastAt === null ? at : Math.max(lastAt, at);
    }
    const discoveredId = sessionId(record, currentSessionId);
    if (discoveredId && discoveredId !== currentSessionId) {
      currentSessionId = discoveredId;
      session = { ...session, id: `provider:${hostId}:${provider}:${currentSessionId}`, providerSessionId: currentSessionId };
    }
    session.title = providerSessionTitle(record, provider) ?? session.title;
    session.cwd = stringValue(
      record.cwd,
      record.working_directory,
      record.workingDirectory,
      nested(record, "session", "cwd"),
      nested(record, "payload", "cwd"),
      nested(record, "payload", "working_directory"),
      session.cwd,
    );
    session.model = modelName(record) ?? session.model;
    session.origin = stringValue(record.origin, record.source, nested(record, "payload", "originator"), nested(record, "payload", "origin"), session.origin);
    session.updatedAt = at === null ? session.updatedAt : Math.max(session.updatedAt ?? at, at);
    session.status = statusFor(type, record) !== "unknown" ? statusFor(type, record) : session.status;
    if (type.includes("archive")) session.archived = true;
    if (type.includes("compact")) session.compactionCount += 1;
    if (type.includes("delegate") || type.includes("spawn") || type.includes("background")) session.delegatedCount += 1;

    const role = stringValue(record.role, nested(record, "message", "role"), nested(record, "payload", "role"), nested(record, "payload", "message", "role"))?.toLowerCase();
    if (role === "user" || role === "assistant" || type.includes("/user_message") || type.includes("/agent_message")) session.messageCount += 1;

    const isTurnEvent = type.includes("turn") || type.includes("run") || type.includes("response") || type.includes("generation") || type.includes("task_started") || type.includes("task_complete")
      // Pi/omp sessions are plain message logs: each assistant message is a step.
      || ((provider === "pi" || provider === "prime" || provider === "omp") && type === "message" && role === "assistant");
    const currentTurnId = turnId(record, "") ?? (isTurnEvent ? `line-${index + 1}` : null);
    if (isTurnEvent && currentTurnId) {
      const turn = ensureTurn(currentTurnId, at);
      turn.steps += 1;
      turn.sourceSequenceStart = turn.sourceSequenceStart ?? index + 1;
      turn.sourceSequenceEnd = index + 1;
      const status = statusFor(type, record);
      if (status !== "unknown") turn.status = status;
      if (type.includes("start") || type.includes("begin")) turn.startedAt = at ?? turn.startedAt;
      if (type.includes("complete") || type.includes("finish") || type.includes("stop") || type.includes("end")) {
        turn.endedAt = at ?? turn.endedAt;
        turn.durationMs = numberValue(record.durationMs, record.duration_ms, nested(record, "duration", "ms")) ??
          (turn.startedAt !== null && at !== null ? Math.max(0, at - turn.startedAt) : null);
      }
    }

    if (isToolEvent(type, record)) {
      seen.add("tools");
      const blockId = contentBlocks(record).map((block) => stringValue(block.id, block.toolUseId, block.tool_use_id, block.callId, block.call_id)).find((value): value is string => Boolean(value));
      const id = stringValue(record.item_id, record.itemId, record.tool_call_id, record.toolCallId, nested(record, "payload", "call_id"), nested(record, "payload", "callId"), nested(record, "data", "toolCallId"), blockId, record.id) ?? `item-${index + 1}`;
      const itemStatus = statusFor(type, record);
      // Pi/omp log tool invocations without a completion event (a `toolCall`
      // content block, or an omp `custom:tool_execution_start` record). The
      // call demonstrably ran and no failure was recorded, so treat it as
      // completed rather than leaving it "running" forever (failure markers
      // are still honored via statusFor above).
      const blockTypes = contentBlocks(record).map((block) => stringValue(block.type)?.toLowerCase() ?? "");
      const requestOnlyTool = blockTypes.includes("toolcall")
        || stringValue(record.customType)?.toLowerCase() === "tool_execution_start";
      const item: NormalizedItem = {
        id,
        turnId: currentTurnId,
        kind: stringValue(record.customType, nested(record, "payload", "type"), contentBlocks(record)[0]?.type, record.kind, record.type) ?? "tool",
        toolName: toolName(record),
        status: itemStatus === "failed" ? "failed" : itemStatus === "completed" ? "completed" : requestOnlyTool ? "completed" : itemStatus === "active" ? "running" : "unknown",
        durationMs: numberValue(record.durationMs, record.duration_ms, nested(record, "data", "durationMs")),
        errorCategory: errorCategory(record, type),
        approvalStatus: safeCategory(record.approvalStatus, record.approval_status, nested(record, "approval", "status"), ...contentBlocks(record).map((block) => block.approvalStatus ?? block.approval_status ?? nested(block, "approval", "status"))),
        sourceSequence: index + 1,
        at,
      };
      const old = itemMap.get(id);
      itemMap.set(id, old ? {
        ...old,
        ...item,
        status: item.status === "unknown" ? old.status : item.status,
        toolName: item.toolName ?? old.toolName,
        turnId: item.turnId ?? old.turnId,
        durationMs: item.durationMs ?? old.durationMs,
        approvalStatus: item.approvalStatus ?? old.approvalStatus,
      } : item);
      if (currentTurnId) ensureTurn(currentTurnId, at);
    }

    const snapshot = usageFrom(record, index + 1, at);
    if (snapshot) {
      seen.add("tokens");
      if (snapshot.contextUsed !== null) seen.add("context");
      usage.push(snapshot);
      if (currentTurnId) {
        const turn = ensureTurn(currentTurnId, at);
        turn.inputTokens = snapshot.inputTokens;
        turn.cachedInputTokens = snapshot.cachedInputTokens;
        turn.cachedWriteTokens = snapshot.cachedWriteTokens;
        turn.outputTokens = snapshot.outputTokens;
        turn.reasoningTokens = snapshot.reasoningTokens;
        turn.totalTokens = snapshot.totalTokens;
        turn.costUsd = snapshot.costUsd;
        turn.costEstimated = snapshot.costEstimated;
        turn.contextPeak = contextRatio(snapshot);
      }
    }
    const error = errorCategory(record, type);
    if (error) {
      seen.add("errors");
      if (!isToolEvent(type, record)) failureEvents += 1;
    }
    if (stringValue(record.durationMs, record.duration_ms) !== null) seen.add("latency");
    evidence.push({
      source: "provider",
      sourceRecordId: session.id,
      sourceSequence: index + 1,
      eventType: type,
      at,
    });
  };

  const finish = (fingerprint: string | null): ParsedProviderSession | null => {
    session.updatedAt = lastAt ?? session.updatedAt ?? session.startedAt;
    session.turnCount = turnMap.size;
    session.status = session.status === "unknown" && session.updatedAt ? "completed" : session.status;
    const finalItems = [...itemMap.values()];
    session.toolCalls = finalItems.length;
    session.toolErrors = finalItems.filter((item) => item.status === "failed" || item.errorCategory).length;
    session.failureCount = failureEvents;
    for (const turn of turnMap.values()) {
      const turnItems = finalItems.filter((item) => item.turnId === turn.id);
      turn.toolCalls = turnItems.length;
      turn.toolErrors = turnItems.filter((item) => item.status === "failed" || item.errorCategory).length;
    }
    session.durationMs = session.startedAt !== null && session.updatedAt !== null
      ? Math.max(0, session.updatedAt - session.startedAt)
      : null;
    mergeUsage(session, usage);
    applyCoverage(session, seen);
    session.fingerprint = fingerprint;
    if (!session.providerSessionId) return null;

    return {
      session,
      turns: [...turnMap.values()],
      items: [...itemMap.values()],
      usage,
      evidence,
    };
  };

  return { processLine, finish };
}

export function parseProviderJsonl(
  provider: ProviderId,
  hostId: string,
  path: string,
  content: string,
  fingerprint: string | null,
): ParsedProviderSession | null {
  if (content.length > MAX_SOURCE_BYTES) return null;
  const parser = createProviderJsonlParser(provider, hostId, path);
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    parser.processLine(lines[index] ?? "", index);
  }
  return parser.finish(fingerprint);
}

export function parseProviderMetadataSession(args: {
  provider: ProviderId;
  hostId: string;
  providerSessionId: string;
  path: string;
  title?: string | null;
  cwd?: string | null;
  model?: string | null;
  origin?: string | null;
  startedAt?: number | null;
  updatedAt?: number | null;
  messageCount?: number;
  toolCalls?: number;
  toolErrors?: number;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  cachedWriteTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  costEstimated?: boolean;
  status?: SessionStatus;
  archived?: boolean;
  fingerprint?: string | null;
}): ParsedProviderSession {
  const session = baseSession(args.provider, args.hostId, args.path, args.providerSessionId);
  session.title = args.title?.trim() || session.title;
  session.cwd = args.cwd ?? null;
  session.model = args.model ?? null;
  session.origin = args.origin ?? session.origin;
  session.startedAt = args.startedAt ?? null;
  session.updatedAt = args.updatedAt ?? args.startedAt ?? null;
  session.messageCount = args.messageCount ?? 0;
  session.toolCalls = args.toolCalls ?? 0;
  session.toolErrors = args.toolErrors ?? 0;
  session.inputTokens = args.inputTokens ?? null;
  session.cachedInputTokens = args.cachedInputTokens ?? null;
  session.cachedWriteTokens = args.cachedWriteTokens ?? null;
  session.outputTokens = args.outputTokens ?? null;
  session.reasoningTokens = args.reasoningTokens ?? null;
  session.totalTokens = args.totalTokens ?? null;
  session.costUsd = args.costUsd ?? null;
  session.costEstimated = args.costEstimated ?? false;
  session.archived = args.archived ?? false;
  session.status = args.status ?? (session.updatedAt ? "completed" : "unknown");
  session.coverage.metadata = "complete";
  session.coverage.models = session.model ? "complete" : "unavailable";
  session.coverage.tokens = [session.inputTokens, session.cachedInputTokens, session.cachedWriteTokens, session.outputTokens, session.reasoningTokens, session.totalTokens]
    .some((value) => value !== null) ? "complete" : "unavailable";
  session.coverage.tools = session.toolCalls > 0 ? "complete" : "unavailable";
  session.fingerprint = args.fingerprint ?? null;
  return { session, turns: [], items: [], usage: [], evidence: [] };
}

export function providerLabel(provider: ProviderId): string {
  if (provider === "claude") return "Claude Code";
  if (provider === "pi") return "Pi";
  if (provider === "prime") return "Prime Agent";
  return provider;
}
