// Parsers for provider session stores.
//
// Formats:
//  - Codex: ~/.codex/sessions/YYYY/MM/DD/<rollout>.jsonl — an event stream of
//    `session_meta`, `response_item` (message items with role user/assistant),
//    `turn_context`, `event_msg`.
//  - Claude Code: ~/.claude/projects/<project>/<session>.jsonl — one JSON
//    object per line: `user` / `assistant` / `ai-title` / `last-prompt` ...
//  - Pi (prime-agent): ~/.prime/agent/sessions/<id>.jsonl — an event stream of
//    `session`, `message`, `model_change`, `agent_status`; plus the hermes
//    daemon store at ~/.hermes/state.db (SQLite: sessions / messages).
//  - opencode: ~/.local/share/opencode/opencode.db (SQLite: session /
//    message / part; text lives in `part` rows whose data JSON has
//    type "text" — image/file parts are ignored).
//  - omp: ~/.omp/agent/sessions/<cwd>/<ts>_<uuid>.jsonl — an event stream of
//    `session`, `title`/`title_change`, `model_change`, `message` (content
//    blocks: text/thinking/image/toolCall; only text is kept).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionMeta, TranscriptMessage } from "./types";

/** Files larger than this are skipped (pathological transcripts). */
export const MAX_FILE_BYTES = 24 * 1024 * 1024;
/** Stored transcript cap (search + rehydrate source). */
export const MAX_TRANSCRIPT_CHARS = 300_000;

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
function isRealUserText(text: string): boolean {
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

function firstUserMessage(messages: TranscriptMessage[]): string | null {
  const m = messages.find((x) => x.role === "user" && isRealUserText(x.text));
  if (!m) return null;
  const t = m.text.replace(/\s+/g, " ").trim();
  return t.length > 300 ? t.slice(0, 300) + "…" : t;
}

function deriveTitle(
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
      providerSessionId = p.session_id ?? p.id ?? providerSessionId;
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
        // Skip injected context blocks (environment/permissions/user_action
        // wrappers) and AGENTS.md dumps that Codex logs as user messages.
        if (text && (p.role === "assistant" || isRealUserText(text))) {
          messages.push({ role: p.role, text, ts: ts ?? undefined });
        }
      }
    } else if (type === "event_msg") {
      const p = d.payload ?? {};
      if (p.type === "user_message" || p.type === "agent_message") {
        const role = p.type === "user_message" ? "user" : "assistant";
        if (typeof p.message === "string" && p.message.trim()) {
          if (role === "assistant" || isRealUserText(p.message)) {
            eventFallback.push({
              role,
              text: p.message.trim(),
              ts: ts ?? undefined,
            });
          }
        }
      }
    }
  }

  if (messages.length === 0 && eventFallback.length > 0) {
    messages.push(...eventFallback);
  }
  if (!hasUserMessage(messages)) return null;

  const transcript = formatMessages(messages);
  return {
    id: `codex:${providerSessionId ?? filePath}`,
    provider: "codex",
    providerSessionId: providerSessionId ?? filePath,
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
    if (!providerSessionId && d.sessionId) providerSessionId = d.sessionId;
    if (!cwd && d.cwd) cwd = d.cwd;
    const type = d.type;
    if (type === "user") {
      if (d.isMeta) continue;
      const text = claudeUserText(d.message?.content);
      if (text && isRealUserText(text)) {
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
  return {
    id: `claude:${providerSessionId ?? filePath}`,
    provider: "claude",
    providerSessionId: providerSessionId ?? filePath,
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
// Pi / prime-agent — JSONL event stream
// ---------------------------------------------------------------------------

export function parsePrimeJsonlFile(
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
      providerSessionId = d.id ?? providerSessionId;
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
        if (text && (role === "assistant" || isRealUserText(text))) {
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
  return {
    id: `prime:${providerSessionId ?? filePath}`,
    provider: "prime",
    providerSessionId: providerSessionId ?? filePath,
    filePath,
    title: deriveTitle(messages, null),
    cwd,
    gitRepoRoot: null,
    startedAt,
    updatedAt: updatedAt ?? startedAt,
    model,
    origin: "prime-agent",
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
      providerSessionId = d.id ?? providerSessionId;
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
        if (text && (role === "assistant" || isRealUserText(text))) {
          messages.push({ role, text, ts: mts ?? undefined });
        }
      }
    }
    // custom_message / custom (tool_execution_start, ...) events carry no
    // conversation text — ignored.
  }

  if (!hasUserMessage(messages)) return null;
  const transcript = formatMessages(messages);
  return {
    id: `omp:${providerSessionId ?? filePath}`,
    provider: "omp",
    providerSessionId: providerSessionId ?? filePath,
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
}

export function openHermesDb(dbPath: string): DatabaseSync | null {
  try {
    return new DatabaseSync(resolveHome(dbPath), { readOnly: true });
  } catch {
    return null;
  }
}

export function readHermesSessions(db: DatabaseSync): HermesSessionRow[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.source, s.title, s.display_name AS displayName,
              s.cwd, s.git_repo_root AS gitRepoRoot,
              s.started_at AS startedAt, s.last_activity_at AS lastActivityAt,
              s.message_count AS messageCount,
              (SELECT model FROM session_model_usage u
                WHERE u.session_id = s.id ORDER BY u.last_seen DESC LIMIT 1) AS model
       FROM sessions s
       WHERE s.message_count > 0`,
    )
    .all() as Array<{
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
  }>;
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
  }));
}

export function readHermesMessages(
  db: DatabaseSync,
  sessionId: string,
): TranscriptMessage[] {
  const rows = db
    .prepare(
      `SELECT role, content, timestamp
       FROM messages
       WHERE session_id = ? AND role IN ('user','assistant')
         AND content IS NOT NULL AND length(trim(content)) > 0
       ORDER BY timestamp ASC`,
    )
    .all(sessionId) as Array<{ role: string; content: string; timestamp: number | null }>;
  return rows.map((r) => ({
    role: r.role === "user" ? ("user" as const) : ("assistant" as const),
    text: r.content.trim(),
    ts: r.timestamp != null ? Math.round(r.timestamp * 1000) : undefined,
  }));
}

export function hermesSessionToMeta(
  row: HermesSessionRow,
  messages: TranscriptMessage[],
): SessionMeta | null {
  if (!hasUserMessage(messages)) return null;
  const transcript = formatMessages(messages);
  return {
    id: `prime:${row.id}`,
    provider: "prime",
    providerSessionId: row.id,
    filePath: `hermes-db:${row.id}`,
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
    truncated: transcript.length >= MAX_TRANSCRIPT_CHARS,
    sizeBytes: null,
    mtimeMs: null,
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
  try {
    return new DatabaseSync(resolveHome(dbPath), { readOnly: true });
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
  const rows = db
    .prepare(
      `SELECT m.data AS mdata, p.data AS pdata
       FROM message m
       LEFT JOIN part p ON p.message_id = m.id
       WHERE m.session_id = ?
       ORDER BY m.time_created ASC, p.time_created ASC`,
    )
    .all(sessionId) as Array<{ mdata: string | null; pdata: string | null }>;
  const out: TranscriptMessage[] = [];
  for (const r of rows) {
    if (!r.mdata) continue;
    let md: any;
    try {
      md = JSON.parse(r.mdata);
    } catch {
      continue;
    }
    const role = md.role;
    if (role !== "user" && role !== "assistant") continue;
    const parts: string[] = [];
    if (r.pdata) {
      try {
        const pd = JSON.parse(r.pdata);
        if (pd?.type === "text" && typeof pd.text === "string") {
          parts.push(pd.text);
        }
        // image/file parts carry binary payloads — never index their data.
      } catch {
        // unparseable part — skip
      }
    }
    const text = parts.join("\n").trim();
    if (!text) continue;
    if (role === "user" && !isRealUserText(text)) continue;
    const created =
      typeof md.time?.created === "number" ? md.time.created : null;
    out.push({ role, text, ts: created ?? undefined });
  }
  return out;
}

export function openCodeSessionToMeta(
  row: OpenCodeSessionRow,
  messages: TranscriptMessage[],
): SessionMeta | null {
  if (!hasUserMessage(messages)) return null;
  const transcript = formatMessages(messages);
  return {
    id: `opencode:${row.id}`,
    provider: "opencode",
    providerSessionId: row.id,
    filePath: `opencode-db:${row.id}`,
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
    truncated: transcript.length >= MAX_TRANSCRIPT_CHARS,
    sizeBytes: null,
    mtimeMs: null,
  };
}

// ---------------------------------------------------------------------------
// Transcript formatting
// ---------------------------------------------------------------------------

export function formatMessages(messages: TranscriptMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    parts.push(`## ${m.role === "user" ? "User" : "Assistant"}\n\n${m.text}`);
  }
  let out = parts.join("\n\n");
  if (out.length > MAX_TRANSCRIPT_CHARS) {
    out = out.slice(0, MAX_TRANSCRIPT_CHARS) + "\n\n… (truncated)";
  }
  return out;
}

