import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { SessionTraceEntry, SessionTraceKind } from "./types";
import {
  buildTraceTimeline,
  formatTraceDuration,
  formatTraceTime,
  traceContentSections,
  traceEntryDurationMs,
  tracePreview,
  traceSectionText,
  traceTimelineFocusIndexes,
  traceTimelineRangeForIndexes,
  type TraceSection,
  type TraceTimelineMode,
  type TraceTimelineModel,
} from "./trace-view-model";

type TraceInspectorTab = "summary" | "payload" | "result" | "schema" | "timing";

const INSPECTOR_TABS: Array<{ id: TraceInspectorTab; label: string }> = [
  { id: "summary", label: "Summary" },
  { id: "payload", label: "Payload" },
  { id: "result", label: "Result" },
  { id: "schema", label: "Schema" },
  { id: "timing", label: "Timing" },
];

const KIND_META: Record<SessionTraceKind, {
  label: string;
  lane: string;
  tag: string;
  icon: string;
}> = {
  user: {
    label: "USER",
    lane: "Input",
    tag: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    icon: "U",
  },
  assistant: {
    label: "ASSISTANT",
    lane: "Model",
    tag: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    icon: "A",
  },
  tool: {
    label: "TOOL",
    lane: "Tools",
    tag: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    icon: "T",
  },
  system: {
    label: "SYSTEM",
    lane: "Input",
    tag: "border-border bg-muted text-muted-foreground",
    icon: "S",
  },
};

const LANE_META = [
  { id: "input", label: "Input", color: "bg-emerald-400" },
  { id: "model", label: "Model", color: "bg-violet-400" },
  { id: "tools", label: "Tools", color: "bg-amber-400" },
] as const;

function statusLabel(status: SessionTraceEntry["status"]): string {
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  if (status === "interrupted") return "Interrupted";
  return "Unknown";
}

function statusClass(status: SessionTraceEntry["status"]): string {
  if (status === "failed") return "text-destructive";
  if (status === "running") return "text-amber-600 dark:text-amber-400";
  if (status === "completed") return "text-emerald-700 dark:text-emerald-400";
  return "text-muted-foreground";
}

function entryLabel(entry: SessionTraceEntry): string {
  return entry.toolName ?? (entry.title || (entry.kind === "tool" ? "Tool call" : KIND_META[entry.kind].label));
}

function entryDuration(
  entries: readonly SessionTraceEntry[],
  index: number,
): { durationMs: number | null; source: "measured" | "inferred" | "unknown" } {
  return traceEntryDurationMs(entries[index]!, entries[index + 1]);
}

function spanStyle(
  span: TraceTimelineModel["spans"][number],
  model: TraceTimelineModel,
): { left: string; width: string } {
  const domain = Math.max(1, model.end - model.start);
  const left = ((span.start - model.start) / domain) * 100;
  const width = Math.max(1.4, ((span.end - span.start) / domain) * 100);
  return { left: `${Math.max(0, left)}%`, width: `${Math.min(100, width)}%` };
}

function spanTone(span: TraceTimelineModel["spans"][number]): string {
  if (span.status === "failed") return "bg-destructive";
  if (span.status === "running") return "bg-amber-400";
  if (span.lane === "input") return "bg-emerald-400";
  if (span.lane === "model") return "bg-violet-400";
  return "bg-amber-400";
}

function timelineTooltip(
  entry: SessionTraceEntry,
  timing: ReturnType<typeof traceEntryDurationMs>,
): string {
  const details = [
    entryLabel(entry),
    statusLabel(entry.status),
    timing.durationMs === null ? "Timing unavailable" : formatTraceDuration(timing.durationMs),
    entry.timestamp === null ? null : formatTraceTime(entry.timestamp),
  ].filter((value): value is string => value !== null);
  return details.join(" · ");
}

function TraceTimeline({
  entries,
  mode,
  selectedId,
  range,
  onModeChange,
  onSelect,
  onRangeChange,
}: {
  entries: readonly SessionTraceEntry[];
  mode: TraceTimelineMode;
  selectedId: string;
  range: { start: number; end: number } | null;
  onModeChange: (mode: TraceTimelineMode) => void;
  onSelect: (id: string) => void;
  onRangeChange: (range: { start: number; end: number } | null) => void;
}) {
  const model = useMemo(() => buildTraceTimeline(entries, mode), [entries, mode]);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startTime: number; moved: boolean } | null>(null);
  const keyboardAnchorRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const [draftRange, setDraftRange] = useState<{ start: number; end: number } | null>(null);
  const focusRange = draftRange ?? range;

  const timeAt = (clientX: number): number | null => {
    if (!model || !trackRef.current) return null;
    const rect = trackRef.current.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
    return model.start + fraction * Math.max(1, model.end - model.start);
  };

  const selectedSpanId = (event: ReactPointerEvent<HTMLDivElement>): string | null => {
    const target = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>("[data-trace-span-id]")
      : null;
    return target?.dataset.traceSpanId ?? null;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !model) return;
    const startTime = timeAt(event.clientX);
    if (startTime === null) return;
    suppressClickRef.current = false;
    keyboardAnchorRef.current = null;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startTime, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDraftRange({ start: startTime, end: startTime });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - drag.startX) >= 4) drag.moved = true;
    const endTime = timeAt(event.clientX);
    if (endTime !== null) setDraftRange({ start: Math.min(drag.startTime, endTime), end: Math.max(drag.startTime, endTime) });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const spanId = selectedSpanId(event);
    const endTime = timeAt(event.clientX) ?? drag.startTime;
    const nextRange = { start: Math.min(drag.startTime, endTime), end: Math.max(drag.startTime, endTime) };
    dragRef.current = null;
    setDraftRange(null);
    if (!drag.moved && spanId) {
      onRangeChange(null);
      onSelect(spanId);
      return;
    }
    if (!drag.moved) {
      onRangeChange(null);
      return;
    }
    keyboardAnchorRef.current = null;
    suppressClickRef.current = true;
    onRangeChange(nextRange);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!model) return;
    if (event.key === "Escape") {
      if (!range) return;
      event.preventDefault();
      keyboardAnchorRef.current = null;
      onRangeChange(null);
      return;
    }

    const focusedSpanId = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-trace-span-id]")?.dataset.traceSpanId
      : null;
    const focusedIndex = focusedSpanId === undefined || focusedSpanId === null
      ? -1
      : model.spans.findIndex((span) => span.entryId === focusedSpanId);
    const selectedIndex = model.spans.findIndex((span) => span.entryId === selectedId);
    const currentIndex = focusedIndex >= 0 ? focusedIndex : Math.max(0, selectedIndex);
    const targetIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? model.spans.length - 1
        : event.key === "ArrowLeft"
          ? Math.max(0, currentIndex - 1)
          : event.key === "ArrowRight"
            ? Math.min(model.spans.length - 1, currentIndex + 1)
            : null;
    if (targetIndex === null) return;
    event.preventDefault();
    if (event.shiftKey) {
      const anchor = keyboardAnchorRef.current ?? currentIndex;
      keyboardAnchorRef.current = anchor;
      onRangeChange(traceTimelineRangeForIndexes(model, anchor, targetIndex));
    } else {
      keyboardAnchorRef.current = targetIndex;
      onRangeChange(null);
    }
    const targetEntryId = model.spans[targetIndex]!.entryId;
    onSelect(targetEntryId);
    const timeline = event.currentTarget;
    requestAnimationFrame(() => {
      const nextButton = Array.from(timeline.querySelectorAll<HTMLElement>("[data-trace-span-id]")).find(
        (candidate) => candidate.dataset.traceSpanId === targetEntryId,
      );
      nextButton?.focus();
    });
  };

  if (!model) return null;
  const domain = Math.max(1, model.end - model.start);
  const selectionStyle = focusRange
    ? {
        left: `${((Math.min(focusRange.start, focusRange.end) - model.start) / domain) * 100}%`,
        width: `${Math.max(0.7, (Math.abs(focusRange.end - focusRange.start) / domain) * 100)}%`,
      }
    : undefined;

  return (
    <section aria-label="Trace overview" className="border-b border-border bg-background">
      <p className="sr-only" aria-live="polite">
        {range ? "Timeline range focus active. Use Shift plus arrow keys to extend it, or Escape to clear it." : "Timeline range focus cleared."}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="text-xs font-semibold text-foreground">Overview</h3>
          <span className="truncate text-[11px] text-muted-foreground">
            {entries.length} events{mode === "duration" && !model.hasTiming ? " · timing unavailable" : ""}
          </span>
        </div>
        <div className="flex overflow-hidden rounded-md border border-border" role="group" aria-label="Trace overview mode">
          {(["sequence", "duration"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={mode === option}
              onClick={() => onModeChange(option)}
              className={`px-2.5 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${mode === option ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {option === "sequence" ? "Sequence" : "Duration"}
            </button>
          ))}
        </div>
      </div>
      <div
        tabIndex={0}
        role="group"
        aria-label="Trace event timeline. Click an event to inspect it or drag to focus a range. Use arrow keys to move, Shift plus arrow keys to extend a range, and Escape to clear it."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragRef.current = null;
          suppressClickRef.current = false;
          setDraftRange(null);
        }}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={onKeyDown}
        className="grid grid-cols-[52px_minmax(0,1fr)] gap-2 px-3 py-3 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="flex flex-col justify-between py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {LANE_META.map((lane) => <span key={lane.id}>{lane.label}</span>)}
        </div>
        <div ref={trackRef} className="relative flex flex-col gap-1.5">
          {selectionStyle && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 z-10 rounded-sm bg-foreground/10 ring-1 ring-foreground/25" style={selectionStyle} />}
          {LANE_META.map((lane) => (
            <div key={lane.id} className="relative h-3 rounded-sm bg-muted/50">
              {model.spans.filter((span) => span.lane === lane.id).map((span) => {
                const entry = entries.find((candidate) => candidate.id === span.entryId)!;
                const selected = selectedId === span.entryId;
                const style = spanStyle(span, model);
                const duration = entryDuration(entries, entries.indexOf(entry));
                return (
                  <button
                    key={span.entryId}
                    type="button"
                    data-trace-span-id={span.entryId}
                    aria-label={timelineTooltip(entry, duration)}
                    title={timelineTooltip(entry, duration)}
                    onClick={(event) => {
                      if (suppressClickRef.current) {
                        suppressClickRef.current = false;
                        event.preventDefault();
                        event.stopPropagation();
                        return;
                      }
                      event.stopPropagation();
                      onRangeChange(null);
                      onSelect(span.entryId);
                    }}
                    className={`absolute inset-y-0 z-20 min-w-[3px] rounded-[2px] opacity-85 transition-[filter,opacity] hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/70 ${spanTone(span)} ${selected ? "z-30 opacity-100 ring-2 ring-foreground" : ""}`}
                    style={style}
                  />
                );
              })}
            </div>
          ))}
          <div className="flex justify-between pt-0.5 text-[10px] tabular-nums text-muted-foreground">
            <span>{mode === "duration" && model.hasTiming ? formatTraceDuration(model.start) : "0"}</span>
            <span>{mode === "duration" && model.hasTiming ? formatTraceDuration(model.end) : `${entries.length} events`}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function TraceLedger({
  entries,
  selectedId,
  focusedIds,
  truncated,
  onSelect,
  onClearFocus,
}: {
  entries: readonly SessionTraceEntry[];
  selectedId: string;
  focusedIds: ReadonlySet<string> | null;
  truncated: boolean;
  onSelect: (id: string) => void;
  onClearFocus: () => void;
}) {
  const visible = focusedIds === null ? entries : entries.filter((entry) => focusedIds.has(entry.id));
  let previousTurn: string | null = null;
  return (
    <div className="flex min-h-0 min-w-0 flex-col border-b border-border md:border-b-0 md:border-r">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold text-foreground">Trace ledger</h3>
          <p className="truncate text-[11px] text-muted-foreground">
            {focusedIds === null ? "Chronological event stream" : `Focused on ${visible.length} of ${entries.length} events`}
          </p>
        </div>
        {focusedIds !== null && (
          <button type="button" onClick={onClearFocus} className="shrink-0 rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            Clear focus
          </button>
        )}
      </div>
      <ol aria-label="Trace events" className="min-h-0 flex-1 overflow-y-auto py-1">
        {visible.map((entry) => {
          const originalIndex = entries.indexOf(entry);
          const timing = entryDuration(entries, originalIndex);
          const meta = KIND_META[entry.kind];
          const selected = entry.id === selectedId;
          const sourceSequences = entry.sourceSequences?.length ? entry.sourceSequences : [entry.sourceSequence];
          const sourceLabel = sourceSequences.length > 1
            ? `#${sourceSequences[0]}–${sourceSequences[sourceSequences.length - 1]}`
            : `#${entry.sourceSequence}`;
          const turn = entry.metrics?.turnId ?? null;
          const showTurn = turn !== null && turn !== previousTurn;
          previousTurn = turn;
          return (
            <li key={entry.id}>
              {showTurn && <div className="border-y border-border/60 bg-muted/25 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Turn {turn}</div>}
              <button
                type="button"
                aria-current={selected ? "true" : undefined}
                aria-label={`${meta.label}: ${entryLabel(entry)}. ${statusLabel(entry.status)}. Event ${entry.sourceSequence}.`}
                onClick={() => onSelect(entry.id)}
                className={`group grid w-full min-w-0 grid-cols-[34px_76px_minmax(0,1fr)_64px] items-center gap-2 px-3 py-2 text-left transition-colors focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${selected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`}
              >
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground" title={sourceSequences.length > 1 ? `${sourceSequences.length} source records` : undefined}>{sourceLabel}</span>
                <span className={`w-fit rounded border px-1.5 py-0.5 text-[9px] font-semibold tracking-wide ${meta.tag}`}>{meta.label}</span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{entryLabel(entry)}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{tracePreview(entry.text, 96) || "No content"}</span>
                </span>
                <span className="flex min-w-0 flex-col items-end gap-0.5 text-[10px] tabular-nums">
                  <span className={statusClass(entry.status)}>{statusLabel(entry.status)}</span>
                  <span title={timing.source === "inferred" ? "Inferred from adjacent event timestamps" : undefined}>{formatTraceDuration(timing.durationMs)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {truncated && <p className="border-t border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">This trace is bounded for large sessions. Open the raw transcript below for the indexed conversation.</p>}
    </div>
  );
}

function DetailGrid({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-y border-border py-3 sm:grid-cols-3">{children}</dl>;
}

function DetailField({ label, value, className = "" }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-xs text-foreground" title={typeof value === "string" ? value : undefined}>{value}</dd>
    </div>
  );
}

function PayloadBlock({ label, text, error = false }: { label: string; text: string; error?: boolean }) {
  return (
    <div className={`overflow-hidden border ${error ? "border-destructive/50 bg-destructive/5" : "border-border bg-muted/20"}`}>
      <div className="border-b border-border/70 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <pre className="max-h-[30rem] overflow-auto whitespace-pre-wrap break-words bg-background/40 px-3 py-3 font-mono text-xs leading-6 text-foreground">{text || "No content captured for this section."}</pre>
    </div>
  );
}

function SummaryTab({ entry, nextEntry }: { entry: SessionTraceEntry; nextEntry?: SessionTraceEntry }) {
  const timing = traceEntryDurationMs(entry, nextEntry);
  const sections = traceContentSections(entry.text);
  const preview = sections.find((section) => section.label === "Output")?.text
    ?? sections.find((section) => section.label === "Details")?.text
    ?? sections[0]?.text
    ?? "No content captured for this entry.";
  return (
    <div className="space-y-4">
      <DetailGrid>
        <DetailField label="Hierarchy" value={entry.metrics?.turnId ? `Turn ${entry.metrics.turnId}` : "Trace event"} />
        <DetailField label="Status" value={<span className={statusClass(entry.status)}>{statusLabel(entry.status)}</span>} />
        <DetailField label="Event" value={entry.sourceSequence} />
        <DetailField label="Started" value={formatTraceTime(entry.timestamp)} />
        <DetailField label="Duration" value={formatTraceDuration(timing.durationMs)} />
        <DetailField label="Timing source" value={timing.source === "measured" ? "Provider" : timing.source === "inferred" ? "Adjacent events" : "Unavailable"} />
      </DetailGrid>
      <div>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Preview</div>
        <div className="max-h-[20rem] overflow-auto whitespace-pre-wrap break-words border border-border bg-muted/20 px-3 py-3 text-sm leading-6 text-foreground">{preview}</div>
      </div>
      {entry.kind === "tool" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Payload</div>
            <div className="max-h-32 overflow-auto whitespace-pre-wrap break-words border border-border bg-muted/20 px-3 py-2 font-mono text-[11px] leading-5 text-foreground">{(traceSectionText(entry, "Input") ?? tracePreview(entry.text, 600)) || "No payload captured."}</div>
          </div>
          <div className="min-w-0">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Result</div>
            <div className="max-h-32 overflow-auto whitespace-pre-wrap break-words border border-border bg-muted/20 px-3 py-2 font-mono text-[11px] leading-5 text-foreground">{traceSectionText(entry, "Output") ?? traceSectionText(entry, "Error") ?? "No result captured."}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function sectionsFor(entry: SessionTraceEntry, labels: TraceSection["label"][]): TraceSection[] {
  return traceContentSections(entry.text).filter((section) => labels.includes(section.label));
}

function PayloadTab({ entry }: { entry: SessionTraceEntry }) {
  const sections = sectionsFor(entry, ["Input", "Details"]);
  return <div className="space-y-3">{(sections.length ? sections : [{ label: "Details" as const, text: entry.text || "No payload captured." }]).map((section, index) => <PayloadBlock key={`${section.label}-${index}`} label={section.label} text={section.text} />)}</div>;
}

function ResultTab({ entry }: { entry: SessionTraceEntry }) {
  const sections = sectionsFor(entry, ["Output", "Error"]);
  if (!sections.length) return <p className="border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">No result captured for this event.</p>;
  return <div className="space-y-3">{sections.map((section, index) => <PayloadBlock key={`${section.label}-${index}`} label={section.label} text={section.text} error={section.label === "Error"} />)}</div>;
}

function SchemaTab({ entry }: { entry: SessionTraceEntry }) {
  const metadata = {
    kind: entry.kind,
    title: entry.title,
    toolName: entry.toolName,
    eventType: entry.metrics?.eventType ?? null,
    errorCategory: entry.metrics?.errorCategory ?? null,
    turnId: entry.metrics?.turnId ?? null,
    usageScope: entry.metrics?.usageScope ?? null,
    sourceSequence: entry.sourceSequence,
  };
  return (
    <div className="space-y-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Captured event metadata</div>
      <pre className="max-h-[34rem] overflow-auto whitespace-pre-wrap break-words border border-border bg-muted/20 px-3 py-3 font-mono text-xs leading-6 text-foreground">{JSON.stringify(metadata, null, 2)}</pre>
      <p className="text-[11px] leading-relaxed text-muted-foreground">Provider schemas are only shown when the source emits them. The bounded trace projection never re-reads raw provider files in the browser.</p>
    </div>
  );
}

function TimingTab({ entries, index, entry }: { entries: readonly SessionTraceEntry[]; index: number; entry: SessionTraceEntry }) {
  const timing = entryDuration(entries, index);
  const metrics = entry.metrics;
  const usageLabel = metrics?.usageScope === "turn" ? "Turn usage (latest snapshot)" : "Usage";
  const tokenRows = [
    ["Input", metrics?.inputTokens],
    ["Cache read", metrics?.cachedInputTokens],
    ["Cache write", metrics?.cachedWriteTokens],
    ["Output", metrics?.outputTokens],
    ["Reasoning", metrics?.reasoningTokens],
    ["Total", metrics?.totalTokens],
  ] as const;
  return (
    <div className="space-y-4">
      <DetailGrid>
        <DetailField label="Started" value={formatTraceTime(entry.timestamp)} />
        <DetailField label="Duration" value={formatTraceDuration(timing.durationMs)} />
        <DetailField label="Source" value={metrics?.usageScope === "turn" ? "Provider turn snapshot" : timing.source === "measured" ? "Provider telemetry" : timing.source === "inferred" ? "Adjacent timestamps" : "Unavailable"} />
        <DetailField label="Event" value={entry.sourceSequence} />
        <DetailField label="Turn" value={metrics?.turnId ?? "—"} />
        <DetailField label="Context" value={metrics?.contextUsed == null ? "—" : metrics.contextLimit ? `${metrics.contextUsed} / ${metrics.contextLimit}` : String(metrics.contextUsed)} />
      </DetailGrid>
      <div>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{usageLabel}</div>
        <div className="divide-y divide-border border-y border-border">
          {tokenRows.map(([label, value]) => <div key={label} className="flex items-center justify-between gap-3 py-2 text-xs"><span className="text-muted-foreground">{label}</span><span className="font-mono tabular-nums text-foreground">{value == null ? "—" : value.toLocaleString()}</span></div>)}
        </div>
      </div>
    </div>
  );
}

function TraceInspector({ entries, index, entry }: { entries: readonly SessionTraceEntry[]; index: number; entry: SessionTraceEntry }) {
  const [tab, setTab] = useState<TraceInspectorTab>("summary");
  useEffect(() => setTab("summary"), [entry.id]);
  const nextEntry = entries[index + 1];
  const meta = KIND_META[entry.kind];
  const selectTab = (next: TraceInspectorTab) => setTab(next);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <span className="sr-only" aria-live="polite">{meta.label} event {entry.sourceSequence} selected. {statusLabel(entry.status)}. {tracePreview(entry.text) || "No content"}.</span>
      <div className="border-b border-border px-4 py-4">
        <div className="flex items-start gap-3">
          <span className={`flex size-8 shrink-0 items-center justify-center rounded-md border text-xs font-semibold ${meta.tag}`}>{meta.icon}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">{entryLabel(entry)}</h3>
              <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${meta.tag}`}>{meta.label}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              <span className={statusClass(entry.status)}>{statusLabel(entry.status)}</span>
              <span className="font-mono text-muted-foreground">event {entry.sourceSequence}</span>
              {entry.timestamp !== null && <span className="text-muted-foreground">{formatTraceTime(entry.timestamp)}</span>}
            </div>
          </div>
        </div>
      </div>
      <div className="flex overflow-x-auto border-b border-border px-3" role="tablist" aria-label="Trace event details">
        {INSPECTOR_TABS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={tab === option.id}
            tabIndex={tab === option.id ? 0 : -1}
            onClick={() => selectTab(option.id)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const current = INSPECTOR_TABS.findIndex((candidate) => candidate.id === tab);
              const next = event.key === "Home" ? 0 : event.key === "End" ? INSPECTOR_TABS.length - 1 : (current + (event.key === "ArrowLeft" ? -1 : 1) + INSPECTOR_TABS.length) % INSPECTOR_TABS.length;
              const nextTab = INSPECTOR_TABS[next]!;
              setTab(nextTab.id);
              requestAnimationFrame(() => document.getElementById(`trace-inspector-tab-${nextTab.id}`)?.focus());
            }}
            id={`trace-inspector-tab-${option.id}`}
            className={`shrink-0 border-b-2 px-2.5 py-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${tab === option.id ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={`${tab} details`} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {tab === "summary" && <SummaryTab entry={entry} nextEntry={nextEntry} />}
        {tab === "payload" && <PayloadTab entry={entry} />}
        {tab === "result" && <ResultTab entry={entry} />}
        {tab === "schema" && <SchemaTab entry={entry} />}
        {tab === "timing" && <TimingTab entries={entries} index={index} entry={entry} />}
      </div>
    </div>
  );
}

export function TraceExplorer({ entries, truncated }: { entries: readonly SessionTraceEntry[]; truncated: boolean }) {
  const firstId = entries[0]?.id ?? "";
  const [selectedId, setSelectedId] = useState(firstId);
  const [mode, setMode] = useState<TraceTimelineMode>("sequence");
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  useEffect(() => {
    if (!entries.some((entry) => entry.id === selectedId)) setSelectedId(entries[0]?.id ?? "");
  }, [entries, selectedId]);
  useEffect(() => setRange(null), [entries]);

  const focusedIds = useMemo(
    () => range === null ? null : traceTimelineFocusIndexes(entries, range, mode),
    [entries, mode, range],
  );
  const selectedIndex = Math.max(0, entries.findIndex((entry) => entry.id === selectedId));
  const selectedEntry = entries[selectedIndex] ?? entries[0];
  if (!selectedEntry) return <div className="border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">No trace events captured.</div>;

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card" aria-label="Trace inspector">
      <TraceTimeline
        entries={entries}
        mode={mode}
        selectedId={selectedId}
        range={range}
        onModeChange={(next) => { setMode(next); setRange(null); }}
        onSelect={setSelectedId}
        onRangeChange={setRange}
      />
      <div className="grid min-h-[540px] md:grid-cols-[minmax(0,1fr)_minmax(340px,40%)]">
        <TraceLedger
          entries={entries}
          selectedId={selectedEntry.id}
          focusedIds={focusedIds}
          truncated={truncated}
          onSelect={setSelectedId}
          onClearFocus={() => setRange(null)}
        />
        <TraceInspector entries={entries} index={selectedIndex} entry={selectedEntry} />
      </div>
    </section>
  );
}
