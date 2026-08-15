// Shared streaming ingestion for JSONL providers.
//
// Telemetry already learned how to walk very large provider files without
// buffering them. Sessions uses that parser for structured metrics and keeps a
// small provider-specific projection alongside it for searchable conversation
// text. The file is read once, line by line; provider conversation projections
// are bounded even when the source file itself is very large.

import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import {
  createProviderJsonlParser,
  MAX_LINE_BYTES,
} from "./provider-parser";
import type { ParsedProviderSession, ProviderId as TelemetryProviderId } from "./provider-telemetry-types";
import {
  deriveTitle,
  firstUserMessage,
  formatMessages,
  MAX_STORED_TRANSCRIPT_MESSAGES,
  MAX_TRANSCRIPT_CHARS,
  parseTs,
} from "./parsers";
import {
  limitTraceText,
  MAX_TRACE_ENTRIES,
  traceFromTranscript,
} from "./trace";
import type {
  ProviderId,
  SessionAnalytics,
  SessionMeta,
  SessionTraceEntry,
  SessionTraceStatus,
  TranscriptMessage,
} from "./types";

type JsonRecord = Record<string, any>;
type JsonlProvider = Exclude<ProviderId, "hermes" | "opencode">;

function mergeTraceStatus(
  current: SessionTraceStatus,
  telemetry: SessionTraceStatus | undefined,
): SessionTraceStatus {
  if (telemetry === undefined || telemetry === "unknown") return current;
  const rank: Record<SessionTraceStatus, number> = {
    unknown: 0,
    running: 1,
    completed: 2,
    interrupted: 3,
    failed: 4,
  };
  return rank[telemetry] >= rank[current] ? telemetry : current;
}

export function enrichTraceWithTelemetry(
  entries: SessionTraceEntry[],
  telemetry: ParsedProviderSession | null,
): SessionTraceEntry[] {
  if (!telemetry || entries.length === 0) return entries;

  const itemsBySequence = new Map(
    telemetry.items.map((item) => [item.sourceSequence, item] as const),
  );
  const turns = telemetry.turns
    .filter((turn) => turn.sourceSequenceStart !== null || turn.sourceSequenceEnd !== null)
    .sort((left, right) => (left.sourceSequenceStart ?? 0) - (right.sourceSequenceStart ?? 0));
  const usageBySequence = new Map<number, ParsedProviderSession["usage"][number]>();
  const usageByTurn = new Map<string, ParsedProviderSession["usage"][number]>();
  for (const snapshot of telemetry.usage) {
    const sequencePrevious = usageBySequence.get(snapshot.sourceSequence);
    if (sequencePrevious === undefined || (snapshot.at ?? 0) >= (sequencePrevious.at ?? 0)) {
      usageBySequence.set(snapshot.sourceSequence, snapshot);
    }
    if (snapshot.turnId === null) continue;
    const previous = usageByTurn.get(snapshot.turnId);
    if (previous === undefined || (snapshot.at ?? 0) >= (previous.at ?? 0)) {
      usageByTurn.set(snapshot.turnId, snapshot);
    }
  }

  const matches = entries.map((entry) => {
    const sourceSequences = entry.sourceSequences?.length
      ? entry.sourceSequences
      : [entry.sourceSequence];
    // Normalized tool items retain the final/result source sequence. Prefer
    // the latest folded source record so multi-record calls inherit the final
    // status, duration, and error classification.
    const item = [...sourceSequences]
      .sort((left, right) => right - left)
      .map((sequence) => itemsBySequence.get(sequence))
      .find((candidate): candidate is ParsedProviderSession["items"][number] => candidate !== undefined);
    const turn = turns.find((candidate) => {
      const start = candidate.sourceSequenceStart ?? Number.MIN_SAFE_INTEGER;
      const end = candidate.sourceSequenceEnd ?? Number.MAX_SAFE_INTEGER;
      return sourceSequences.some((sequence) => sequence >= start && sequence <= end);
    });
    const turnId = item?.turnId ?? turn?.id ?? null;
    const directUsage = [...sourceSequences]
      .sort((left, right) => right - left)
      .map((sequence) => usageBySequence.get(sequence))
      .find((candidate): candidate is ParsedProviderSession["usage"][number] => candidate !== undefined);
    return { item, turnId, directUsage };
  });
  const lastEntryIndexByTurn = new Map<string, number>();
  for (const [index, match] of matches.entries()) {
    if (match.turnId !== null) lastEntryIndexByTurn.set(match.turnId, index);
  }

  return entries.map((entry, index) => {
    const { item, turnId, directUsage } = matches[index]!;
    const turnUsage = turnId !== null && lastEntryIndexByTurn.get(turnId) === index
      ? usageByTurn.get(turnId)
      : undefined;
    const usage = directUsage ?? turnUsage;
    const usageScope = directUsage !== undefined ? "event" : turnUsage !== undefined ? "turn" : undefined;
    const metrics = {
      ...(item?.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
      ...(turnId !== null ? { turnId } : {}),
      ...(item?.kind !== undefined ? { eventType: item.kind } : {}),
      ...(item?.errorCategory !== undefined ? { errorCategory: item.errorCategory } : {}),
      ...(usage?.inputTokens !== null && usage?.inputTokens !== undefined
        ? { inputTokens: usage.inputTokens }
        : {}),
      ...(usage?.cachedInputTokens !== null && usage?.cachedInputTokens !== undefined
        ? { cachedInputTokens: usage.cachedInputTokens }
        : {}),
      ...(usage?.cachedWriteTokens !== null && usage?.cachedWriteTokens !== undefined
        ? { cachedWriteTokens: usage.cachedWriteTokens }
        : {}),
      ...(usage?.outputTokens !== null && usage?.outputTokens !== undefined
        ? { outputTokens: usage.outputTokens }
        : {}),
      ...(usage?.reasoningTokens !== null && usage?.reasoningTokens !== undefined
        ? { reasoningTokens: usage.reasoningTokens }
        : {}),
      ...(usage?.totalTokens !== null && usage?.totalTokens !== undefined
        ? { totalTokens: usage.totalTokens }
        : {}),
      ...(usage?.contextUsed !== null && usage?.contextUsed !== undefined
        ? { contextUsed: usage.contextUsed }
        : {}),
      ...(usage?.contextLimit !== null && usage?.contextLimit !== undefined
        ? { contextLimit: usage.contextLimit }
        : {}),
      ...(usageScope !== undefined ? { usageScope } : {}),
    } satisfies NonNullable<SessionTraceEntry["metrics"]>;
    const hasMetrics = Object.keys(metrics).length > 0;
    const status = mergeTraceStatus(entry.status, item?.status);
    return {
      ...entry,
      status,
      ...(hasMetrics ? { metrics } : {}),
    };
  });
}

export interface StreamingParseResult {
  meta: SessionMeta | null;
  telemetry: ParsedProviderSession | null;
  disposition: "session" | "not-session" | "failed";
}

const SUBAGENT_PATH = /[/\\]subagents[/\\]/u;

function metricSum(values: Array<number | null | undefined>): number | null {
  const known = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

function metricMax(values: Array<number | null | undefined>): number | null {
  const known = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return known.length ? Math.max(...known) : null;
}

function metricMin(values: Array<number | null | undefined>): number | null {
  const known = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return known.length ? Math.min(...known) : null;
}

function coverageLevel(value: unknown): "complete" | "partial" | "unavailable" {
  return value === "complete" || value === "partial" || value === "unavailable" ? value : "unavailable";
}

function mergeCoverage(metas: SessionMeta[]): string {
  const levels = new Map<string, number>([
    ["unavailable", 0],
    ["partial", 1],
    ["complete", 2],
  ]);
  const merged: Record<string, "complete" | "partial" | "unavailable"> = {};
  for (const meta of metas) {
    let coverage: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(meta.analytics?.coverageJson ?? "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) coverage = parsed as Record<string, unknown>;
    } catch {
      // A malformed coverage payload should not prevent the session itself
      // from being indexed.
    }
    for (const [name, value] of Object.entries(coverage)) {
      const next = coverageLevel(value);
      const previous = merged[name] ?? "unavailable";
      if ((levels.get(next) ?? 0) > (levels.get(previous) ?? 0)) merged[name] = next;
    }
  }
  return JSON.stringify(merged);
}

function mergeAnalytics(metas: SessionMeta[], startedAt: number | null, updatedAt: number | null): SessionAnalytics | undefined {
  const analytics = metas.map((meta) => meta.analytics).filter((value): value is SessionAnalytics => value !== undefined);
  if (!analytics.length) return undefined;
  const hasStatus = (status: SessionAnalytics["status"]) => analytics.some((value) => value.status === status);
  const status = hasStatus("failed") ? "failed" : hasStatus("active") ? "active" : hasStatus("completed") ? "completed" : "unknown";
  return {
    status,
    durationMs: startedAt !== null && updatedAt !== null ? Math.max(0, updatedAt - startedAt) : metricMax(analytics.map((value) => value.durationMs)),
    turnCount: analytics.reduce((sum, value) => sum + value.turnCount, 0),
    toolCalls: analytics.reduce((sum, value) => sum + value.toolCalls, 0),
    toolErrors: analytics.reduce((sum, value) => sum + value.toolErrors, 0),
    inputTokens: metricSum(analytics.map((value) => value.inputTokens)),
    cachedInputTokens: metricSum(analytics.map((value) => value.cachedInputTokens)),
    cachedWriteTokens: metricSum(analytics.map((value) => value.cachedWriteTokens)),
    outputTokens: metricSum(analytics.map((value) => value.outputTokens)),
    reasoningTokens: metricSum(analytics.map((value) => value.reasoningTokens)),
    totalTokens: metricSum(analytics.map((value) => value.totalTokens)),
    contextPeak: metricMax(analytics.map((value) => value.contextPeak)),
    compactionCount: analytics.reduce((sum, value) => sum + value.compactionCount, 0),
    failureCount: analytics.reduce((sum, value) => sum + value.failureCount, 0),
    delegatedCount: analytics.reduce((sum, value) => sum + value.delegatedCount, 0),
    costUsd: metricSum(analytics.map((value) => value.costUsd)),
    costEstimated: analytics.some((value) => value.costEstimated),
    coverageJson: mergeCoverage(metas),
  };
}

/**
 * Combine physical files that represent one logical provider session.
 *
 * Claude Code writes subagent transcripts under a `subagents/` directory, but
 * repeats the parent sessionId in each file. Indexing those files one at a
 * time would make the last file overwrite the parent row and lose its calls,
 * tokens, and searchable transcript. Keep one session row while retaining all
 * physical files in the indexer's manifest.
 */
export function mergeSessionMetas(metas: SessionMeta[]): SessionMeta {
  if (!metas.length) throw new Error("Cannot merge an empty session group");
  if (metas.length === 1) return metas[0]!;

  const ordered = [...metas].sort((left, right) => {
    const leftSubagent = left.filePath?.match(SUBAGENT_PATH) ? 1 : 0;
    const rightSubagent = right.filePath?.match(SUBAGENT_PATH) ? 1 : 0;
    return leftSubagent - rightSubagent || (left.startedAt ?? Number.MAX_SAFE_INTEGER) - (right.startedAt ?? Number.MAX_SAFE_INTEGER);
  });
  const primary = ordered[0]!;
  const startedAt = metricMin(ordered.map((meta) => meta.startedAt));
  const updatedAt = metricMax(ordered.map((meta) => meta.updatedAt));
  const rawTranscript = ordered
    .filter((meta) => meta.transcript.trim())
    .map((meta, index) => {
      if (index === 0) return meta.transcript;
      const label = meta.filePath?.split(/[\\/]/u).at(-1) ?? "subagent transcript";
      return `## Subagent conversation (${label})\n\n${meta.transcript}`;
    })
    .join("\n\n");
  const transcript = rawTranscript.length > MAX_TRANSCRIPT_CHARS
    ? `${rawTranscript.slice(0, MAX_TRANSCRIPT_CHARS - 1)}…`
    : rawTranscript;
  const firstUserMessage = ordered.find((meta) => meta.firstUserMessage)?.firstUserMessage ?? null;
  const trace = ordered.flatMap((meta, metaIndex) =>
    (meta.trace ?? traceFromTranscript(meta.transcript)).map((entry) => ({
      ...entry,
      id: `${metaIndex}:${entry.id}`,
      sourceSequence: entry.sourceSequence + metaIndex * 1_000_000,
      ...(entry.sourceSequences === undefined
        ? {}
        : { sourceSequences: entry.sourceSequences.map((sequence) => sequence + metaIndex * 1_000_000) }),
    })),
  );
  return {
    ...primary,
    startedAt,
    updatedAt,
    messageCount: ordered.reduce((sum, meta) => sum + meta.messageCount, 0),
    summary: primary.summary ?? ordered.find((meta) => meta.summary)?.summary ?? null,
    firstUserMessage,
    transcript,
    transcriptPreviewTruncated:
      ordered.some((meta) => meta.transcriptPreviewTruncated) || transcript.length < rawTranscript.length,
    truncated: ordered.some((meta) => meta.truncated) || transcript.length < rawTranscript.length,
    sizeBytes: metricSum(ordered.map((meta) => meta.sizeBytes)),
    mtimeMs: metricMax(ordered.map((meta) => meta.mtimeMs)),
    trace: trace.slice(0, MAX_TRACE_ENTRIES),
    traceTruncated:
      ordered.some((meta) => meta.traceTruncated) || trace.length > MAX_TRACE_ENTRIES,
    analytics: mergeAnalytics(ordered, startedAt, updatedAt),
  };
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 8_000);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function sessionIdValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) continue;
    const text = String(value).trim();
    if (!text) continue;
    if (text.length <= 512) return text;
    const digest = createHash("sha256").update(text).digest("hex").slice(0, 24);
    return `${text.slice(0, 480)}~${digest}`;
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

function arrayRecords(...values: unknown[]): JsonRecord[] {
  for (const value of values) {
    if (Array.isArray(value)) return value.map(asRecord);
  }
  return [];
}

function traceBlocks(record: JsonRecord): JsonRecord[] {
  const payload = asRecord(record.payload);
  return arrayRecords(
    record.content,
    asRecord(record.message).content,
    payload.content,
    asRecord(payload.message).content,
    asRecord(record.data).content,
  );
}

function traceType(record: JsonRecord, blocks: JsonRecord[]): string {
  return (
    stringValue(
      asRecord(record.payload).type,
      record.customType,
      record.type,
      record.event,
      record.kind,
      blocks[0]?.type,
    ) ?? "event"
  ).toLowerCase();
}

function traceToolName(record: JsonRecord, blocks: JsonRecord[]): string | null {
  const blockName = blocks
    .map((block) =>
      stringValue(
        block.name,
        block.toolName,
        block.tool_name,
        asRecord(block.tool).name,
        asRecord(block.function).name,
      ),
    )
    .find((value): value is string => Boolean(value));
  return (
    blockName ??
    stringValue(
      record.tool_name,
      record.toolName,
      asRecord(record.message).toolName,
      asRecord(record.message).tool_name,
      asRecord(record.data).toolName,
      asRecord(record.data).tool_name,
      asRecord(record.data).name,
      asRecord(record.payload).toolName,
      asRecord(record.payload).name,
      asRecord(record.tool).name,
      asRecord(record.function).name,
    )
  );
}

function traceToolId(record: JsonRecord, blocks: JsonRecord[], sequence: number): string {
  const blockId = blocks
    .map((block) =>
      stringValue(block.id, block.toolUseId, block.tool_use_id, block.callId, block.call_id),
    )
    .find((value): value is string => Boolean(value));
  return (
    stringValue(
      record.item_id,
      record.itemId,
      record.tool_call_id,
      record.toolCallId,
      record.call_id,
      record.callId,
      asRecord(record.message).toolCallId,
      asRecord(record.message).tool_call_id,
      asRecord(record.payload).call_id,
      asRecord(record.payload).callId,
      asRecord(record.data).toolCallId,
      asRecord(record.data).tool_call_id,
      asRecord(record.payload).item_id,
      blockId,
    ) ?? `tool-${sequence}`
  );
}

function isTraceToolEvent(type: string, record: JsonRecord, blocks: JsonRecord[]): boolean {
  const blockTypes = blocks.map((block) => stringValue(block.type)?.toLowerCase() ?? "");
  const messageRole = stringValue(asRecord(record.message).role)?.toLowerCase() ?? "";
  return (
    type.includes("tool") ||
    type.includes("function") ||
    type.includes("command") ||
    type.includes("permission") ||
    typeof record.tool_name === "string" ||
    typeof record.toolName === "string" ||
    typeof asRecord(record.data).toolName === "string" ||
    typeof asRecord(record.data).tool_name === "string" ||
    messageRole === "toolresult" ||
    messageRole === "tool_result" ||
    blockTypes.some((blockType) =>
      [
        "tool_use",
        "tool_result",
        "tool_call",
        "toolcall",
        "function_call",
        "function_call_output",
        "custom_tool_call",
        "custom_tool_call_output",
      ].includes(blockType),
    )
  );
}

function traceStatus(type: string, record: JsonRecord, blocks: JsonRecord[]): SessionTraceStatus {
  const payload = asRecord(record.payload);
  const messageRole = stringValue(asRecord(record.message).role)?.toLowerCase() ?? "";
  const blockTypes = blocks.map((block) => stringValue(block.type)?.toLowerCase() ?? "");
  const reportedStatus = stringValue(
    record.status,
    payload.status,
    asRecord(record.data).status,
    asRecord(record.data).state,
    blocks.map((block) => block.status).find((value) => typeof value === "string"),
  )?.toLowerCase() ?? "";
  const signal = [type, messageRole, ...blockTypes, reportedStatus].join(" ");
  const failed =
    signal.includes("error") ||
    signal.includes("fail") ||
    blocks.some((block) => Boolean(block.is_error ?? block.isError)) ||
    Boolean(asRecord(record.error).message) ||
    Boolean(asRecord(payload.error).message) ||
    Boolean(asRecord(record.data).error);
  if (failed) return "failed";
  if (
    signal.includes("result") ||
    signal.includes("output") ||
    signal.includes("complete") ||
    signal.includes("finish") ||
    reportedStatus === "success" ||
    reportedStatus === "succeeded"
  ) {
    return "completed";
  }
  if (signal.includes("interrupt") || signal.includes("cancel")) return "interrupted";
  if (
    signal.includes("call") ||
    signal.includes("use") ||
    signal.includes("start") ||
    signal.includes("begin") ||
    reportedStatus === "running" ||
    reportedStatus === "pending"
  ) {
    return "running";
  }
  return "unknown";
}

function readableValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function traceText(record: JsonRecord, blocks: JsonRecord[], type: string): string {
  const payload = asRecord(record.payload);
  const messageRole = stringValue(asRecord(record.message).role)?.toLowerCase() ?? "";
  const toolBlock = blocks.find((candidate) => {
    const candidateType = stringValue(candidate.type)?.toLowerCase();
    return candidateType !== undefined && [
      "tool_use",
      "tool_result",
      "tool_call",
      "toolcall",
      "function_call",
      "function_call_output",
      "custom_tool_call",
      "custom_tool_call_output",
    ].includes(candidateType);
  });
  const block = toolBlock ?? blocks[0] ?? {};
  const input = readableValue(
    block.input ?? block.arguments ?? block.params ?? payload.input ?? payload.arguments ?? asRecord(record.data).input ?? asRecord(record.data).arguments ?? record.arguments,
  );
  const output = readableValue(
    block.output ??
      block.result ??
      block.content ??
      payload.output ??
      payload.result ??
      asRecord(record.data).output ??
      asRecord(record.data).result ??
      record.result ??
      (messageRole === "toolresult" || messageRole === "tool_result" ? block.text : undefined),
  );
  const error = readableValue(record.error ?? payload.error ?? asRecord(record.data).error ?? block.error);
  const parts: string[] = [];
  if (input) parts.push(`Input\n${input}`);
  if (output) parts.push(`Output\n${output}`);
  if (error) parts.push(`Error\n${error}`);
  if (!parts.length) {
    const text = readableValue(block.text ?? payload.text ?? record.message);
    if (text) parts.push(text);
  }
  return limitTraceText(parts.join("\n\n") || `Event: ${type}`);
}

function addToolTrace(
  entries: SessionTraceEntry[],
  toolIds: Map<string, SessionTraceEntry>,
  record: JsonRecord,
  sequence: number,
  timestamp: number | null,
): void {
  const blocks = traceBlocks(record);
  const type = traceType(record, blocks);
  if (!isTraceToolEvent(type, record, blocks)) return;
  const toolId = traceToolId(record, blocks, sequence);
  const text = traceText(record, blocks, type);
  const name = traceToolName(record, blocks);
  const status = traceStatus(type, record, blocks);
  const existing = toolIds.get(toolId);
  if (existing) {
    const sourceSequences = new Set(existing.sourceSequences ?? [existing.sourceSequence]);
    sourceSequences.add(sequence);
    existing.sourceSequences = [...sourceSequences].sort((left, right) => left - right).slice(-64);
    if (text && !existing.text.includes(text)) {
      existing.text = limitTraceText(`${existing.text}\n\n${text}`);
    }
    if (name) {
      existing.toolName = name;
      existing.title = name;
    }
    existing.status = mergeTraceStatus(existing.status, status);
    if (existing.timestamp === null && timestamp !== null) existing.timestamp = timestamp;
    return;
  }
  if (entries.length >= MAX_TRACE_ENTRIES) return;
  const entry: SessionTraceEntry = {
    id: `tool-${toolId}`,
    kind: "tool",
    title: name ?? "Tool call",
    text,
    timestamp,
    status,
    toolName: name,
    sourceSequence: sequence,
    sourceSequences: [sequence],
  };
  entries.push(entry);
  toolIds.set(toolId, entry);
}

function textBlocks(content: unknown, allowedTypes?: Set<string>): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (typeof block.text !== "string") continue;
    if (allowedTypes && typeof block.type === "string" && !allowedTypes.has(block.type)) continue;
    parts.push(block.text);
  }
  return parts.join("\n").trim();
}

interface TranscriptBudget {
  seen: number;
  chars: number;
  truncated: boolean;
}

function pushMessage(
  messages: TranscriptMessage[],
  trace: SessionTraceEntry[],
  role: unknown,
  text: string,
  ts: number | null,
  sourceSequence: number,
  budget?: TranscriptBudget,
): void {
  if (role !== "user" && role !== "assistant") return;
  const clean = text.trim();
  if (!clean) return;
  if (budget) {
    budget.seen += 1;
    if (messages.length >= MAX_STORED_TRANSCRIPT_MESSAGES) {
      budget.truncated = true;
      return;
    }
    const remaining = MAX_TRANSCRIPT_CHARS - budget.chars;
    if (remaining <= 0) {
      budget.truncated = true;
      return;
    }
    const bounded = clean.length > remaining
      ? `${clean.slice(0, Math.max(0, remaining - 1))}…`
      : clean;
    if (bounded.length < clean.length) budget.truncated = true;
    budget.chars += bounded.length;
    messages.push({ role, text: bounded, ts: ts ?? undefined });
  } else {
    messages.push({ role, text: clean, ts: ts ?? undefined });
  }
  if (trace.length < MAX_TRACE_ENTRIES) {
    trace.push({
      id: `message-${sourceSequence}-${role}`,
      kind: role,
      title: role === "user" ? "User" : "Assistant",
      text: limitTraceText(clean),
      timestamp: ts,
      status: "completed",
      toolName: null,
      sourceSequence,
    });
  }
}

function analyticsFrom(parsed: ParsedProviderSession | null): SessionAnalytics | undefined {
  if (!parsed) return undefined;
  const s = parsed.session;
  return {
    status: s.status,
    durationMs: s.durationMs,
    turnCount: s.turnCount,
    toolCalls: s.toolCalls,
    toolErrors: s.toolErrors,
    inputTokens: s.inputTokens,
    cachedInputTokens: s.cachedInputTokens,
    cachedWriteTokens: s.cachedWriteTokens,
    outputTokens: s.outputTokens,
    reasoningTokens: s.reasoningTokens,
    totalTokens: s.totalTokens,
    contextPeak: s.contextPeak,
    compactionCount: s.compactionCount,
    failureCount: s.failureCount,
    delegatedCount: s.delegatedCount,
    costUsd: s.costUsd,
    costEstimated: s.costEstimated,
    coverageJson: JSON.stringify(s.coverage),
  };
}

export async function parseJsonlStreaming(
  provider: JsonlProvider,
  filePath: string,
  mtimeMs: number,
  sizeBytes: number,
  fingerprint: string | null,
  hostId = "primary",
  signal?: AbortSignal,
  expectedIdentity?: { dev: number; ino: number },
  expectedAncestors?: Array<{ path: string; dev: number; ino: number }>,
): Promise<StreamingParseResult> {
  const telemetryParser = createProviderJsonlParser(
    provider as TelemetryProviderId,
    hostId,
    filePath,
  );
  const messages: TranscriptMessage[] = [];
  const transcriptBudget: TranscriptBudget = { seen: 0, chars: 0, truncated: false };
  const traceEntries: SessionTraceEntry[] = [];
  const toolIds = new Map<string, SessionTraceEntry>();
  let providerSessionId: string | null = null;
  let cwd: string | null = null;
  let model: string | null = null;
  let origin: string | null = null;
  let summary: string | null = null;
  let explicitTitle: string | null = null;
  let startedAt: number | null = null;
  let updatedAt: number | null = null;
  const eventFallback: TranscriptMessage[] = [];
  let eventFallbackChars = 0;
  let malformedLine = false;

  const updateTime = (value: unknown) => {
    const ts = parseTs(value);
    if (ts === null) return ts;
    startedAt = startedAt === null ? ts : Math.min(startedAt, ts);
    updatedAt = updatedAt === null ? ts : Math.max(updatedAt, ts);
    return ts;
  };

  const processConversationLine = (rawLine: string, index: number): void => {
    const line = rawLine.trim();
    if (!line) return;
    if (line.length > MAX_LINE_BYTES) {
      // The telemetry parser can account for Codex compaction snapshots from
      // their small JSON header without parsing the multi-megabyte snapshot.
      // Treat those records as valid rather than turning an otherwise healthy
      // session into a failed scan.
      if (
        provider === "codex" &&
        /"type"\s*:\s*"compacted"/u.test(line.slice(0, 512))
      ) return;
      malformedLine = true;
      return;
    }
    let d: JsonRecord;
    try {
      d = asRecord(JSON.parse(line));
    } catch {
      malformedLine = true;
      return;
    }
    const ts = updateTime(d.timestamp);
    addToolTrace(traceEntries, toolIds, d, index + 1, ts);

    if (provider === "codex") {
      const type = d.type;
      if (type === "session_meta") {
        const p = asRecord(d.payload);
        providerSessionId = sessionIdValue(p.session_id, p.id, providerSessionId);
        cwd = stringValue(p.cwd, cwd);
        origin = stringValue(p.originator, origin);
        model = stringValue(p.model, p.model_provider, model);
      } else if (type === "turn_context") {
        const p = asRecord(d.payload);
        model = stringValue(p.model, model);
        cwd = stringValue(p.cwd, cwd);
      } else if (type === "response_item") {
        const p = asRecord(d.payload);
        const role = p.role;
        if (p.type === "message" && (role === "user" || role === "assistant")) {
          const allowed = role === "user"
            ? new Set(["input_text", "text"])
            : new Set(["output_text", "text"]);
          pushMessage(messages, traceEntries, role, textBlocks(p.content, allowed), ts, index + 1, transcriptBudget);
        }
      } else if (type === "event_msg") {
        const p = asRecord(d.payload);
        if (p.type === "user_message" || p.type === "agent_message") {
          const role = p.type === "user_message" ? "user" : "assistant";
          const text = typeof p.message === "string" ? p.message : "";
          if (text.trim() && eventFallback.length < MAX_STORED_TRANSCRIPT_MESSAGES) {
            const bounded = text.trim().slice(0, Math.max(0, MAX_TRANSCRIPT_CHARS - eventFallbackChars));
            if (bounded) {
              eventFallback.push({ role, text: bounded, ts: ts ?? undefined });
              eventFallbackChars += bounded.length;
            }
          }
        }
      }
      return;
    }

    if (provider === "claude") {
      providerSessionId = sessionIdValue(d.sessionId, providerSessionId);
      cwd = stringValue(d.cwd, cwd);
      if (d.type === "assistant") model = stringValue(asRecord(d.message).model, model);
      if (d.type === "ai-title") explicitTitle = stringValue(d.aiTitle, explicitTitle);
      if (d.type === "user" && !d.isMeta) {
        const message = asRecord(d.message);
        pushMessage(messages, traceEntries, "user", textBlocks(message.content), ts, index + 1, transcriptBudget);
      } else if (d.type === "assistant") {
        const message = asRecord(d.message);
        pushMessage(messages, traceEntries, "assistant", textBlocks(message.content, new Set(["text"])), ts, index + 1, transcriptBudget);
      }
      return;
    }

    // Pi, Prime Agent, and OMP share the Pi event-stream shape. Keeping the
    // parser parameterized is what lets the source registry distinguish the
    // provider without pretending their stores are the same product.
    if (d.type === "session") {
      providerSessionId = sessionIdValue(d.id, providerSessionId);
      cwd = stringValue(d.cwd, cwd);
      explicitTitle = stringValue(d.title, explicitTitle);
    } else if (d.type === "title" || d.type === "title_change") {
      explicitTitle = stringValue(d.title, explicitTitle);
    } else if (d.type === "model_change") {
      model = stringValue(d.modelId, d.model, model);
    } else if (d.type === "agent_status") {
      const status = asRecord(d.status);
      summary = stringValue(status.summary, summary)?.slice(0, 8_000) ?? null;
    } else if (d.type === "message") {
      const message = asRecord(d.message);
      const role = message.role;
      const text = textBlocks(message.content, new Set(["text"]));
      const messageTs = numberValue(message.timestamp) ?? ts;
      pushMessage(messages, traceEntries, role, text, messageTs, index + 1, transcriptBudget);
    }
  };

  let fd: number | null = null;
  try {
    if (expectedAncestors) {
      for (const ancestor of expectedAncestors) {
        const current = lstatSync(ancestor.path);
        if (current.isSymbolicLink() || current.dev !== ancestor.dev || current.ino !== ancestor.ino) {
          return { meta: null, telemetry: null, disposition: "failed" };
        }
      }
    }
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (
      (expectedIdentity && (before.dev !== expectedIdentity.dev || before.ino !== expectedIdentity.ino)) ||
      (expectedIdentity && (before.size !== sizeBytes || before.mtimeMs !== mtimeMs))
    ) {
      return { meta: null, telemetry: null, disposition: "failed" };
    }
    const lines = createInterface({
      // Open the final file without following symlinks. The directory walk is
      // advisory; the descriptor is the security boundary against a file
      // replacement between lstat/stat and parsing.
      input: createReadStream(filePath, { fd, autoClose: false, signal }),
      crlfDelay: Infinity,
    });
    let index = 0;
    for await (const line of lines) {
      if (signal?.aborted) return { meta: null, telemetry: null, disposition: "failed" };
      telemetryParser.processLine(line, index);
      processConversationLine(line, index);
      index += 1;
    }
    const after = fstatSync(fd);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      return { meta: null, telemetry: null, disposition: "failed" };
    }
  } catch {
    return { meta: null, telemetry: null, disposition: "failed" };
  } finally {
    if (fd !== null) {
      closeSync(fd);
      fd = null;
    }
  }

  // A partially-written or corrupted provider file is not evidence that the
  // previous session disappeared. Preserve its existing index row and let a
  // later clean scan replace it.
  if (malformedLine) {
    return { meta: null, telemetry: null, disposition: "failed" };
  }

  if (messages.length === 0 && eventFallback.length > 0) {
    for (const fallback of eventFallback) {
      pushMessage(
        messages,
        traceEntries,
        fallback.role,
        fallback.text,
        fallback.ts ?? null,
        messages.length + 1,
        transcriptBudget,
      );
    }
  }
  if (!messages.some((message) => message.role === "user")) {
    return { meta: null, telemetry: telemetryParser.finish(fingerprint), disposition: "not-session" };
  }

  const telemetry = telemetryParser.finish(fingerprint);
  const teleSession = telemetry?.session;
  const sessionId = sessionIdValue(providerSessionId, teleSession?.providerSessionId, filePath) ?? "unknown";
  const transcript = formatMessages(messages);
  const meta: SessionMeta = {
    id: `${provider}:${sessionId}`,
    provider,
    providerSessionId: sessionId,
    filePath,
    title: deriveTitle(messages, explicitTitle),
    cwd: cwd ?? teleSession?.cwd ?? null,
    gitRepoRoot: null,
    startedAt: startedAt ?? teleSession?.startedAt ?? null,
    updatedAt: updatedAt ?? teleSession?.updatedAt ?? startedAt,
    model: model ?? teleSession?.model ?? null,
    origin: origin ?? teleSession?.origin ?? (provider === "prime" ? "prime-agent" : provider),
    messageCount: transcriptBudget.seen,
    summary,
    firstUserMessage: firstUserMessage(messages),
    transcript,
    transcriptPreviewTruncated: transcriptBudget.truncated,
    truncated: transcriptBudget.truncated,
    sizeBytes,
    mtimeMs,
    trace: enrichTraceWithTelemetry(traceEntries.slice(0, MAX_TRACE_ENTRIES), telemetry),
    traceTruncated: transcriptBudget.truncated || messages.length + toolIds.size > MAX_TRACE_ENTRIES,
    analytics: analyticsFrom(telemetry),
  };
  return { meta, telemetry, disposition: "session" };
}
