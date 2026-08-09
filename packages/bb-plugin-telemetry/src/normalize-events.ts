import { canonicalProvider } from "./source-registry";
import type { NormalizedBbEvent } from "./types";

type RecordLike = Record<string, unknown>;

function record(value: unknown): RecordLike {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : {};
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function numberValue(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function nested(value: RecordLike, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as RecordLike)[key];
  }
  return current;
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

function safeStatus(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const normalized = value.trim().toLowerCase();
    if (normalized.includes("fail") || normalized.includes("error")) return "failed";
    if (normalized.includes("complete") || normalized.includes("success") || normalized === "done") return "completed";
    if (normalized.includes("run") || normalized.includes("start") || normalized.includes("progress") || normalized === "active") return "running";
    if (normalized.includes("interrupt") || normalized.includes("cancel")) return "interrupted";
    if (normalized.includes("pending") || normalized.includes("wait")) return "pending";
    if (normalized.includes("approv") || normalized.includes("grant")) return "approved";
    if (normalized.includes("denied") || normalized.includes("reject")) return "denied";
    if (/^[a-z0-9][a-z0-9._:-]{0,32}$/.test(normalized)) return normalized;
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

function tokens(data: RecordLike): Pick<NormalizedBbEvent, "inputTokens" | "cachedInputTokens" | "outputTokens" | "reasoningTokens" | "totalTokens"> {
  const usage = record(data.usage ?? data.tokenUsage ?? data.token_usage ?? data.tokens);
  return {
    inputTokens: numberValue(usage.inputTokens, usage.input_tokens, usage.promptTokens, usage.prompt_tokens, usage.input),
    cachedInputTokens: numberValue(usage.cachedInputTokens, usage.cached_input_tokens, usage.cacheReadInputTokens, usage.cache_read_input_tokens, usage.cache_read),
    outputTokens: numberValue(usage.outputTokens, usage.output_tokens, usage.completionTokens, usage.completion_tokens, usage.output),
    reasoningTokens: numberValue(usage.reasoningTokens, usage.reasoning_tokens, usage.reasoning),
    totalTokens: numberValue(usage.totalTokens, usage.total_tokens, usage.total),
  };
}

export function normalizeBbEvent(row: unknown): NormalizedBbEvent {
  const value = record(row);
  const data = record(value.data);
  const type = stringValue(value.type, value.eventType, value.kind) ?? "unknown";
  const lower = type.toLowerCase();
  const scope = record(value.scope);
  const itemId = stringValue(
    data.itemId,
    data.item_id,
    nested(data, "item", "id"),
    nested(data, "tool", "id"),
    lower.includes("item/") ? data.id : undefined,
  );
  const messageId = stringValue(
    data.messageId,
    data.message_id,
    nested(data, "message", "id"),
    nested(data, "item", "messageId"),
    nested(data, "item", "message_id"),
  );
  const turnId = stringValue(
    scope.turnId,
    data.turnId,
    data.turn_id,
    nested(data, "turn", "id"),
    nested(data, "turn", "turnId"),
  );
  const durationMs = numberValue(data.durationMs, data.duration_ms, nested(data, "duration", "ms"));
  const toolName = stringValue(data.toolName, data.tool_name, data.name, nested(data, "tool", "name"), nested(data, "function", "name"));
  const explicitErrorValues = [
    data.errorCategory,
    data.error_category,
    nested(data, "error", "category"),
    nested(data, "error", "type"),
  ];
  const errorCategory = safeCategory(
    ...explicitErrorValues,
    lower.includes("permission") ? "permission" : undefined,
    lower.includes("timeout") ? "timeout" : undefined,
    lower.includes("error") || lower.includes("warning") || lower.includes("fallback") || lower.includes("unhandled") ? "provider-error" : undefined,
  ) ?? (explicitErrorValues.some((value) => typeof value === "string" && value.trim()) ? "provider-error" : null);
  const usage = tokens(data);
  const contextUsed = numberValue(
    data.contextUsed,
    data.context_used,
    nested(data, "context", "used"),
    nested(data, "contextWindowUsage", "used"),
    nested(data, "context_window_usage", "used"),
    nested(data, "usedTokens"),
  );
  const contextLimit = numberValue(
    data.contextLimit,
    data.context_limit,
    nested(data, "context", "limit"),
    nested(data, "contextWindowUsage", "limit"),
    nested(data, "context_window_usage", "limit"),
  );
  let classification: NormalizedBbEvent["classification"] = "other";
  const isMessageEvent = lower.includes("message") || lower.includes("agentmessage");
  if (lower.includes("turn/")) classification = "turn";
  else if ((lower.includes("item/") && !isMessageEvent) || lower.includes("tool")) classification = "tool";
  else if (lower.includes("token")) classification = "usage";
  else if (lower.includes("context") || lower.includes("compact")) classification = "context";
  else if (errorCategory) classification = "error";
  else if (lower.includes("delegat") || lower.includes("background") || lower.includes("child")) classification = "delegation";
  else if (lower.includes("thread/") || lower.includes("lifecycle")) classification = "lifecycle";

  const explicitStatus = safeStatus(data.status, data.outcome, data.result);
  const status = explicitStatus ??
    (lower.includes("failed") || lower.includes("error") ? "failed" :
      lower.includes("completed") || lower.includes("succeeded") ? "completed" :
        lower.includes("started") ? "running" : null);

  return {
    sourceSequence: numberValue(value.seq, value.sourceSeq, value.sequence) ?? 0,
    eventType: type,
    itemId,
    messageId,
    turnId,
    at: timestamp(value.createdAt ?? value.timestamp ?? data.timestamp),
    classification,
    status,
    durationMs,
    toolName,
    errorCategory,
    approvalStatus: safeStatus(data.approvalStatus, data.approval_status, nested(data, "approval", "status")),
    ...usage,
    contextUsed,
    contextLimit,
    estimated: Boolean(data.estimated),
    providerSessionId: stringValue(
      data.providerSessionId,
      data.provider_session_id,
      data.providerThreadId,
      data.provider_thread_id,
      data.sessionId,
      data.session_id,
    ),
  };
}

export { canonicalProvider };
