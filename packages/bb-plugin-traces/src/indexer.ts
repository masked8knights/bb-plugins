import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";

export type TraceSourceId = "codex" | "claude" | "pi" | "omp" | "dsh" | "custom";
export type TraceFormat = "jsonl" | "zstd";
export type TraceEventCategory = "user" | "assistant" | "tool" | "system" | "context" | "telemetry" | "step" | "turn" | "other";
export type TraceErrorFilter = "all" | "only";
export type TraceSessionStatus = "active" | "completed" | "unknown";

export type TraceEventFilters = {
  query?: string;
  categories?: TraceEventCategory[];
  toolTypes?: string[];
  errorFilter?: TraceErrorFilter;
};

export type TraceFacet = {
  value: string;
  count: number;
};

export type TraceSessionFacets = {
  categories: TraceFacet[];
  toolTypes: TraceFacet[];
  errorCount: number;
  totalEvents: number;
};

export type RootSpec = {
  id: string;
  source: TraceSourceId;
  label: string;
  path: string;
  kind: "session";
  format?: TraceFormat;
};

export type NormalizedEvent = {
  type: string;
  kind: "message" | "tool" | "step" | "turn" | "reasoning" | "telemetry" | "system";
  role: "user" | "assistant" | "tool" | "tool_result" | "reasoning" | "system" | null;
  title: string;
  summary: string;
  timestamp: number | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  usageIsTotal: boolean;
  turn: number | null;
  step: number | null;
  depth: number;
  model: string | null;
  cwd: string | null;
};

export type TraceLine = {
  text: string;
  line: number;
  startByte: number;
  endByte: number;
};

export type SessionSummary = {
  id: string;
  source: TraceSourceId;
  title: string;
  filePath: string;
  model: string | null;
  cwd: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  eventCount: number;
  userCount: number;
  assistantCount: number;
  toolCount: number;
  errorCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  status: TraceSessionStatus;
  fileSizeBytes: number;
};

export type EventSummary = NormalizedEvent & {
  id: string;
  sessionId: string;
  line: number;
  rawJson: string;
  rawTruncated: boolean;
};

export type IndexStats = {
  sessions: number;
  events: number;
  bytes: number;
  lastScanAt: number | null;
  indexing: boolean;
  lastError: string | null;
};

export type ScanResult = {
  changed: boolean;
  complete: boolean;
  processedPaths: string[];
};

type SqliteStatement = {
  run(...args: unknown[]): unknown;
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
};

export type SqliteDb = {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
};

type DbRow = Record<string, unknown>;

type StatsSnapshot = {
  sessions: number;
  events: number;
  bytes: number;
};

// The source files remain the authoritative payload store. The index keeps a
// small fallback preview and reloads the selected line from the source file
// when the inspector asks for the full payload.
const MAX_RAW_JSON = 512;
const MAX_EVENT_TEXT = 1_024;
const MAX_SESSION_FILES = 50_000;
const MAX_SESSION_DEPTH = 32;
const INDEXER_VERSION = 3;
// v1 rows use the same durable schema and event identity as the current
// parser. Version 2 used larger payload bounds and is intentionally rebuilt
// under v3; future incompatible formats can be added here.
const COMPATIBLE_PARSER_VERSIONS = new Set([1, INDEXER_VERSION]);
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "cache",
  ".cache",
  ".pnpm-store",
  ".turbo",
  ".venv",
  ".repos",
  "blobs",
  "Attachments",
  "attachments",
]);

type DiscoveryResult = {
  files: string[];
  accessible: boolean;
  complete: boolean;
  limited: boolean;
};

type SessionScanQueue = {
  files: string[];
  index: number;
  complete: boolean;
  error: string | null;
  bytes: number;
};

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const SOURCE_LABELS: Record<TraceSourceId, string> = {
  codex: "Codex",
  claude: "Claude",
  pi: "Pi",
  omp: "OMP",
  dsh: "DeepSeek Harness",
  custom: "Custom",
};

function isRecord(value: unknown): value is DbRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): DbRow {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + "\n…";
}

function ftsQuery(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((term) => term.replaceAll('"', '""'))
    .filter(Boolean)
    .map((term) => `"${term}"`)
    .join(" AND ");
}

const EVENT_ERROR_SQL = "(LOWER(type) LIKE '%error%' OR LOWER(type) LIKE '%fail%' OR (role = 'tool_result' AND (LOWER(summary) LIKE '%error%' OR LOWER(summary) LIKE '%fail%' OR LOWER(summary) LIKE '%denied%' OR LOWER(summary) LIKE '%exception%' OR LOWER(summary) LIKE '%timeout%')))";
const EVENT_CATEGORY_SQL: Record<TraceEventCategory, string> = {
  user: "role = 'user'",
  assistant: "role = 'assistant'",
  tool: "kind = 'tool'",
  system: "kind = 'system'",
  context: "kind = 'reasoning'",
  telemetry: "kind = 'telemetry'",
  step: "kind = 'step'",
  turn: "kind = 'turn'",
  other: "(kind = 'message' AND role IS NULL)",
};

function eventCategory(kind: string, role: string | null): TraceEventCategory {
  if (role === "user" || role === "assistant") return role;
  if (kind === "tool") return "tool";
  if (kind === "system") return "system";
  if (kind === "telemetry") return "telemetry";
  if (kind === "step") return "step";
  if (kind === "turn") return "turn";
  if (kind === "reasoning") return "context";
  return "other";
}

function isErrorEvent(event: Pick<NormalizedEvent, "type" | "role" | "summary">): boolean {
  return /error|fail/i.test(event.type) || event.role === "tool_result" && /error|fail|denied|exception|timeout/i.test(event.summary);
}

function eventFilterWhere(sessionId: string, input: TraceEventFilters, ftsEnabled: boolean): { where: string; params: unknown[] } {
  const clauses = ["session_id = ?"];
  const params: unknown[] = [sessionId];
  const query = input.query?.trim() ?? "";
  if (query) {
    const like = "%" + query + "%";
    const eventSearch = ftsQuery(query);
    if (ftsEnabled && eventSearch) {
      clauses.push("(type LIKE ? OR role LIKE ? OR title LIKE ? OR summary LIKE ? OR id IN (SELECT event_id FROM trace_event_fts WHERE trace_event_fts MATCH ?))");
      params.push(like, like, like, like, eventSearch);
    } else {
      clauses.push("(type LIKE ? OR role LIKE ? OR title LIKE ? OR summary LIKE ?)");
      params.push(like, like, like, like);
    }
  }
  const categories = [...new Set(input.categories ?? [])].map((category) => EVENT_CATEGORY_SQL[category]).filter(Boolean);
  if (categories.length) clauses.push("(" + categories.join(" OR ") + ")");
  const toolTypes = [...new Set((input.toolTypes ?? []).map((value) => value.trim()).filter(Boolean))];
  if (toolTypes.length) {
    clauses.push("kind = 'tool' AND title IN (" + toolTypes.map(() => "?").join(", ") + ")");
    params.push(...toolTypes);
  }
  if (input.errorFilter === "only") clauses.push(EVENT_ERROR_SQL);
  return { where: " WHERE " + clauses.join(" AND "), params };
}

function normalizeText(value: string): string {
  const bounded = value.length > MAX_EVENT_TEXT ? value.slice(0, MAX_EVENT_TEXT) : value;
  const normalized = bounded.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  return value.length > MAX_EVENT_TEXT ? normalized + "\n…" : normalized;
}

function findString(value: unknown, keys: string[], depth = 0): string | null {
  if (depth > 6 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const found = stringValue(value[key]);
    if (found) return found;
  }
  for (const child of Object.values(value)) {
    const found = findString(child, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

function findNumber(value: unknown, keys: string[], depth = 0): number | null {
  if (depth > 6 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNumber(item, keys, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const found = numberValue(value[key]);
    if (found !== null) return found;
  }
  for (const child of Object.values(value)) {
    const found = findNumber(child, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function textFrom(value: unknown, depth = 0): string {
  if (depth > 5 || value === null || value === undefined) return "";
  if (typeof value === "string") return normalizeText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    let output = "";
    for (const item of value) {
      const part = textFrom(item, depth + 1);
      if (!part) continue;
      output += (output ? "\n" : "") + part;
      if (output.length >= MAX_EVENT_TEXT) return clip(output, MAX_EVENT_TEXT);
    }
    return output;
  }
  if (!isRecord(value)) return "";
  const preferred = [
    "text",
    "message",
    "content",
    "summary",
    "arguments",
    "output",
    "result",
    "error",
    "input",
    "command",
    "description",
    "name",
  ];
  for (const key of preferred) {
    if (value[key] === undefined) continue;
    const found = textFrom(value[key], depth + 1);
    if (found) return found;
  }
  return "";
}

function timestampMs(value: unknown): number | null {
  const numeric = numberValue(value);
  if (numeric !== null) {
    return numeric < 100_000_000_000 ? Math.round(numeric * 1000) : Math.round(numeric);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function humanize(value: string): string {
  return value
    .replace(/[/:_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function usageObject(value: unknown): DbRow | null {
  if (!isRecord(value)) return null;
  const direct = value.usage;
  if (isRecord(direct)) return direct;
  const info = value.info;
  if (isRecord(info) && isRecord(info.total_token_usage)) return info.total_token_usage;
  if (isRecord(value.total_token_usage)) return value.total_token_usage;
  return null;
}

function firstNumber(value: DbRow, keys: string[]): number | null {
  for (const key of keys) {
    const found = numberValue(value[key]);
    if (found !== null) return found;
  }
  return null;
}

function detectRole(type: string, value: DbRow, payload: DbRow): NormalizedEvent["role"] {
  const explicit =
    stringValue(value.role) ??
    stringValue(payload.role) ??
    stringValue(record(payload.message).role) ??
    stringValue(record(payload.data).role);
  if (explicit === "user" || explicit === "human") return "user";
  if (explicit === "assistant" || explicit === "agent") return "assistant";
  if (explicit === "tool") return type.includes("result") ? "tool_result" : "tool";
  if (explicit === "reasoning" || explicit === "thinking") return "reasoning";

  const lower = type.toLowerCase();
  if (lower.includes("tool") || lower.includes("function_call") || lower.includes("function-call")) {
    return lower.includes("result") || lower.includes("output") ? "tool_result" : "tool";
  }
  if (lower.includes("user") || lower === "human") return "user";
  if (lower.includes("assistant") || lower.includes("agent_message")) return "assistant";
  if (lower.includes("reasoning") || lower.includes("thinking")) return "reasoning";
  return null;
}

function detectKind(type: string, role: NormalizedEvent["role"]): NormalizedEvent["kind"] {
  const lower = type.toLowerCase();
  if (lower.includes("token") || lower.includes("usage") || lower.includes("rate_limit")) {
    return "telemetry";
  }
  if (lower.includes("tool") || lower.includes("function_call") || role === "tool" || role === "tool_result") {
    return "tool";
  }
  if (lower.includes("step")) return "step";
  if (lower.includes("turn")) return "turn";
  if (lower.includes("reasoning") || lower.includes("thinking") || role === "reasoning") {
    return "reasoning";
  }
  if (role || lower.includes("message") || lower.includes("response_item")) return "message";
  return "system";
}

function eventDepth(type: string, kind: NormalizedEvent["kind"]): number {
  const lower = type.toLowerCase();
  if (lower.includes("tool/result") || lower.includes("tool_result") || lower.includes("function_call_output")) return 2;
  if (kind === "tool" || lower.includes("step") || lower.includes("reasoning") || lower.includes("text-chunk")) return 1;
  return 0;
}

export function normalizeRecord(value: unknown): NormalizedEvent {
  const top = record(value);
  const payload = record(top.payload ?? top.data ?? top.message);
  const nestedType = stringValue(payload.type);
  const type = nestedType && stringValue(top.type) ? String(top.type) + "/" + nestedType : stringValue(top.type) ?? nestedType ?? "record";
  const role = detectRole(type, top, payload);
  const kind = detectKind(type, role);
  const usage = usageObject(top) ?? usageObject(payload);
  const inputTokens =
    firstNumber(usage ?? {}, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]) ??
    findNumber(top, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
  const outputTokens =
    firstNumber(usage ?? {}, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]) ??
    findNumber(top, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
  const usageIsTotal =
    type.toLowerCase().includes("token_count") ||
    isRecord(record(payload.info).total_token_usage) ||
    isRecord(top.total_token_usage);
  const timestamp =
    timestampMs(top.timestamp) ??
    timestampMs(top.time) ??
    timestampMs(payload.timestamp) ??
    timestampMs(payload.time);
  const durationMs =
    firstNumber(top, ["duration_ms", "durationMs"]) ??
    firstNumber(payload, ["duration_ms", "durationMs"]);
  const turn =
    firstNumber(top, ["turn"]) ??
    firstNumber(payload, ["turn"]) ??
    firstNumber(record(payload.data), ["turn"]);
  const step =
    firstNumber(top, ["step"]) ??
    firstNumber(payload, ["step"]) ??
    firstNumber(record(payload.data), ["step"]);
  const toolName =
    findString(payload, ["name", "toolName", "tool_name"]) ??
    findString(top, ["name", "toolName", "tool_name"]);
  const text = clip(textFrom(payload) || textFrom(top), 20_000);
  const displayType = humanize(type);
  const title = kind === "tool" && toolName ? toolName : role ? humanize(role) : displayType;
  const model =
    findString(top, ["model", "model_id", "modelId"]) ??
    findString(payload, ["model", "model_id", "modelId"]);
  const cwd = findString(top, ["cwd", "working_directory", "workingDirectory"]) ?? findString(payload, ["cwd"]);

  return {
    type: clip(type, 120),
    kind,
    role,
    title: clip(title || displayType || "Event", 160),
    summary: clip(text || title || displayType || "Event", 20_000),
    timestamp,
    durationMs,
    inputTokens,
    outputTokens,
    usageIsTotal,
    turn,
    step,
    depth: eventDepth(type, kind),
    model,
    cwd,
  };
}

export function sourceLabel(source: TraceSourceId): string {
  return SOURCE_LABELS[source];
}

export function sessionIdForPath(source: TraceSourceId, filePath: string): string {
  const digest = createHash("sha1").update(source + "\0" + filePath).digest("hex").slice(0, 24);
  return source + ":" + digest;
}

export function expandConfiguredPaths(value: string, home = homedir()): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item === "~" ? home : item.startsWith("~/") ? join(home, item.slice(2)) : resolve(item)));
}

export function defaultSessionRoots(home = homedir()): RootSpec[] {
  return [
    { id: "dsh-sessions", source: "dsh", label: "DeepSeek Harness sessions", path: join(home, ".dsh", "sessions"), kind: "session", format: "zstd" },
    { id: "claude-projects", source: "claude", label: "Claude projects", path: join(home, ".claude", "projects"), kind: "session", format: "jsonl" },
    { id: "pi-sessions", source: "pi", label: "Pi sessions", path: join(home, ".pi", "agent", "sessions"), kind: "session", format: "jsonl" },
    { id: "omp-sessions", source: "omp", label: "OMP sessions", path: join(home, ".omp", "agent", "sessions"), kind: "session", format: "jsonl" },
    { id: "codex-archive", source: "codex", label: "Codex archived sessions", path: join(home, ".codex", "archived_sessions"), kind: "session", format: "jsonl" },
    { id: "codex-subagents", source: "codex", label: "Codex subagent sessions", path: join(home, ".codex", "pi-subagents-cli", "sessions"), kind: "session", format: "jsonl" },
    { id: "codex-sessions", source: "codex", label: "Codex sessions", path: join(home, ".codex", "sessions"), kind: "session", format: "jsonl" },
  ];
}

async function walkFiles(root: string, signal?: AbortSignal): Promise<DiscoveryResult> {
  const output: string[] = [];
  let accessible = true;
  let complete = true;
  let limited = false;
  let visitedEntries = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (signal?.aborted) {
      accessible = false;
      complete = false;
      return;
    }
    if (output.length >= MAX_SESSION_FILES) {
      complete = false;
      limited = true;
      return;
    }
    if (depth > MAX_SESSION_DEPTH) {
      complete = false;
      limited = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      accessible = false;
      complete = false;
      return;
    }
    for (const entry of entries) {
      if (output.length >= MAX_SESSION_FILES) {
        complete = false;
        limited = true;
        return;
      }
      visitedEntries += 1;
      if (visitedEntries % 256 === 0) await yieldToEventLoop();
      if (signal?.aborted) {
        accessible = false;
        complete = false;
        return;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORY_NAMES.has(entry.name)) {
          await walk(path, depth + 1);
          if (limited) return;
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (lower.endsWith(".jsonl") || lower.endsWith(".jsonl.zst") || lower.endsWith(".jsonl.zstd")) output.push(path);
    }
  }
  try {
    const rootStat = await stat(root);
    if (rootStat.isFile()) return { files: [root], accessible: true, complete: true, limited: false };
  } catch {
    return { files: [], accessible: false, complete: false, limited: false };
  }
  await walk(root, 0);
  output.sort();
  return { files: output, accessible, complete, limited };
}

export async function discoverSessionFiles(root: RootSpec, signal?: AbortSignal): Promise<string[]> {
  return (await walkFiles(root.path, signal)).files;
}

async function discoverSessionFilesWithStatus(root: RootSpec, signal?: AbortSignal): Promise<DiscoveryResult> {
  return walkFiles(root.path, signal);
}

export async function* completeLines(
  input: AsyncIterable<Uint8Array>,
  startByte = 0,
  startLine = 0,
  signal?: AbortSignal,
): AsyncGenerator<TraceLine> {
  let pending = Buffer.alloc(0);
  let offset = startByte;
  let line = startLine;
  for await (const chunk of input) {
    if (signal?.aborted) return;
    pending = pending.length ? Buffer.concat([pending, Buffer.from(chunk)]) : Buffer.from(chunk);
    let newline = pending.indexOf(10);
    while (newline >= 0) {
      const lineBuffer = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      const text = lineBuffer.toString("utf8").replace(/\r$/, "");
      const endByte = offset + newline + 1;
      yield { text, line, startByte: offset, endByte };
      offset = endByte;
      line += 1;
      newline = pending.indexOf(10);
    }
  }
}

async function* fileLines(
  filePath: string,
  format: TraceFormat,
  startByte: number,
  startLine: number,
  endByte?: number,
  signal?: AbortSignal,
): AsyncGenerator<TraceLine> {
  if (format === "jsonl") {
    const stream = createReadStream(filePath, {
      start: startByte,
      ...(endByte !== undefined && endByte > startByte ? { end: endByte - 1 } : {}),
    });
    yield* completeLines(stream, startByte, startLine, signal);
    return;
  }

  const child = spawn("zstd", ["-d", "-c", filePath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const close = new Promise<{ code: number | null; error: Error | null }>((resolveClose) => {
    child.once("error", (error) => resolveClose({ code: null, error }));
    child.once("close", (code) => resolveClose({ code, error: null }));
  });
  try {
    if (!child.stdout) throw new Error("zstd did not provide an output stream");
    yield* completeLines(child.stdout, 0, 0, signal);
  } finally {
    if (signal?.aborted && child.exitCode === null) child.kill("SIGTERM");
  }
  const result = await close;
  if (result.error) throw result.error;
  if (result.code !== 0) throw new Error(stderr.trim() || "zstd could not decompress " + filePath);
}

async function fileFingerprint(filePath: string, byteLength: number, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return null;
  const hash = createHash("sha256");
  if (byteLength === 0) return hash.digest("hex");
  const stream = createReadStream(filePath, { start: 0, end: byteLength - 1 });
  let bytesSinceYield = 0;
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) return null;
      hash.update(chunk);
      bytesSinceYield += chunk.length;
      if (bytesSinceYield >= 4 * 1024 * 1024) {
        bytesSinceYield = 0;
        await yieldToEventLoop();
      }
    }
    return signal?.aborted ? null : hash.digest("hex");
  } finally {
    stream.destroy();
  }
}

function sourceFromRow(row: DbRow): TraceSourceId {
  return String(row.source_id) as TraceSourceId;
}

function emptySession(id: string, source: TraceSourceId, filePath: string, sizeBytes: number): SessionSummary {
  return {
    id,
    source,
    title: basename(filePath),
    filePath,
    model: null,
    cwd: null,
    startedAt: null,
    updatedAt: null,
    eventCount: 0,
    userCount: 0,
    assistantCount: 0,
    toolCount: 0,
    errorCount: 0,
    inputTokens: null,
    outputTokens: null,
    durationMs: null,
    status: "unknown",
    fileSizeBytes: sizeBytes,
  };
}

function rowToSession(row: DbRow): SessionSummary {
  return {
    id: String(row.id),
    source: sourceFromRow(row),
    title: String(row.title),
    filePath: String(row.file_path),
    model: stringValue(row.model),
    cwd: stringValue(row.cwd),
    startedAt: numberValue(row.started_at),
    updatedAt: numberValue(row.updated_at),
    eventCount: numberValue(row.event_count) ?? 0,
    userCount: numberValue(row.user_count) ?? 0,
    assistantCount: numberValue(row.assistant_count) ?? 0,
    toolCount: numberValue(row.tool_count) ?? 0,
    errorCount: numberValue(row.error_count) ?? 0,
    inputTokens: numberValue(row.input_tokens),
    outputTokens: numberValue(row.output_tokens),
    durationMs: numberValue(row.duration_ms),
    status: row.status === "active" || row.status === "completed" ? row.status : "unknown",
    fileSizeBytes: numberValue(row.file_size_bytes) ?? 0,
  };
}

function rowToEvent(row: DbRow): EventSummary {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    line: numberValue(row.line_number) ?? 0,
    type: String(row.type),
    kind: String(row.kind) as NormalizedEvent["kind"],
    role: stringValue(row.role) as NormalizedEvent["role"],
    title: String(row.title),
    summary: String(row.summary),
    timestamp: numberValue(row.timestamp),
    durationMs: numberValue(row.duration_ms),
    inputTokens: numberValue(row.input_tokens),
    outputTokens: numberValue(row.output_tokens),
    usageIsTotal: Boolean(row.usage_is_total),
    turn: numberValue(row.turn),
    step: numberValue(row.step),
    depth: numberValue(row.depth) ?? 0,
    model: stringValue(row.model),
    cwd: stringValue(row.cwd),
    rawJson: String(row.raw_json),
    rawTruncated: Boolean(row.raw_truncated),
  };
}

export function ensureSchema(db: SqliteDb): boolean {
  db.exec(
    "CREATE TABLE IF NOT EXISTS trace_roots (" +
      "id TEXT PRIMARY KEY, source_id TEXT NOT NULL, label TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, " +
      "exists_flag INTEGER NOT NULL DEFAULT 0, file_count INTEGER NOT NULL DEFAULT 0, byte_count INTEGER NOT NULL DEFAULT 0, " +
      "last_scan_at INTEGER, error TEXT" +
      ");" +
      "CREATE TABLE IF NOT EXISTS trace_files (" +
      "path TEXT PRIMARY KEY, root_id TEXT NOT NULL, source_id TEXT NOT NULL, format TEXT NOT NULL, size_bytes INTEGER NOT NULL, " +
      "mtime_ms INTEGER NOT NULL, indexed_bytes INTEGER NOT NULL DEFAULT 0, indexed_lines INTEGER NOT NULL DEFAULT 0, parser_version INTEGER NOT NULL DEFAULT 1, content_hash TEXT, " +
      "session_id TEXT NOT NULL, indexed_at INTEGER NOT NULL, parse_error TEXT" +
      ");" +
      "CREATE TABLE IF NOT EXISTS trace_sessions (" +
      "id TEXT PRIMARY KEY, source_id TEXT NOT NULL, title TEXT NOT NULL, file_path TEXT NOT NULL UNIQUE, model TEXT, cwd TEXT, " +
      "started_at INTEGER, updated_at INTEGER, event_count INTEGER NOT NULL DEFAULT 0, user_count INTEGER NOT NULL DEFAULT 0, " +
      "assistant_count INTEGER NOT NULL DEFAULT 0, tool_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0, " +
      "input_tokens INTEGER, output_tokens INTEGER, duration_ms INTEGER, status TEXT NOT NULL DEFAULT 'unknown', file_size_bytes INTEGER NOT NULL DEFAULT 0" +
      ");" +
      "CREATE TABLE IF NOT EXISTS trace_events (" +
      "id TEXT PRIMARY KEY, session_id TEXT NOT NULL, line_number INTEGER NOT NULL, type TEXT NOT NULL, kind TEXT NOT NULL, role TEXT, " +
      "title TEXT NOT NULL, summary TEXT NOT NULL, timestamp INTEGER, duration_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, " +
      "usage_is_total INTEGER NOT NULL DEFAULT 0, turn INTEGER, step INTEGER, depth INTEGER NOT NULL DEFAULT 0, model TEXT, cwd TEXT, " +
      "raw_json TEXT NOT NULL, raw_truncated INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(session_id) REFERENCES trace_sessions(id) ON DELETE CASCADE" +
      ");" +
      "CREATE INDEX IF NOT EXISTS trace_sessions_updated ON trace_sessions(updated_at DESC);" +
      "CREATE INDEX IF NOT EXISTS trace_sessions_source ON trace_sessions(source_id, updated_at DESC);" +
      "CREATE INDEX IF NOT EXISTS trace_events_session ON trace_events(session_id, line_number);" +
      "CREATE INDEX IF NOT EXISTS trace_events_timestamp ON trace_events(timestamp);",
  );
  const traceFileColumns = new Set(
    (db.prepare("PRAGMA table_info(trace_files)").all() as DbRow[]).map((row) => String(row.name)),
  );
  if (!traceFileColumns.has("parser_version")) {
    db.exec("ALTER TABLE trace_files ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 1;");
  }
  if (!traceFileColumns.has("content_hash")) {
    db.exec("ALTER TABLE trace_files ADD COLUMN content_hash TEXT;");
  }
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS trace_event_fts USING fts5(event_id UNINDEXED, session_id UNINDEXED, content);");
    return true;
  } catch {
    return false;
  }
}

export class TraceIndexer {
  private readonly db: SqliteDb;
  private readonly ftsEnabled: boolean;
  private readonly log: (message: string) => void;
  private readonly sessionScanQueues = new Map<string, SessionScanQueue>();
  private readonly sessionScanPassSeen = new Set<string>();
  private sessionScanPassInvalid = false;
  private statsSnapshot: StatsSnapshot | null = null;
  private statsSnapshotAt = 0;

  constructor(db: SqliteDb, ftsEnabled: boolean, log: (message: string) => void = () => undefined) {
    this.db = db;
    this.ftsEnabled = ftsEnabled;
    this.log = log;
  }

  async scan(
    roots: RootSpec[],
    signal?: AbortSignal,
    options: {
      forceFingerprintPaths?: ReadonlySet<string>;
      forceFingerprintAll?: boolean;
      failedSessionPaths?: Set<string>;
      maxFiles?: number;
    } = {},
  ): Promise<ScanResult> {
    let changed = false;
    const processedPaths: string[] = [];
    let complete = true;
    for (const root of roots) this.ensureRoot(root);
    this.pruneInactiveRoots(roots);

    for (const root of roots) {
      if (signal?.aborted) return { changed, complete: false, processedPaths };
      let queue = this.sessionScanQueues.get(root.id);
      if (!queue) {
        const discovery = await discoverSessionFilesWithStatus(root, signal);
        if (signal?.aborted) return { changed, complete: false, processedPaths };
        queue = {
          files: discovery.files,
          index: 0,
          complete: discovery.complete,
          error: !discovery.accessible
            ? "Root is missing or not readable"
            : !discovery.complete
              ? discovery.limited
                ? "Discovery limit reached; cached rows were preserved"
                : "Discovery incomplete; cached rows were preserved"
              : null,
          bytes: 0,
        };
        this.sessionScanQueues.set(root.id, queue);
        if (!queue.complete) this.sessionScanPassInvalid = true;
      }
      let remainingFiles = options.maxFiles ?? Number.MAX_SAFE_INTEGER;
      while (queue.index < queue.files.length) {
        if (remainingFiles <= 0) {
          complete = false;
          break;
        }
        if (signal?.aborted) return { changed, complete: false, processedPaths };
        if (queue.index % 8 === 0) await yieldToEventLoop();
        const filePath = queue.files[queue.index]!;
        try {
          queue.bytes += (await stat(filePath)).size;
          const forceFingerprintFromPath = options.forceFingerprintPaths?.has(filePath) === true;
          const forceFingerprint = options.forceFingerprintAll === true || forceFingerprintFromPath;
          changed = (await this.indexSessionFile(root, filePath, signal, forceFingerprint)) || changed;
          if (signal?.aborted) return { changed, complete: false, processedPaths };
          queue.index += 1;
          this.sessionScanPassSeen.add(filePath);
          processedPaths.push(filePath);
          remainingFiles -= 1;
        } catch (error) {
          if (signal?.aborted) return { changed, complete: false, processedPaths };
          queue.index += 1;
          this.sessionScanPassSeen.add(filePath);
          options.failedSessionPaths?.add(filePath);
          const message = error instanceof Error ? error.message : String(error);
          queue.error = queue.error ?? message;
          this.log("Could not index " + filePath + ": " + message);
          remainingFiles -= 1;
        }
      }
      this.updateRoot(root, queue.files.length, queue.bytes, queue.error);
      if (queue.index < queue.files.length) {
        complete = false;
        continue;
      }
      this.sessionScanQueues.delete(root.id);
      if (!queue.complete) {
        complete = false;
      }
    }
    if (complete) {
      if (this.sessionScanPassInvalid) {
        this.sessionScanPassSeen.clear();
        this.sessionScanPassInvalid = false;
      } else {
        changed = this.removeMissingSessionFiles(roots, this.sessionScanPassSeen) || changed;
        this.sessionScanPassSeen.clear();
      }
    } else if (this.sessionScanQueues.size === 0 && this.sessionScanPassInvalid) {
      // An inaccessible or bounded discovery completed without a safe file
      // set. Preserve cached rows for this pass, then let the next scan make
      // a fresh discovery that can safely prune rows if the root is readable.
      this.sessionScanPassSeen.clear();
      this.sessionScanPassInvalid = false;
    }
    return { changed, complete, processedPaths };
  }

  listSessions(input: { query?: string; source?: string; errorFilter?: TraceErrorFilter; status?: TraceSessionStatus; hasTools?: boolean; sort?: "updated" | "started" | "events" | "duration" | "errors"; limit: number; offset: number }): { sessions: SessionSummary[]; total: number } {
    const query = input.query?.trim() ?? "";
    const source = input.source?.trim() ?? "";
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (source) {
      clauses.push("source_id = ?");
      params.push(source);
    }
    if (input.errorFilter === "only") clauses.push("COALESCE(error_count, 0) > 0");
    if (input.status) {
      clauses.push("status = ?");
      params.push(input.status);
    }
    if (input.hasTools) clauses.push("COALESCE(tool_count, 0) > 0");
    if (query) {
      const like = "%" + query + "%";
      const eventSearch = ftsQuery(query);
      if (this.ftsEnabled && eventSearch) {
        clauses.push("(id LIKE ? OR source_id LIKE ? OR title LIKE ? OR file_path LIKE ? OR cwd LIKE ? OR model LIKE ? OR id IN (SELECT session_id FROM trace_event_fts WHERE trace_event_fts MATCH ?))");
        params.push(like, like, like, like, like, like, eventSearch);
      } else {
        clauses.push("(id LIKE ? OR source_id LIKE ? OR title LIKE ? OR file_path LIKE ? OR cwd LIKE ? OR model LIKE ? OR id IN (SELECT session_id FROM trace_events WHERE summary LIKE ? OR type LIKE ? OR title LIKE ?))");
        params.push(like, like, like, like, like, like, like, like, like);
      }
    }
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    const totalRow = this.db.prepare("SELECT COUNT(*) AS count FROM trace_sessions" + where).get(...params) as DbRow;
    const orderBy = input.sort === "started"
      ? "COALESCE(started_at, 0) DESC, file_path DESC"
      : input.sort === "events"
        ? "COALESCE(event_count, 0) DESC, COALESCE(updated_at, 0) DESC, file_path DESC"
        : input.sort === "duration"
          ? "COALESCE(duration_ms, -1) DESC, COALESCE(updated_at, 0) DESC, file_path DESC"
          : input.sort === "errors"
            ? "COALESCE(error_count, 0) DESC, COALESCE(updated_at, 0) DESC, file_path DESC"
          : "COALESCE(updated_at, 0) DESC, file_path DESC";
    const rows = this.db
      .prepare("SELECT * FROM trace_sessions" + where + " ORDER BY " + orderBy + " LIMIT ? OFFSET ?")
      .all(...params, input.limit, input.offset) as DbRow[];
    return { sessions: rows.map(rowToSession), total: numberValue(totalRow.count) ?? 0 };
  }

  getSession(sessionId: string, limit: number, offset: number, filters: TraceEventFilters = {}): { session: SessionSummary | null; events: EventSummary[]; totalEvents: number } {
    const decodedSessionId = safeDecodeURIComponent(sessionId);
    const sessionRow = this.db
      .prepare("SELECT * FROM trace_sessions WHERE id = ? OR id = ? OR file_path = ? LIMIT 1")
      .get(sessionId, decodedSessionId, decodedSessionId) as DbRow | undefined;
    if (!sessionRow) return { session: null, events: [], totalEvents: 0 };
    const resolvedSessionId = String(sessionRow.id);
    const filter = eventFilterWhere(resolvedSessionId, filters, this.ftsEnabled);
    const countRow = this.db.prepare("SELECT COUNT(*) AS count FROM trace_events" + filter.where).get(...filter.params) as DbRow;
    const eventRows = this.db
      .prepare("SELECT * FROM trace_events" + filter.where + " ORDER BY line_number ASC LIMIT ? OFFSET ?")
      .all(...filter.params, limit, offset) as DbRow[];
    return {
      session: rowToSession(sessionRow),
      events: eventRows.map(rowToEvent),
      totalEvents: numberValue(countRow.count) ?? 0,
    };
  }

  getSessionFacets(sessionId: string): TraceSessionFacets {
    const decodedSessionId = safeDecodeURIComponent(sessionId);
    const sessionRow = this.db
      .prepare("SELECT * FROM trace_sessions WHERE id = ? OR id = ? OR file_path = ? LIMIT 1")
      .get(sessionId, decodedSessionId, decodedSessionId) as DbRow | undefined;
    if (!sessionRow) return { categories: [], toolTypes: [], errorCount: 0, totalEvents: 0 };
    const resolvedSessionId = String(sessionRow.id);
    const categoryCounts = new Map<TraceEventCategory, number>();
    const categoryRows = this.db
      .prepare("SELECT kind, role, COUNT(*) AS count FROM trace_events WHERE session_id = ? GROUP BY kind, role")
      .all(resolvedSessionId) as DbRow[];
    for (const row of categoryRows) {
      const category = eventCategory(String(row.kind), stringValue(row.role));
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + (numberValue(row.count) ?? 0));
    }
    const toolRows = this.db
      .prepare("SELECT title AS value, COUNT(*) AS count FROM trace_events WHERE session_id = ? AND kind = 'tool' GROUP BY title ORDER BY count DESC, value ASC LIMIT 100")
      .all(resolvedSessionId) as DbRow[];
    const errorRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM trace_events WHERE session_id = ? AND " + EVENT_ERROR_SQL)
      .get(resolvedSessionId) as DbRow;
    return {
      categories: [...categoryCounts.entries()].map(([value, count]) => ({ value, count })).sort((left, right) => right.count - left.count || left.value.localeCompare(right.value)),
      toolTypes: toolRows.map((row) => ({ value: String(row.value), count: numberValue(row.count) ?? 0 })),
      errorCount: numberValue(errorRow.count) ?? 0,
      totalEvents: numberValue(sessionRow.event_count) ?? 0,
    };
  }

  async rawEvent(eventId: string, maxBytes = 2_000_000): Promise<{ raw: string | null; truncated: boolean }> {
    const row = this.db.prepare(
      "SELECT e.raw_json, e.raw_truncated, e.line_number, s.file_path, f.format " +
        "FROM trace_events e JOIN trace_sessions s ON s.id = e.session_id " +
        "LEFT JOIN trace_files f ON f.path = s.file_path WHERE e.id = ?",
    ).get(eventId) as DbRow | undefined;
    if (!row) return { raw: null, truncated: false };
    const storedRaw = String(row.raw_json);
    const lineNumber = numberValue(row.line_number);
    const filePath = stringValue(row.file_path);
    if (lineNumber !== null && filePath) {
      try {
        const format: TraceFormat = row.format === "zstd" ? "zstd" : "jsonl";
        for await (const line of fileLines(filePath, format, 0, 0, undefined)) {
          if (line.line === lineNumber) {
            const raw = clip(line.text, maxBytes);
            return { raw, truncated: raw.length < line.text.length };
          }
          if (line.line > lineNumber) break;
          if (line.line % 256 === 0) await yieldToEventLoop();
        }
      } catch {
        // The source can be rotated or temporarily unavailable. Return the
        // durable preview rather than making the inspector fail completely.
      }
    }
    const raw = clip(storedRaw, maxBytes);
    return { raw, truncated: Boolean(row.raw_truncated) || raw.length < storedRaw.length };
  }

  stats(lastScanAt: number | null, indexing: boolean, lastError: string | null): IndexStats {
    // Do not run three whole-table aggregates while a rebuild is writing. A
    // status request must remain cheap enough for BB's health checks. Return
    // the last completed snapshot during indexing, then refresh it after the
    // scan settles.
    if (!this.statsSnapshot || (!indexing && Date.now() - this.statsSnapshotAt >= 1_000)) {
      if (!indexing || this.statsSnapshot) {
        const sessions = this.db.prepare("SELECT COUNT(*) AS count FROM trace_sessions").get() as DbRow;
        const events = this.db.prepare("SELECT COUNT(*) AS count FROM trace_events").get() as DbRow;
        const bytes = this.db.prepare("SELECT COALESCE(SUM(file_size_bytes), 0) AS total FROM trace_sessions").get() as DbRow;
        this.statsSnapshot = {
          sessions: numberValue(sessions.count) ?? 0,
          events: numberValue(events.count) ?? 0,
          bytes: numberValue(bytes.total) ?? 0,
        };
        this.statsSnapshotAt = Date.now();
      } else {
        this.statsSnapshot = { sessions: 0, events: 0, bytes: 0 };
        this.statsSnapshotAt = Date.now();
      }
    }
    const snapshot = this.statsSnapshot;
    return {
      sessions: snapshot.sessions,
      events: snapshot.events,
      bytes: snapshot.bytes,
      lastScanAt,
      indexing,
      lastError,
    };
  }

  roots(): Array<RootSpec & { exists: boolean; fileCount: number; byteCount: number; lastScanAt: number | null; error: string | null }> {
    const rows = this.db.prepare("SELECT * FROM trace_roots ORDER BY id ASC").all() as DbRow[];
    return rows.map((row) => ({
      id: String(row.id),
      source: String(row.source_id) as RootSpec["source"],
      label: String(row.label),
      path: String(row.path),
      kind: "session",
      format: row.source_id === "dsh" ? "zstd" : "jsonl",
      exists: Boolean(row.exists_flag),
      fileCount: numberValue(row.file_count) ?? 0,
      byteCount: numberValue(row.byte_count) ?? 0,
      lastScanAt: numberValue(row.last_scan_at),
      error: stringValue(row.error),
    }));
  }

  private async indexSessionFile(
    root: RootSpec,
    filePath: string,
    signal?: AbortSignal,
    forceFingerprint = false,
  ): Promise<boolean> {
    const fileStat = await stat(filePath);
    const existingFile = this.db.prepare("SELECT * FROM trace_files WHERE path = ?").get(filePath) as DbRow | undefined;
    const sessionId = String(existingFile?.session_id ?? sessionIdForPath(root.source as TraceSourceId, filePath));
    const existingSessionRow = this.db.prepare("SELECT * FROM trace_sessions WHERE id = ?").get(sessionId) as DbRow | undefined;
    const current = existingSessionRow ? rowToSession(existingSessionRow) : emptySession(sessionId, root.source as TraceSourceId, filePath, fileStat.size);
    const format = root.format ?? "jsonl";
    const mtimeKey = Math.round(fileStat.mtimeMs);
    const existingMtime = numberValue(existingFile?.mtime_ms);
    const existingSize = numberValue(existingFile?.size_bytes) ?? 0;
    const existingIndexedBytes = numberValue(existingFile?.indexed_bytes) ?? 0;
    const existingParserVersion = numberValue(existingFile?.parser_version);
    const parserChanged = Boolean(existingFile) && existingParserVersion !== null && !COMPATIBLE_PARSER_VERSIONS.has(existingParserVersion);
    const sameSize = existingSize === fileStat.size;
    const mtimeChanged = existingMtime === null || Math.round(existingMtime) !== mtimeKey;
    const existingComplete = Boolean(existingFile) && !parserChanged && existingIndexedBytes >= existingSize;
    const unchanged = existingComplete && sameSize && !mtimeChanged && !forceFingerprint;
    // A complete file does not need to be opened again until its size or mtime
    // changes. This is especially important for compressed JSONL, which cannot
    // be resumed at a byte offset and would otherwise be decompressed on every
    // background pass.
    if (unchanged) return false;
    const existingHash = stringValue(existingFile?.content_hash);
    let existingPrefixMatches: boolean | null = null;
    if (existingFile && !parserChanged && (mtimeChanged || forceFingerprint) && existingHash) {
      const fingerprint = await fileFingerprint(filePath, existingSize, signal);
      if (signal?.aborted) return false;
      const currentStat = await stat(filePath);
      existingPrefixMatches = currentStat.size >= existingSize && fingerprint === existingHash;
      const metadataStillMatches = currentStat.size === fileStat.size && Math.round(currentStat.mtimeMs) === mtimeKey;
      if (existingComplete && sameSize && metadataStillMatches && existingPrefixMatches) {
        // A metadata-only touch does not represent a new parse. Persist the
        // new mtime so the same file is not hashed on every safety sweep.
        this.db.prepare("UPDATE trace_files SET mtime_ms = ? WHERE path = ?").run(mtimeKey, filePath);
        return false;
      }
    } else if (existingFile && !parserChanged && (mtimeChanged || forceFingerprint) && !existingHash) {
      // Rows from the pre-fingerprint schema cannot prove that a growing file
      // is an append, or that the file was not rewritten before the first
      // fingerprint sweep. Reparse once rather than risk retaining stale
      // events; the replacement stores a hash for all later scans.
      existingPrefixMatches = false;
    }
    // The first prefix probe can race with the full pre-parse snapshot. Check
    // the old indexed prefix again after that snapshot so an in-place rewrite
    // cannot be mistaken for a safe append to the old event rows.
    const parseStartHash = await fileFingerprint(filePath, fileStat.size, signal);
    if (signal?.aborted) return false;
    if (!parseStartHash) return false;
    const parseStartStat = await stat(filePath);
    if (parseStartStat.size !== fileStat.size || Math.round(parseStartStat.mtimeMs) !== mtimeKey) {
      throw new Error("Trace file changed while preparing to index; retrying");
    }
    if (existingFile && !parserChanged && format !== "zstd" && existingHash && existingSize <= fileStat.size) {
      const parseStartPrefixHash = await fileFingerprint(filePath, existingSize, signal);
      if (signal?.aborted) return false;
      if (parseStartPrefixHash !== existingHash) existingPrefixMatches = false;
    }
    const reset =
      format === "zstd" ||
      !existingFile ||
      existingSize > fileStat.size ||
      existingIndexedBytes > fileStat.size ||
      parserChanged ||
      (sameSize && mtimeChanged) ||
      (existingFile && !parserChanged && existingPrefixMatches === false);
    const startByte = reset ? 0 : existingIndexedBytes;
    const startLine = reset ? 0 : numberValue(existingFile?.indexed_lines) ?? 0;
    let aggregate = reset ? emptySession(sessionId, root.source as TraceSourceId, filePath, fileStat.size) : current;
    let indexedBytes = startByte;
    let indexedLines = startLine;
    let parseError: string | null = null;
    let firstTimestamp: number | null = reset ? null : aggregate.startedAt;
    let lastTimestamp: number | null = reset ? null : aggregate.updatedAt;
    let firstUserTitle: string | null = reset || aggregate.title === basename(filePath) ? null : aggregate.title;
    let totalInput = reset ? null : aggregate.inputTokens;
    let totalOutput = reset ? null : aggregate.outputTokens;

    this.db.exec("BEGIN");
    try {
      if (reset) {
        // Keep the old rows inside this transaction. A failed or cancelled
        // replacement must leave the last complete session readable.
        if (this.ftsEnabled) this.db.prepare("DELETE FROM trace_event_fts WHERE session_id = ?").run(sessionId);
        aggregate = emptySession(sessionId, root.source as TraceSourceId, filePath, fileStat.size);
      }
      this.db.prepare(
        "INSERT INTO trace_sessions (id, source_id, title, file_path, file_size_bytes, status) VALUES (?, ?, ?, ?, ?, 'unknown') " +
          "ON CONFLICT(id) DO UPDATE SET file_path = excluded.file_path, file_size_bytes = excluded.file_size_bytes",
      ).run(sessionId, root.source, aggregate.title, filePath, fileStat.size);
      const upsertEvent = this.db.prepare(
        "INSERT INTO trace_events (id, session_id, line_number, type, kind, role, title, summary, timestamp, duration_ms, input_tokens, output_tokens, usage_is_total, turn, step, depth, model, cwd, raw_json, raw_truncated) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET type = excluded.type, kind = excluded.kind, role = excluded.role, title = excluded.title, summary = excluded.summary, " +
          "timestamp = excluded.timestamp, duration_ms = excluded.duration_ms, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, usage_is_total = excluded.usage_is_total, " +
          "turn = excluded.turn, step = excluded.step, depth = excluded.depth, model = excluded.model, cwd = excluded.cwd, raw_json = excluded.raw_json, raw_truncated = excluded.raw_truncated",
      );
      const insertFts = this.ftsEnabled ? this.db.prepare("INSERT INTO trace_event_fts (event_id, session_id, content) VALUES (?, ?, ?)") : null;
      const deleteFtsEvent = this.ftsEnabled && !reset
        ? this.db.prepare("DELETE FROM trace_event_fts WHERE event_id = ? AND session_id = ?")
        : null;
      for await (const line of fileLines(filePath, format, startByte, startLine, fileStat.size, signal)) {
        if (signal?.aborted) break;
        const relativeLine = line.line - startLine;
        if (relativeLine === 0 || relativeLine % 8 === 0) {
          await yieldToEventLoop();
        }
        if (signal?.aborted) break;
        indexedBytes = line.endByte;
        indexedLines = line.line + 1;
        if (reset) {
          // Replacements are line-addressed. Remove the previous value before
          // handling blank or malformed lines, then trim any old tail below.
          this.db.prepare("DELETE FROM trace_events WHERE session_id = ? AND line_number = ?").run(sessionId, line.line);
        }
        if (!line.text.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line.text);
        } catch (error) {
          parseError = parseError ?? String(error);
          continue;
        }
        const event = normalizeRecord(parsed);
        const eventId = sessionId + ":" + line.line;
        const storedRaw = clip(line.text, MAX_RAW_JSON);
        upsertEvent.run(
          eventId,
          sessionId,
          line.line,
          event.type,
          event.kind,
          event.role,
          event.title,
          event.summary,
          event.timestamp,
          event.durationMs,
          event.inputTokens,
          event.outputTokens,
          event.usageIsTotal ? 1 : 0,
          event.turn,
          event.step,
          event.depth,
          event.model,
          event.cwd,
          storedRaw,
          storedRaw.length < line.text.length ? 1 : 0,
        );
        if (this.ftsEnabled) {
          deleteFtsEvent?.run(eventId, sessionId);
          insertFts?.run(eventId, sessionId, event.type + " " + event.title + " " + event.summary);
        }
        aggregate.eventCount += 1;
        if (event.role === "user") aggregate.userCount += 1;
        if (event.role === "assistant") aggregate.assistantCount += 1;
        if (event.kind === "tool") aggregate.toolCount += 1;
        if (isErrorEvent(event)) {
          aggregate.errorCount += 1;
        }
        if (event.timestamp !== null) {
          firstTimestamp = firstTimestamp === null ? event.timestamp : Math.min(firstTimestamp, event.timestamp);
          lastTimestamp = lastTimestamp === null ? event.timestamp : Math.max(lastTimestamp, event.timestamp);
        }
        if (!firstUserTitle && event.role === "user" && event.summary.length > 0) firstUserTitle = clip(event.summary.split("\n")[0] ?? event.summary, 180);
        if (!aggregate.model && event.model) aggregate.model = event.model;
        if (!aggregate.cwd && event.cwd) aggregate.cwd = event.cwd;
        if (event.usageIsTotal) {
          if (event.inputTokens !== null) totalInput = Math.max(totalInput ?? 0, event.inputTokens);
          if (event.outputTokens !== null) totalOutput = Math.max(totalOutput ?? 0, event.outputTokens);
        } else {
          if (event.inputTokens !== null) totalInput = (totalInput ?? 0) + event.inputTokens;
          if (event.outputTokens !== null) totalOutput = (totalOutput ?? 0) + event.outputTokens;
        }
      }
      if (signal?.aborted) {
        this.db.exec("ROLLBACK");
        return false;
      }
      if (reset) {
        this.db.prepare("DELETE FROM trace_events WHERE session_id = ? AND line_number >= ?").run(sessionId, indexedLines);
      }
      const contentHash = await fileFingerprint(filePath, fileStat.size, signal);
      if (signal?.aborted) {
        this.db.exec("ROLLBACK");
        return false;
      }
      // The file may have been appended or rewritten while it was being
      // parsed. Roll back so the next watcher/safety scan can read one stable
      // version instead of pairing events with a different content hash.
      const finalStat = await stat(filePath);
      if (
        finalStat.size !== fileStat.size ||
        Math.round(finalStat.mtimeMs) !== mtimeKey ||
        contentHash !== parseStartHash
      ) {
        throw new Error("Trace file changed while indexing; retrying");
      }
      aggregate.title = firstUserTitle ?? aggregate.title;
      aggregate.startedAt = firstTimestamp;
      aggregate.updatedAt = lastTimestamp ?? fileStat.mtimeMs;
      aggregate.durationMs =
        aggregate.startedAt !== null && aggregate.updatedAt !== null
          ? Math.max(0, aggregate.updatedAt - aggregate.startedAt)
          : null;
      aggregate.inputTokens = totalInput;
      aggregate.outputTokens = totalOutput;
      const latestType = String((this.db.prepare("SELECT type FROM trace_events WHERE session_id = ? ORDER BY line_number DESC LIMIT 1").get(sessionId) as DbRow | undefined)?.type ?? "");
      aggregate.status = /(complete|turn[\/_ -]?end|task[\/_ -]?complete|session[\/_ -]?end|run[\/_ -]?end)/i.test(latestType)
        ? "completed"
        : aggregate.eventCount > 0
          ? "active"
          : "unknown";
      this.db.prepare(
        "UPDATE trace_sessions SET source_id = ?, title = ?, file_path = ?, model = ?, cwd = ?, started_at = ?, updated_at = ?, event_count = ?, user_count = ?, assistant_count = ?, tool_count = ?, error_count = ?, input_tokens = ?, output_tokens = ?, duration_ms = ?, status = ?, file_size_bytes = ? WHERE id = ?",
      ).run(
        aggregate.source,
        aggregate.title,
        filePath,
        aggregate.model,
        aggregate.cwd,
        aggregate.startedAt,
        aggregate.updatedAt,
        aggregate.eventCount,
        aggregate.userCount,
        aggregate.assistantCount,
        aggregate.toolCount,
        aggregate.errorCount,
        aggregate.inputTokens,
        aggregate.outputTokens,
        aggregate.durationMs,
        aggregate.status,
        fileStat.size,
        sessionId,
      );
      this.db.prepare(
        "INSERT INTO trace_files (path, root_id, source_id, format, size_bytes, mtime_ms, indexed_bytes, indexed_lines, parser_version, content_hash, session_id, indexed_at, parse_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(path) DO UPDATE SET root_id = excluded.root_id, source_id = excluded.source_id, format = excluded.format, size_bytes = excluded.size_bytes, mtime_ms = excluded.mtime_ms, indexed_bytes = excluded.indexed_bytes, indexed_lines = excluded.indexed_lines, parser_version = excluded.parser_version, content_hash = excluded.content_hash, session_id = excluded.session_id, indexed_at = excluded.indexed_at, parse_error = excluded.parse_error",
      ).run(filePath, root.id, root.source, format, fileStat.size, mtimeKey, format === "zstd" ? fileStat.size : indexedBytes, indexedLines, INDEXER_VERSION, contentHash, sessionId, Date.now(), parseError);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original indexing error.
      }
      throw error;
    }
  }

  private updateRoot(root: RootSpec, fileCount: number, byteCount: number, error: string | null): void {
    const existsFlag = existsSync(root.path) ? 1 : 0;
    this.db.prepare(
      "INSERT INTO trace_roots (id, source_id, label, path, kind, exists_flag, file_count, byte_count, last_scan_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET source_id = excluded.source_id, label = excluded.label, path = excluded.path, kind = excluded.kind, exists_flag = excluded.exists_flag, file_count = excluded.file_count, byte_count = excluded.byte_count, last_scan_at = excluded.last_scan_at, error = excluded.error",
    ).run(root.id, root.source, root.label, root.path, root.kind, existsFlag, fileCount, byteCount, Date.now(), error);
  }

  private ensureRoot(root: RootSpec): void {
    const existsFlag = existsSync(root.path) ? 1 : 0;
    this.db.prepare(
      "INSERT INTO trace_roots (id, source_id, label, path, kind, exists_flag, file_count, byte_count, last_scan_at, error) VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL) " +
        "ON CONFLICT(id) DO UPDATE SET source_id = excluded.source_id, label = excluded.label, path = excluded.path, kind = excluded.kind, exists_flag = excluded.exists_flag",
    ).run(root.id, root.source, root.label, root.path, root.kind, existsFlag);
  }

  private removeMissingSessionFiles(roots: RootSpec[], seen: Set<string>): boolean {
    const rootIds = roots.map((root) => root.id);
    if (!rootIds.length) return false;
    let changed = false;
    const rows = this.db.prepare("SELECT path, root_id, session_id FROM trace_files").all() as DbRow[];
    for (const row of rows) {
      if (!rootIds.includes(String(row.root_id)) || seen.has(String(row.path))) continue;
      changed = true;
      const sessionId = String(row.session_id);
      this.db.prepare("DELETE FROM trace_files WHERE path = ?").run(String(row.path));
      this.db.prepare("DELETE FROM trace_events WHERE session_id = ?").run(sessionId);
      if (this.ftsEnabled) this.db.prepare("DELETE FROM trace_event_fts WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM trace_sessions WHERE id = ?").run(sessionId);
    }
    return changed;
  }

  private pruneInactiveRoots(sessionRoots: RootSpec[]): void {
    const active = new Set(sessionRoots.map((root) => root.id));
    for (const rootId of this.sessionScanQueues.keys()) {
      if (!active.has(rootId)) this.sessionScanQueues.delete(rootId);
    }
    const rootRows = this.db.prepare("SELECT id, kind FROM trace_roots").all() as DbRow[];
    for (const row of rootRows) {
      if (active.has(String(row.id))) continue;
      const rootId = String(row.id);
      if (row.kind === "session") {
        const files = this.db.prepare("SELECT path, session_id FROM trace_files WHERE root_id = ?").all(rootId) as DbRow[];
        for (const file of files) {
          const path = String(file.path);
          const sessionId = String(file.session_id);
          this.db.prepare("DELETE FROM trace_files WHERE path = ?").run(path);
          this.db.prepare("DELETE FROM trace_events WHERE session_id = ?").run(sessionId);
          if (this.ftsEnabled) this.db.prepare("DELETE FROM trace_event_fts WHERE session_id = ?").run(sessionId);
          this.db.prepare("DELETE FROM trace_sessions WHERE id = ?").run(sessionId);
        }
      }
      this.db.prepare("DELETE FROM trace_roots WHERE id = ?").run(rootId);
    }
  }
}

function safeDecodeURIComponent(value: string): string {
  let decoded = value;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded;
      decoded = next;
    } catch {
      return decoded;
    }
  }
  return decoded;
}
