// Parsers for provider session stores.
//
// Formats:
//  - Codex: ~/.codex/sessions/YYYY/MM/DD/<rollout>.jsonl — an event stream of
//    `session_meta`, `response_item` (message items with role user/assistant),
//    `turn_context`, `event_msg`.
//  - Claude Code: ~/.claude/projects/<project>/<session>.jsonl — one JSON
//    object per line: `user` / `assistant` / `ai-title` / `last-prompt` ...
//  - Pi: ~/.pi/agent/sessions/<project>/<session>.jsonl — an event stream of
//    `session`, `message`, `model_change`, `agent_status`.
//  - Prime Agent: ~/.prime/agent/sessions/<id>.jsonl — the same event shape;
//    plus the Hermes daemon store at ~/.hermes/state.db (SQLite: sessions /
//    messages).
//  - opencode: ~/.local/share/opencode/opencode.db (SQLite: session /
//    message / part; text lives in `part` rows whose data JSON has
//    type "text" — image/file parts are ignored).
//  - omp: ~/.omp/agent/sessions/<cwd>/<ts>_<uuid>.jsonl — an event stream of
//    `session`, `title`/`title_change`, `model_change`, `message` (content
//    blocks: text/thinking/image/toolCall; only text is kept).

import { lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionMeta, SessionTraceEntry, TranscriptMessage } from "./types";
import { limitTraceText, MAX_TRACE_ENTRIES, traceFromMessages } from "./trace";

/** Legacy whole-file helpers still have a generous but finite input ceiling. */
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
/** Stored transcript projections are bounded; raw provider files remain on disk. */
export const MAX_TRANSCRIPT_CHARS = 500_000;
export const MAX_STORED_TRANSCRIPT_MESSAGES = 20_000;

export function boundedProviderSessionId(value: unknown, fallback: string): string {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
  if (!text) return fallback.slice(0, 512);
  if (text.length <= 512) return text;
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 24);
  return `${text.slice(0, 480)}~${digest}`;
}

export function capTranscriptMessages(messages: TranscriptMessage[]): {
  messages: TranscriptMessage[];
  truncated: boolean;
} {
  const output: TranscriptMessage[] = [];
  let used = 0;
  let truncated = false;
  for (const message of messages) {
    if (output.length >= MAX_STORED_TRANSCRIPT_MESSAGES) {
      truncated = true;
      continue;
    }
    const remaining = MAX_TRANSCRIPT_CHARS - used;
    if (remaining <= 0) {
      truncated = true;
      continue;
    }
    const text = message.text.length > remaining
      ? `${message.text.slice(0, Math.max(0, remaining - 1))}…`
      : message.text;
    if (text.length < message.text.length) truncated = true;
    output.push({ ...message, text });
    used += text.length;
  }
  return { messages: output, truncated };
}

export function resolveHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** Sessions with no user message are probes/system logs — skip them. */
function hasUserMessage(messages: TranscriptMessage[]): boolean {
  return messages.some((m) => m.role === "user");
}

export function parseTs(value: unknown): number | null {
  if (typeof value === "number") return value * 1000; // epoch seconds
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * True for user messages that look like real prompts rather than
 * system/tool-injected blocks (environment context, permissions banners,
 * AGENTS.md dumps, hermes ACP system prompts, delegation wrappers).
 */
export function isRealUserText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith("<")) return false;
  if (t.includes("<environment_context>")) return false;
  if (t.includes("<permissions instructions>")) return false;
  if (t.includes("<user_action>")) return false;
  if (t.startsWith("# AGENTS.md")) return false;
  if (t.includes("AGENTS.md instructions")) return false;
  if (t.startsWith("You are running inside")) return false;
  if (/^The following is the Codex agent history/i.test(t)) return false;
  return true;
}

export function firstUserMessage(messages: TranscriptMessage[]): string | null {
  // Keep previews focused on a human-looking prompt. XML/context-wrapped
  // messages are still stored in the full transcript and FTS body, but they
  // should not turn the list preview into a permissions or harness banner.
  const m = messages.find((x) => x.role === "user" && isRealUserText(x.text));
  if (!m) return null;
  const t = m.text.replace(/\s+/g, " ").trim();
  return t.length > 300 ? t.slice(0, 300) + "…" : t;
}

export function deriveTitle(
  messages: TranscriptMessage[],
  explicit: string | null,
): string {
  if (explicit && explicit.trim()) {
    return explicit.replace(/\s+/g, " ").trim().slice(0, 120);
  }
  const first = messages.find((x) => x.role === "user" && isRealUserText(x.text));
  if (!first) return "Untitled session";
  const t = first.text.replace(/\s+/g, " ").trim();
  return (t.length > 100 ? t.slice(0, 100) + "…" : t) || "Untitled session";
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function codexTextFromBlocks(
  content: unknown,
  role: "user" | "assistant",
): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const type = b.type;
    if (
      (role === "user" && (type === "input_text" || type === "text")) ||
      (role === "assistant" && (type === "output_text" || type === "text"))
    ) {
      if (typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n").trim();
}

export function parseCodexFile(
  filePath: string,
  mtimeMs: number,
  sizeBytes: number,
): SessionMeta | null {
  if (sizeBytes > MAX_FILE_BYTES) return null;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let providerSessionId: string | null = null;
  let cwd: string | null = null;
  let model: string | null = null;
  let origin: string | null = null;
  let startedAt: number | null = null;
  let updatedAt: number | null = null;
  const messages: TranscriptMessage[] = [];
  let eventFallback: TranscriptMessage[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = parseTs(d.timestamp);
    if (ts != null) {
      if (startedAt == null || ts < startedAt) startedAt = ts;
      updatedAt = updatedAt == null ? ts : Math.max(updatedAt, ts);
    }
    const type = d.type;
    if (type === "session_meta") {
      const p = d.payload ?? {};
      providerSessionId = boundedProviderSessionId(p.session_id ?? p.id ?? providerSessionId, filePath);
      cwd = p.cwd ?? cwd;
      origin = p.originator ?? origin;
      if (!model && p.model_provider) model = p.model_provider;
    } else if (type === "turn_context") {
      const p = d.payload ?? {};
      if (p.model) model = p.model;
      if (p.cwd && !cwd) cwd = p.cwd;
    } else if (type === "response_item") {
      const p = d.payload ?? {};
      if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
        const text = codexTextFromBlocks(p.content, p.role);
        // Keep the complete provider conversation. XML/context wrappers are
        // still useful for search and must not make an otherwise valid
        // session disappear from the index.
        if (text) {
          messages.push({ role: p.role, text, ts: ts ?? undefined });
        }
      }
    } else if (type === "event_msg") {
      const p = d.payload ?? {};
      if (p.type === "user_message" || p.type === "agent_message") {
        const role = p.type === "user_message" ? "user" : "assistant";
        if (typeof p.message === "string" && p.message.trim()) {
          eventFallback.push({
            role,
            text: p.message.trim(),
            ts: ts ?? undefined,
          });
        }
      }
    }
  }

  if (messages.length === 0 && eventFallback.length > 0) {
    messages.push(...eventFallback);
  }
  if (!hasUserMessage(messages)) return null;

  const transcript = formatMessages(messages);
  const stableSessionId = boundedProviderSessionId(providerSessionId, filePath);
  return {
    id: `codex:${stableSessionId}`,
    provider: "codex",
    providerSessionId: stableSessionId,
    filePath,
    title: deriveTitle(messages, null),
    cwd,
    gitRepoRoot: null,
    startedAt,
    updatedAt: updatedAt ?? startedAt,
    model,
    origin,
    messageCount: messages.length,
    summary: null,
    firstUserMessage: firstUserMessage(messages),
    transcript,
    truncated: transcript.length >= MAX_TRANSCRIPT_CHARS,
    sizeBytes,
    mtimeMs,
  };
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

function claudeUserText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n").trim();
}

function claudeAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n").trim();
}

export function parseClaudeFile(
  filePath: string,
  mtimeMs: number,
  sizeBytes: number,
): SessionMeta | null {
  if (sizeBytes > MAX_FILE_BYTES) return null;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let providerSessionId: string | null = null;
  let cwd: string | null = null;
  let model: string | null = null;
  let title: string | null = null;
  let startedAt: number | null = null;
  let updatedAt: number | null = null;
  const messages: TranscriptMessage[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = parseTs(d.timestamp);
    if (ts != null) {
      if (startedAt == null || ts < startedAt) startedAt = ts;
      updatedAt = updatedAt == null ? ts : Math.max(updatedAt, ts);
    }
    if (!providerSessionId && d.sessionId) providerSessionId = boundedProviderSessionId(d.sessionId, filePath);
    if (!cwd && d.cwd) cwd = d.cwd;
    const type = d.type;
    if (type === "user") {
      if (d.isMeta) continue;
      const text = claudeUserText(d.message?.content);
      if (text) {
        messages.push({ role: "user", text, ts: ts ?? undefined });
      }
    } else if (type === "assistant") {
      const text = claudeAssistantText(d.message?.content);
      if (text) messages.push({ role: "assistant", text, ts: ts ?? undefined });
      if (!model && d.message?.model) model = d.message.model;
    } else if (type === "ai-title") {
      if (!title && typeof d.aiTitle === "string") title = d.aiTitle;
    }
  }

  if (!hasUserMessage(messages)) return null;
  const transcript = formatMessages(messages);
  const stableSessionId = boundedProviderSessionId(providerSessionId, filePath);
  return {
    id: `claude:${stableSessionId}`,
    provider: "claude",
    providerSessionId: stableSessionId,
    filePath,
    title: deriveTitle(messages, title),
    cwd,
    gitRepoRoot: null,
    startedAt,
    updatedAt: updatedAt ?? startedAt,
    model,
    origin: "claude-code",
    messageCount: messages.length,
    summary: null,
    firstUserMessage: firstUserMessage(messages),
    transcript,
    truncated: transcript.length >= MAX_TRANSCRIPT_CHARS,
    sizeBytes,
    mtimeMs,
  };
}

// ---------------------------------------------------------------------------
// Pi / Prime Agent — JSONL event stream
// ---------------------------------------------------------------------------

export function parsePiJsonlFile(
  filePath: string,
  mtimeMs: number,
  sizeBytes: number,
): SessionMeta | null {
  return parsePiLikeJsonlFile(filePath, mtimeMs, sizeBytes, "pi");
}

export function parsePrimeJsonlFile(
  filePath: string,
  mtimeMs: number,
  sizeBytes: number,
): SessionMeta | null {
  return parsePiLikeJsonlFile(filePath, mtimeMs, sizeBytes, "prime");
}

function parsePiLikeJsonlFile(
  filePath: string,
  mtimeMs: number,
  sizeBytes: number,
  provider: "pi" | "prime",
): SessionMeta | null {
  if (sizeBytes > MAX_FILE_BYTES) return null;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let providerSessionId: string | null = null;
  let cwd: string | null = null;
  let model: string | null = null;
  let summary: string | null = null;
  let startedAt: number | null = null;
  let updatedAt: number | null = null;
  const messages: TranscriptMessage[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = parseTs(d.timestamp);
    if (ts != null) {
      if (startedAt == null || ts < startedAt) startedAt = ts;
      updatedAt = updatedAt == null ? ts : Math.max(updatedAt, ts);
    }
    const type = d.type;
    if (type === "session") {
      providerSessionId = boundedProviderSessionId(d.id ?? providerSessionId, filePath);
      cwd = d.cwd ?? cwd;
      if (d.timestamp && startedAt == null) startedAt = parseTs(d.timestamp);
    } else if (type === "model_change") {
      if (d.modelId) model = d.modelId;
    } else if (type === "message") {
      const m = d.message ?? {};
      const role = m.role;
      if (role === "user" || role === "assistant") {
        const parts: string[] = [];
        for (const block of m.content ?? []) {
          if (block?.type === "text" && typeof block.text === "string") {
            parts.push(block.text);
          }
        }
        const text = parts.join("\n").trim();
        if (text) {
          messages.push({ role, text, ts: ts ?? undefined });
        }
      }
    } else if (type === "agent_status") {
      const s = d.status;
      if (s && typeof s.summary === "string" && s.summary.trim()) {
        summary = s.summary.trim();
      }
    }
  }

  if (!hasUserMessage(messages)) return null;
  const transcript = formatMessages(messages);
  const stableSessionId = boundedProviderSessionId(providerSessionId, filePath);
  return {
    id: `${provider}:${stableSessionId}`,
    provider,
    providerSessionId: stableSessionId,
    filePath,
    title: deriveTitle(messages, null),
    cwd,
    gitRepoRoot: null,
    startedAt,
    updatedAt: updatedAt ?? startedAt,
    model,
    origin: provider === "pi" ? "pi" : "prime-agent",
    messageCount: messages.length,
    summary,
    firstUserMessage: firstUserMessage(messages),
    transcript,
    truncated: transcript.length >= MAX_TRANSCRIPT_CHARS,
    sizeBytes,
    mtimeMs,
  };
}

// ---------------------------------------------------------------------------
// omp — JSONL event stream (~/.omp/agent/sessions/<cwd>/<ts>_<uuid>.jsonl)
// ---------------------------------------------------------------------------

export function parseOmpJsonlFile(
  filePath: string,
  mtimeMs: number,
  sizeBytes: number,
): SessionMeta | null {
  if (sizeBytes > MAX_FILE_BYTES) return null;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let providerSessionId: string | null = null;
  let cwd: string | null = null;
  let model: string | null = null;
  let title: string | null = null;
  let startedAt: number | null = null;
  let updatedAt: number | null = null;
  const messages: TranscriptMessage[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = parseTs(d.timestamp); // ISO string at top level
    if (ts != null) {
      if (startedAt == null || ts < startedAt) startedAt = ts;
      updatedAt = updatedAt == null ? ts : Math.max(updatedAt, ts);
    }
    const type = d.type;
    if (type === "session") {
      providerSessionId = boundedProviderSessionId(d.id ?? providerSessionId, filePath);
      cwd = d.cwd ?? cwd;
      if (!title && typeof d.title === "string") title = d.title;
      if (d.timestamp && startedAt == null) startedAt = parseTs(d.timestamp);
    } else if (type === "title" || type === "title_change") {
      if (!title && typeof d.title === "string") title = d.title;
    } else if (type === "model_change") {
      if (typeof d.model === "string") model = d.model;
    } else if (type === "message") {
      const m = d.message ?? {};
      const role = m.role;
      if (role === "user" || role === "assistant") {
        const parts: string[] = [];
        for (const block of m.content ?? []) {
          if (block?.type === "text" && typeof block.text === "string") {
            parts.push(block.text);
          }
        }
        const text = parts.join("\n").trim();
        // omp message.timestamp is epoch ms (number); top-level is ISO.
        const mts =
          typeof m.timestamp === "number"
            ? m.timestamp
            : typeof m.timestamp === "string"
              ? parseTs(m.timestamp)
              : ts;
        if (text) {
          messages.push({ role, text, ts: mts ?? undefined });
        }
      }
    }
    // custom_message / custom (tool_execution_start, ...) events carry no
    // conversation text — ignored.
  }

  if (!hasUserMessage(messages)) return null;
  const transcript = formatMessages(messages);
  const stableSessionId = boundedProviderSessionId(providerSessionId, filePath);
  return {
    id: `omp:${stableSessionId}`,
    provider: "omp",
    providerSessionId: stableSessionId,
    filePath,
    title: deriveTitle(messages, title),
    cwd,
    gitRepoRoot: null,
    startedAt,
    updatedAt: updatedAt ?? startedAt,
    model,
    origin: "omp",
    messageCount: messages.length,
    summary: null,
    firstUserMessage: firstUserMessage(messages),
    transcript,
    truncated: transcript.length >= MAX_TRANSCRIPT_CHARS,
    sizeBytes,
    mtimeMs,
  };
}

// ---------------------------------------------------------------------------
// Pi / prime-agent — hermes daemon SQLite store
// ---------------------------------------------------------------------------

export interface HermesSessionRow {
  id: string;
  source: string | null;
  title: string | null;
  displayName: string | null;
  cwd: string | null;
  gitRepoRoot: string | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  messageCount: number;
  model: string | null;
  toolCallCount?: number | null;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  cachedWriteTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  estimatedCostUsd?: number | null;
  actualCostUsd?: number | null;
  endedAt?: number | null;
  endReason?: string | null;
  archived?: boolean;
}

export function openHermesDb(dbPath: string): DatabaseSync | null {
  const path = resolveHome(dbPath);
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile()) return null;
    const db = new DatabaseSync(path, { readOnly: true });
    const after = lstatSync(path);
    if (after.isSymbolicLink() || !after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
      db.close();
      return null;
    }
    return db;
  } catch {
    return null;
  }
}

export function readHermesSessions(db: DatabaseSync): HermesSessionRow[] {
  const baseQuery = `SELECT s.id, s.source, s.title, s.display_name AS displayName,
            s.cwd, s.git_repo_root AS gitRepoRoot,
            s.started_at AS startedAt, s.last_activity_at AS lastActivityAt,
            s.message_count AS messageCount,
            NULL AS model
     FROM sessions s
     WHERE s.message_count > 0`;
  const richQuery = `SELECT s.id, s.source, s.title, s.display_name AS displayName,
            s.cwd, s.git_repo_root AS gitRepoRoot,
            s.started_at AS startedAt, s.last_activity_at AS lastActivityAt,
            s.message_count AS messageCount, s.tool_call_count AS toolCallCount,
            s.input_tokens AS inputTokens, s.cache_read_tokens AS cachedInputTokens,
            s.cache_write_tokens AS cachedWriteTokens, s.output_tokens AS outputTokens,
            s.reasoning_tokens AS reasoningTokens,
            s.estimated_cost_usd AS estimatedCostUsd, s.actual_cost_usd AS actualCostUsd,
            s.ended_at AS endedAt, s.end_reason AS endReason, s.archived AS archived,
            (SELECT model FROM session_model_usage u
              WHERE u.session_id = s.id ORDER BY u.last_seen DESC LIMIT 1) AS model
     FROM sessions s
     WHERE s.message_count > 0`;
  let rows: Array<{
    id: string;
    source: string | null;
    title: string | null;
    displayName: string | null;
    cwd: string | null;
    gitRepoRoot: string | null;
    startedAt: number | null;
    lastActivityAt: number | null;
    messageCount: number;
    model: string | null;
    toolCallCount?: number | null;
    inputTokens?: number | null;
    cachedInputTokens?: number | null;
    cachedWriteTokens?: number | null;
    outputTokens?: number | null;
    reasoningTokens?: number | null;
    estimatedCostUsd?: number | null;
    actualCostUsd?: number | null;
    endedAt?: number | null;
    endReason?: string | null;
    archived?: number | boolean | null;
  }>;
  try {
    rows = db.prepare(richQuery).all() as typeof rows;
  } catch {
    // Hermes schema versions before telemetry did not expose usage columns.
    rows = db.prepare(baseQuery).all() as typeof rows;
  }
  return rows.map((r) => ({
    id: r.id,
    source: r.source ?? null,
    title: r.title ?? null,
    displayName: r.displayName ?? null,
    cwd: r.cwd ?? null,
    gitRepoRoot: r.gitRepoRoot ?? null,
    startedAt: r.startedAt != null ? Math.round(r.startedAt * 1000) : null,
    lastActivityAt:
      r.lastActivityAt != null ? Math.round(r.lastActivityAt * 1000) : null,
    messageCount: r.messageCount,
    model: r.model ?? null,
    toolCallCount: r.toolCallCount ?? null,
    inputTokens: r.inputTokens ?? null,
    cachedInputTokens: r.cachedInputTokens ?? null,
    cachedWriteTokens: r.cachedWriteTokens ?? null,
    outputTokens: r.outputTokens ?? null,
    reasoningTokens: r.reasoningTokens ?? null,
    estimatedCostUsd: r.estimatedCostUsd ?? null,
    actualCostUsd: r.actualCostUsd ?? null,
    endedAt: r.endedAt != null ? Math.round(r.endedAt * 1000) : null,
    endReason: r.endReason ?? null,
    archived: r.archived === true || r.archived === 1,
  }));
}

export function readHermesMessages(
  db: DatabaseSync,
  sessionId: string,
): TranscriptMessage[] {
  return readHermesConversation(db, sessionId).messages;
}

interface HermesMessageRecord {
  role: string;
  content: string | null;
  timestamp: number | null;
}

interface ConversationProjection {
  messages: TranscriptMessage[];
  trace: SessionTraceEntry[];
  traceTruncated: boolean;
  toolCalls: number;
  toolErrors: number;
  /** At least one stored JSON payload was malformed; do not treat null meta as deletion. */
  parseFailed: boolean;
  /** The provider query hit its safety row limit and may be incomplete. */
  sourceTruncated: boolean;
}

function hermesMessageRecords(
  db: DatabaseSync,
  sessionId: string,
): { records: HermesMessageRecord[]; sourceTruncated: boolean } {
  const rows = db
    .prepare(
      `SELECT role, content, timestamp
       FROM messages
       WHERE session_id = ?
         AND role IN ('user', 'assistant', 'tool')
       ORDER BY timestamp ASC
       LIMIT ${MAX_STORED_TRANSCRIPT_MESSAGES + 1}`,
    )
    .all(sessionId) as unknown as HermesMessageRecord[];
  return {
    records: rows.slice(0, MAX_STORED_TRANSCRIPT_MESSAGES),
    sourceTruncated: rows.length > MAX_STORED_TRANSCRIPT_MESSAGES,
  };
}

function parsedObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function objectString(value: Record<string, unknown> | null, ...keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function hermesTrace(records: HermesMessageRecord[]): SessionTraceEntry[] {
  return records.slice(0, MAX_TRACE_ENTRIES).flatMap((record, index) => {
    if (record.role === "session_meta") return [];
    const content = record.content?.trim() ?? "";
    const parsed = parsedObject(content);
    const isTool = record.role === "tool";
    const kind = record.role === "user" || record.role === "assistant"
      ? record.role
      : isTool ? "tool" : "system";
    const toolName = isTool ? objectString(parsed, "tool_name", "toolName", "name", "tool") : null;
    const rawStatus = objectString(parsed, "status", "state");
    const failed = rawStatus === "error" || rawStatus === "failed" || parsed?.error != null;
    const text = parsed ? JSON.stringify(parsed) : content || "No content";
    return [{
      id: `hermes-message-${index + 1}`,
      kind,
      title: toolName ?? (kind === "tool" ? "Tool call" : kind === "system" ? "System event" : kind === "user" ? "User" : "Assistant"),
      text: limitTraceText(text),
      timestamp: record.timestamp != null ? Math.round(record.timestamp * 1000) : null,
      status: failed ? "failed" : "completed",
      toolName,
      sourceSequence: index + 1,
    } satisfies SessionTraceEntry];
  });
}

export function readHermesConversation(
  db: DatabaseSync,
  sessionId: string,
): ConversationProjection {
  const { records, sourceTruncated } = hermesMessageRecords(db, sessionId);
  const parseFailed = records.some((record) => !record.content?.trim());
  const messages = capTranscriptMessages(records
    .filter((record) => record.role === "user" || record.role === "assistant")
    .filter((record) => Boolean(record.content?.trim()))
    .map((record) => ({
      role: record.role as "user" | "assistant",
      text: record.content!.trim(),
      ts: record.timestamp != null ? Math.round(record.timestamp * 1000) : undefined,
    }))).messages;
  const trace = hermesTrace(records);
  return {
    messages,
    trace,
    traceTruncated: records.length > MAX_TRACE_ENTRIES,
    toolCalls: records.filter((record) => record.role === "tool").length,
    toolErrors: trace.filter((entry) => entry.kind === "tool" && entry.status === "failed").length,
    parseFailed,
    sourceTruncated,
  };
}

export function hermesSessionToMeta(
  row: HermesSessionRow,
  messages: TranscriptMessage[],
  trace = traceFromMessages(messages),
  traceTruncated = false,
  toolCalls = trace.filter((entry) => entry.kind === "tool").length,
  toolErrors = trace.filter((entry) => entry.kind === "tool" && entry.status === "failed").length,
): SessionMeta | null {
  const projected = capTranscriptMessages(messages);
  messages = projected.messages;
  if (!hasUserMessage(messages)) return null;
  const stableSessionId = boundedProviderSessionId(row.id, "hermes-session");
  const transcript = formatMessages(messages);
  const endReason = row.endReason?.toLowerCase() ?? "";
  const status = /fail|error|abort|cancel/.test(endReason)
    ? "failed" as const
    : row.endedAt != null
      ? "completed" as const
      : "active" as const;
  const actualCost = typeof row.actualCostUsd === "number" && row.actualCostUsd > 0
    ? row.actualCostUsd
    : null;
  const estimatedCost = typeof row.estimatedCostUsd === "number" && row.estimatedCostUsd > 0
    ? row.estimatedCostUsd
    : null;
  return {
    id: `hermes:${stableSessionId}`,
    provider: "hermes",
    providerSessionId: stableSessionId,
    filePath: `hermes-db:${stableSessionId}`,
    archived: row.archived === true,
    title: deriveTitle(messages, row.title ?? row.displayName),
    cwd: row.cwd ?? row.gitRepoRoot,
    gitRepoRoot: row.gitRepoRoot ?? null,
    startedAt: row.startedAt,
    updatedAt: row.lastActivityAt ?? row.startedAt,
    model: row.model ?? null,
    origin: row.source ?? "hermes",
    messageCount: messages.length,
    summary: null,
    firstUserMessage: firstUserMessage(messages),
    transcript,
    truncated: projected.truncated || transcript.length >= MAX_TRANSCRIPT_CHARS,
    transcriptPreviewTruncated: projected.truncated,
    sizeBytes: null,
    mtimeMs: null,
    trace,
    traceTruncated,
    analytics: {
      status,
      durationMs: row.startedAt !== null && row.lastActivityAt !== null
        ? Math.max(0, row.lastActivityAt - row.startedAt)
        : null,
      turnCount: 0,
      toolCalls: row.toolCallCount ?? toolCalls,
      toolErrors,
      inputTokens: row.inputTokens ?? null,
      cachedInputTokens: row.cachedInputTokens ?? null,
      cachedWriteTokens: row.cachedWriteTokens ?? null,
      outputTokens: row.outputTokens ?? null,
      reasoningTokens: row.reasoningTokens ?? null,
      totalTokens:
        typeof row.inputTokens === "number" || typeof row.outputTokens === "number"
          ? (typeof row.inputTokens === "number" ? row.inputTokens : 0) +
            (typeof row.outputTokens === "number" ? row.outputTokens : 0)
          : null,
      contextPeak: null,
      compactionCount: 0,
      failureCount: status === "failed" ? 1 : 0,
      delegatedCount: 0,
      costUsd: actualCost ?? estimatedCost,
      costEstimated: actualCost === null && estimatedCost !== null,
      coverageJson: JSON.stringify({
        metadata: "complete",
        turns: "partial",
        tools: row.toolCallCount != null || toolCalls > 0 ? "complete" : "partial",
        tokens: row.inputTokens != null || row.outputTokens != null ? "complete" : "unavailable",
        context: "unavailable",
        errors: "partial",
        latency: "partial",
        models: row.model ? "complete" : "unavailable",
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// opencode — SQLite store (~/.local/share/opencode/opencode.db)
// ---------------------------------------------------------------------------

export interface OpenCodeSessionRow {
  id: string;
  title: string | null;
  directory: string | null;
  timeCreated: number | null;
  timeUpdated: number | null;
}

export function openOpenCodeDb(dbPath: string): DatabaseSync | null {
  const path = resolveHome(dbPath);
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile()) return null;
    const db = new DatabaseSync(path, { readOnly: true });
    const after = lstatSync(path);
    if (after.isSymbolicLink() || !after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
      db.close();
      return null;
    }
    return db;
  } catch {
    return null;
  }
}

export function readOpenCodeSessions(db: DatabaseSync): OpenCodeSessionRow[] {
  const rows = db
    .prepare(
      `SELECT id, title, directory,
              time_created AS timeCreated, time_updated AS timeUpdated
       FROM session
       ORDER BY time_created ASC`,
    )
    .all() as Array<{
    id: string;
    title: string | null;
    directory: string | null;
    timeCreated: number | null;
    timeUpdated: number | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? null,
    directory: r.directory ?? null,
    // opencode stores epoch ms integers.
    timeCreated: r.timeCreated ?? null,
    timeUpdated: r.timeUpdated ?? null,
  }));
}

export function readOpenCodeMessages(
  db: DatabaseSync,
  sessionId: string,
): TranscriptMessage[] {
  return readOpenCodeConversation(db, sessionId).messages;
}

function openCodeTraceEntry(
  part: Record<string, unknown>,
  timestamp: number | null,
  sequence: number,
): SessionTraceEntry | null {
  if (!part || typeof part !== "object" || Array.isArray(part) || part.type !== "tool") return null;
  const state = part.state !== null && typeof part.state === "object" && !Array.isArray(part.state)
    ? part.state as Record<string, unknown>
    : null;
  const rawStatus = objectString(state, "status");
  const status = rawStatus === "completed" ? "completed"
    : rawStatus === "error" || rawStatus === "failed" ? "failed"
      : rawStatus === "running" ? "running"
        : state?.error != null ? "failed" : "unknown";
  const toolName = objectString(part, "tool", "name");
  return {
    id: `opencode-tool-${sequence}`,
    kind: "tool",
    title: objectString(part, "title") ?? toolName ?? "Tool call",
    text: limitTraceText(JSON.stringify(part)),
    timestamp,
    status,
    toolName,
    sourceSequence: sequence,
  };
}

export function readOpenCodeConversation(
  db: DatabaseSync,
  sessionId: string,
): ConversationProjection {
  const rows = db
    .prepare(
      `SELECT m.id AS mid, m.data AS mdata, p.data AS pdata
       FROM message m
       LEFT JOIN part p ON p.message_id = m.id
       WHERE m.session_id = ?
       ORDER BY m.time_created ASC, p.time_created ASC
       LIMIT 100001`,
    )
    .all(sessionId) as Array<{ mid: string; mdata: string | null; pdata: string | null }>;
  const sourceTruncated = rows.length > 100000;
  const projectedRows = rows.slice(0, 100000);
  const out: TranscriptMessage[] = [];
  const trace: SessionTraceEntry[] = [];
  let traceTruncated = false;
  let sequence = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let parseFailed = false;
  let currentMessageId: string | null = null;
  let currentRole: "user" | "assistant" | null = null;
  let currentTimestamp: number | null = null;
  let currentTextParts: string[] = [];
  let currentTextChars = 0;
  const flushMessage = () => {
    const text = currentTextParts.join("\n").trim();
    if (text && currentRole && out.length < MAX_STORED_TRANSCRIPT_MESSAGES) {
      out.push({ role: currentRole, text, ts: currentTimestamp ?? undefined });
    }
    currentMessageId = null;
    currentRole = null;
    currentTimestamp = null;
    currentTextParts = [];
    currentTextChars = 0;
  };
  for (const r of projectedRows) {
    if (currentMessageId !== null && r.mid !== currentMessageId) flushMessage();
    if (!r.mdata) {
      // A message row without its JSON payload is an incomplete provider
      // read, not proof that the session is an empty conversation. Preserve
      // any previously indexed projection and retry after the store settles.
      parseFailed = true;
      continue;
    }
    let md: any;
    try {
      md = JSON.parse(r.mdata);
    } catch {
      parseFailed = true;
      continue;
    }
    const role = md.role;
    if (role !== "user" && role !== "assistant") {
      parseFailed = true;
      flushMessage();
      continue;
    }
    if (!r.pdata) {
      // A conversational message without any part row is an incomplete
      // provider read. Do not turn it into an empty projection that deletes
      // a previously indexed session.
      parseFailed = true;
      flushMessage();
      continue;
    }
    if (currentMessageId === null) {
      currentMessageId = r.mid;
      currentRole = role;
      currentTimestamp = typeof md.time?.created === "number" ? md.time.created : null;
    }
    if (r.pdata) {
      try {
        const pd = JSON.parse(r.pdata);
        const created = typeof md.time?.created === "number" ? md.time.created : null;
        if (pd?.type === "text" && typeof pd.text === "string") {
          const remaining = MAX_TRANSCRIPT_CHARS - currentTextChars;
          if (remaining > 0) {
            const text = pd.text.slice(0, remaining);
            currentTextParts.push(text);
            currentTextChars += text.length;
          }
          if (trace.length < MAX_TRACE_ENTRIES) {
            trace.push({
              id: `opencode-message-${sequence + 1}`,
              kind: role,
              title: role === "user" ? "User" : "Assistant",
              text: limitTraceText(pd.text),
              timestamp: created,
              status: "completed",
              toolName: null,
              sourceSequence: ++sequence,
            });
          } else {
            traceTruncated = true;
            sequence++;
          }
        }
        const partTrace = openCodeTraceEntry(
          pd as Record<string, unknown>,
          created,
          ++sequence,
        );
        if (partTrace) {
          toolCalls++;
          if (partTrace.status === "failed") toolErrors++;
          if (trace.length < MAX_TRACE_ENTRIES) trace.push(partTrace);
          else traceTruncated = true;
        }
        // image/file parts carry binary payloads — never index their data.
      } catch {
        // A malformed part is an incomplete provider read, not proof that the
        // logical session was deleted. The indexer preserves the old row.
        parseFailed = true;
      }
    }
  }
  flushMessage();
  return { messages: out, trace, traceTruncated, toolCalls, toolErrors, parseFailed, sourceTruncated };
}

export function openCodeSessionToMeta(
  row: OpenCodeSessionRow,
  messages: TranscriptMessage[],
  trace = traceFromMessages(messages),
  traceTruncated = false,
  toolCalls = trace.filter((entry) => entry.kind === "tool").length,
  toolErrors = trace.filter((entry) => entry.kind === "tool" && entry.status === "failed").length,
): SessionMeta | null {
  const projected = capTranscriptMessages(messages);
  messages = projected.messages;
  if (!hasUserMessage(messages)) return null;
  const stableSessionId = boundedProviderSessionId(row.id, "opencode-session");
  const transcript = formatMessages(messages);
  return {
    id: `opencode:${stableSessionId}`,
    provider: "opencode",
    providerSessionId: stableSessionId,
    filePath: `opencode-db:${stableSessionId}`,
    archived: false,
    title: deriveTitle(messages, row.title),
    cwd: row.directory,
    gitRepoRoot: null,
    startedAt: row.timeCreated,
    updatedAt: row.timeUpdated ?? row.timeCreated,
    model: null,
    origin: "opencode",
    messageCount: messages.length,
    summary: null,
    firstUserMessage: firstUserMessage(messages),
    transcript,
    truncated: projected.truncated || transcript.length >= MAX_TRANSCRIPT_CHARS,
    transcriptPreviewTruncated: projected.truncated,
    sizeBytes: null,
    mtimeMs: null,
    trace,
    traceTruncated,
    analytics: {
      status: "completed",
      durationMs: row.timeCreated !== null && row.timeUpdated !== null
        ? Math.max(0, row.timeUpdated - row.timeCreated)
        : null,
      turnCount: messages.filter((message) => message.role === "user").length,
      toolCalls,
      toolErrors,
      inputTokens: null,
      cachedInputTokens: null,
      cachedWriteTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      contextPeak: null,
      compactionCount: 0,
      failureCount: toolErrors > 0 ? 1 : 0,
      delegatedCount: 0,
      costUsd: null,
      costEstimated: false,
      coverageJson: JSON.stringify({
        metadata: "complete",
        turns: "partial",
        tools: "complete",
        errors: "partial",
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Transcript formatting
// ---------------------------------------------------------------------------

export function formatMessages(messages: TranscriptMessage[]): string {
  const parts: string[] = [];
  const bounded = capTranscriptMessages(messages).messages;
  for (const m of bounded) {
    parts.push(`## ${m.role === "user" ? "User" : "Assistant"}\n\n${m.text}`);
  }
  return parts.join("\n\n").slice(0, MAX_TRANSCRIPT_CHARS);
}
