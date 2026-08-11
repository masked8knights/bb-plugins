import type {
  SessionTraceEntry,
  SessionTraceKind,
  SessionTraceStatus,
  TranscriptMessage,
} from "./types";

/** Keep the inspector useful without turning one RPC response into a dump. */
export const MAX_TRACE_ENTRIES = 240;
export const MAX_TRACE_TEXT = 12_000;
/** Keep agent/RPC projections bounded even when all entries are individually large. */
export const MAX_TRACE_RESPONSE_CHARS = 120_000;

const TRACE_KINDS = new Set<SessionTraceKind>([
  "user",
  "assistant",
  "tool",
  "system",
]);
const TRACE_STATUSES = new Set<SessionTraceStatus>([
  "running",
  "completed",
  "failed",
  "interrupted",
  "unknown",
]);

export function limitTraceText(value: string, max = MAX_TRACE_TEXT): string {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max)}\n… (entry truncated)` : text;
}

export function capTraceEntries(
  entries: SessionTraceEntry[],
  maxChars = MAX_TRACE_RESPONSE_CHARS,
): { entries: SessionTraceEntry[]; truncated: boolean } {
  const output: SessionTraceEntry[] = [];
  let size = 2;
  let truncated = false;
  for (const entry of entries) {
    const separatorSize = output.length ? 1 : 0;
    const entrySize = JSON.stringify(entry).length;
    if (size + separatorSize + entrySize > maxChars) {
      if (output.length === 0) {
        const fitted = fitTraceEntry(entry, Math.max(0, maxChars - size));
        if (fitted) {
          output.push(fitted);
          size += JSON.stringify(fitted).length;
        }
      }
      truncated = true;
      break;
    }
    output.push(entry);
    size += separatorSize + entrySize;
  }
  if (output.length < entries.length) truncated = true;
  return { entries: output, truncated };
}

function fitTraceEntry(entry: SessionTraceEntry, maxChars: number): SessionTraceEntry | null {
  const base: SessionTraceEntry = {
    ...entry,
    id: entry.id.slice(0, 256),
    title: entry.title.slice(0, 256),
    text: "",
    toolName: entry.toolName?.slice(0, 256) ?? null,
  };
  if (JSON.stringify(base).length > maxChars) return null;
  let low = 0;
  let high = entry.text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { ...base, text: entry.text.slice(0, middle) };
    if (JSON.stringify(candidate).length <= maxChars) low = middle;
    else high = middle - 1;
  }
  return { ...base, text: entry.text.slice(0, low) };
}

export function traceFromMessages(messages: TranscriptMessage[]): SessionTraceEntry[] {
  return messages.slice(0, MAX_TRACE_ENTRIES).map((message, index) => ({
    id: `message-${index + 1}`,
    kind: message.role,
    title: message.role === "user" ? "User" : "Assistant",
    text: limitTraceText(message.text),
    timestamp: message.ts ?? null,
    status: "completed",
    toolName: null,
    sourceSequence: index + 1,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeEntry(value: unknown, index: number): SessionTraceEntry | null {
  if (!isRecord(value)) return null;
  const kind = stringValue(value.kind, "system") as SessionTraceKind;
  const status = stringValue(value.status, "unknown") as SessionTraceStatus;
  return {
    id: stringValue(value.id, `entry-${index + 1}`),
    kind: TRACE_KINDS.has(kind) ? kind : "system",
    title: stringValue(value.title, kind === "tool" ? "Tool call" : "Event"),
    text: limitTraceText(stringValue(value.text, "No content")),
    timestamp: numberValue(value.timestamp, null),
    status: TRACE_STATUSES.has(status) ? status : "unknown",
    toolName: typeof value.toolName === "string" && value.toolName.trim() ? value.toolName.trim() : null,
    sourceSequence: numberValue(value.sourceSequence, index + 1) ?? index + 1,
  };
}

/**
 * Read a stored trace defensively. Older databases have no trace column, and
 * malformed provider data should degrade to the already-indexed transcript.
 */
export function parseStoredTrace(
  raw: string | null | undefined,
  transcript: string,
): { entries: SessionTraceEntry[]; truncated: boolean } {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const entries = parsed
          .map((value, index) => normalizeEntry(value, index))
          .filter((value): value is SessionTraceEntry => value !== null)
          .slice(0, MAX_TRACE_ENTRIES);
        if (entries.length > 0) {
          return { entries, truncated: parsed.length > entries.length };
        }
      }
    } catch {
      // Fall through to the transcript projection.
    }
  }
  return { entries: traceFromTranscript(transcript), truncated: false };
}

export function traceFromTranscript(transcript: string): SessionTraceEntry[] {
  const sections = transcript
    .split(/\n\n(?=## (?:User|Assistant)\s*\n)/u)
    .map((section) => section.trim())
    .filter(Boolean);
  return sections.slice(0, MAX_TRACE_ENTRIES).flatMap((section, index) => {
    const match = /^## (User|Assistant)\s*\n\n?([\s\S]*)$/u.exec(section);
    if (!match) return [];
    const kind = match[1]!.toLowerCase() as "user" | "assistant";
    return [{
      id: `message-${index + 1}`,
      kind,
      title: match[1]!,
      text: limitTraceText(match[2]!),
      timestamp: null,
      status: "completed" as const,
      toolName: null,
      sourceSequence: index + 1,
    }];
  });
}
