import type { SessionTraceEntry, SessionTraceKind } from "./types";

export type TraceTimelineMode = "sequence" | "duration";
export type TraceTimelineLane = "input" | "model" | "tools";
export type TraceTimingSource = "measured" | "inferred" | "unknown";

export interface TraceTimelineSpan {
  entryId: string;
  sourceSequence: number;
  kind: SessionTraceKind;
  lane: TraceTimelineLane;
  title: string;
  start: number;
  end: number;
  durationMs: number | null;
  timingSource: TraceTimingSource;
  status: SessionTraceEntry["status"];
}

export interface TraceTimelineModel {
  start: number;
  end: number;
  spans: TraceTimelineSpan[];
  hasTiming: boolean;
}

export interface TraceSection {
  label: "Input" | "Output" | "Error" | "Schema" | "Details";
  text: string;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function laneFor(kind: SessionTraceKind): TraceTimelineLane {
  if (kind === "tool") return "tools";
  if (kind === "assistant") return "model";
  return "input";
}

/** Resolve one event's measured or safely inferred wall-clock duration. */
export function traceEntryDurationMs(
  entry: SessionTraceEntry,
  next: SessionTraceEntry | undefined,
): { durationMs: number | null; source: TraceTimingSource } {
  const measured = entry.metrics?.durationMs;
  if (finite(measured)) return { durationMs: Math.max(0, measured), source: "measured" };
  if (finite(entry.timestamp) && finite(next?.timestamp) && next.timestamp > entry.timestamp) {
    return { durationMs: next.timestamp - entry.timestamp, source: "inferred" };
  }
  return { durationMs: null, source: "unknown" };
}

function timelineTitle(entry: SessionTraceEntry): string {
  return entry.toolName ?? (entry.title || (entry.kind === "tool" ? "Tool" : entry.kind));
}

/** Build the compact overview projection used by the trace view. */
export function buildTraceTimeline(
  entries: readonly SessionTraceEntry[],
  mode: TraceTimelineMode,
): TraceTimelineModel | null {
  if (entries.length === 0) return null;

  if (mode === "sequence") {
    return {
      start: 0,
      end: entries.length,
      hasTiming: entries.some((entry) => finite(entry.timestamp) || finite(entry.metrics?.durationMs)),
      spans: entries.map((entry, index) => ({
        entryId: entry.id,
        sourceSequence: entry.sourceSequence,
        kind: entry.kind,
        lane: laneFor(entry.kind),
        title: timelineTitle(entry),
        start: index,
        end: index + 1,
        durationMs: finite(entry.metrics?.durationMs) ? Math.max(0, entry.metrics!.durationMs!) : null,
        timingSource: finite(entry.metrics?.durationMs) ? "measured" : "unknown",
        status: entry.status,
      })),
    };
  }

  const firstTimestamp = entries
    .map((entry) => entry.timestamp)
    .find((timestamp): timestamp is number => finite(timestamp));
  const hasTiming = entries.some((entry, index) => {
    const timing = traceEntryDurationMs(entry, entries[index + 1]);
    return timing.source !== "unknown" || finite(entry.timestamp);
  });
  const base = firstTimestamp ?? 0;
  let cursor = 0;
  const spans = entries.map((entry, index) => {
    const timing = traceEntryDurationMs(entry, entries[index + 1]);
    const timestampStart = finite(entry.timestamp) ? Math.max(0, entry.timestamp - base) : null;
    // Keep known timestamps anchored to the provider clock. The cursor only
    // positions records that have no timestamp; measured events may overlap.
    const start = timestampStart === null ? cursor : timestampStart;
    const end = timing.durationMs === null ? start : start + timing.durationMs;
    cursor = Math.max(cursor, end);
    return {
      entryId: entry.id,
      sourceSequence: entry.sourceSequence,
      kind: entry.kind,
      lane: laneFor(entry.kind),
      title: timelineTitle(entry),
      start,
      end,
      durationMs: timing.durationMs,
      timingSource: timing.source,
      status: entry.status,
    } satisfies TraceTimelineSpan;
  });

  // With no clock data, preserve a readable sequence of unknown markers. The
  // marker position is not presented as a duration and never affects timing
  // labels beyond showing that timing is unavailable.
  if (!hasTiming) {
    return {
      start: 0,
      end: Math.max(1, entries.length),
      hasTiming: false,
      spans: spans.map((span, index) => ({ ...span, start: index, end: index })),
    };
  }

  return {
    start: 0,
    end: Math.max(1, ...spans.map((span) => span.end), ...spans.map((span) => span.start)),
    hasTiming,
    spans,
  };
}

/** Find records active in an inclusive timeline selection. */
export function traceTimelineFocusIndexes(
  entries: readonly SessionTraceEntry[],
  range: { start: number; end: number },
  mode: TraceTimelineMode,
): ReadonlySet<string> {
  const model = buildTraceTimeline(entries, mode);
  if (model === null) return new Set();
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  return new Set(
    model.spans
      .filter((span) => span.end === span.start
        ? span.start >= start && span.start <= end
        : span.start <= end && span.end >= start)
      .map((span) => span.entryId),
  );
}

/** Convert a pair of span indexes into the numeric range used by focus state. */
export function traceTimelineRangeForIndexes(
  model: TraceTimelineModel,
  startIndex: number,
  endIndex: number,
): { start: number; end: number } | null {
  if (model.spans.length === 0) return null;
  const clamp = (index: number) => Math.min(model.spans.length - 1, Math.max(0, index));
  const start = model.spans[clamp(startIndex)]!;
  const end = model.spans[clamp(endIndex)]!;
  return {
    start: Math.min(start.start, end.start),
    end: Math.max(start.end, end.end),
  };
}

export function formatTraceDuration(milliseconds: number | null): string {
  if (!finite(milliseconds)) return "—";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
  const roundedSeconds = Math.round(seconds);
  return `${Math.floor(roundedSeconds / 60)}m ${roundedSeconds % 60}s`;
}

export function formatTraceTime(timestamp: number | null): string {
  if (!finite(timestamp)) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  }).format(new Date(timestamp));
}

/** Split provider tool text into the same compact payload/result sections as the upstream inspector. */
export function traceContentSections(text: string): TraceSection[] {
  const parts = text
    .split(/\n\n(?=(?:Input|Output|Error|Schema)(?::|\n))/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return [{ label: "Details", text: "No content captured for this entry." }];
  return parts.map((part) => {
    const match = /^(Input|Output|Error|Schema)(?::\s*|\n)([\s\S]*)$/u.exec(part);
    if (!match) return { label: "Details", text: part };
    return {
      label: match[1] as TraceSection["label"],
      text: match[2] || "No content captured for this section.",
    };
  });
}

export function traceSectionText(
  entry: SessionTraceEntry,
  label: TraceSection["label"],
): string | null {
  const section = traceContentSections(entry.text).find((candidate) => candidate.label === label);
  return section?.text ?? null;
}

export function tracePreview(text: string, max = 120): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
