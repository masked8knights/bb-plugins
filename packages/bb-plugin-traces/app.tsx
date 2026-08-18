import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, TraceArtifact, TraceEvent, TraceSession, TraceStatus } from "./server";

const buttonClass =
  "inline-flex min-h-8 items-center justify-center rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const primaryButtonClass =
  "inline-flex min-h-8 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const inputClass =
  "h-8 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring";

function formatTime(timestamp: number | null): string {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function formatClock(timestamp: number | null): string {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return bytes + " B";
  if (bytes < 1_000_000) return (bytes / 1_000).toFixed(1) + " KB";
  if (bytes < 1_000_000_000) return (bytes / 1_000_000).toFixed(1) + " MB";
  return (bytes / 1_000_000_000).toFixed(1) + " GB";
}

function formatTokens(value: number | null): string {
  if (value === null) return "—";
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return (value / 1_000).toFixed(1) + "k";
  return (value / 1_000_000).toFixed(1) + "m";
}

function formatDuration(value: number | null): string {
  if (value === null) return "—";
  if (value < 1_000) return Math.round(value) + " ms";
  const seconds = value / 1_000;
  if (seconds < 60) return seconds.toFixed(1) + " s";
  return Math.floor(seconds / 60) + "m " + Math.round(seconds % 60) + "s";
}

function sourceClass(source: string): string {
  if (source === "dsh") return "border-primary/30 bg-primary/10 text-primary";
  if (source === "claude") return "border-warning/30 bg-warning/10 text-warning";
  if (source === "pi" || source === "omp") return "border-success/30 bg-success/10 text-success";
  return "border-border bg-muted text-muted-foreground";
}

function kindClass(kind: TraceEvent["kind"]): string {
  if (kind === "tool") return "text-warning";
  if (kind === "message") return "text-primary";
  if (kind === "reasoning") return "text-muted-foreground";
  if (kind === "telemetry") return "text-success";
  return "text-foreground";
}

function shortText(value: string, max = 260): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : text.slice(0, max) + "…";
}

function StatusDot({ status }: { status: TraceStatus | null }) {
  const color = !status
    ? "text-muted-foreground"
    : status.state === "indexing"
      ? "text-warning"
      : status.state === "error"
        ? "text-destructive"
        : "text-success";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={"size-2 rounded-full bg-current " + color} aria-hidden="true" />
      {status?.state === "indexing" ? "Indexing locally" : status?.state === "error" ? "Index needs attention" : "Local index ready"}
    </span>
  );
}

function SourceBadge({ source }: { source: string }) {
  const label =
    source === "dsh"
      ? "DeepSeek"
      : source === "codex"
        ? "Codex"
        : source === "claude"
          ? "Claude"
          : source === "pi"
            ? "Pi"
            : source === "omp"
              ? "OMP"
              : source;
  return (
    <span className={"inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium " + sourceClass(source)}>
      {label}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{value}</span>
      {label}
    </div>
  );
}

function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: TraceSession;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={
        "block w-full border-b border-border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring " +
        (selected ? "bg-primary/10" : "hover:bg-state-hover")
      }
      onClick={onSelect}
      aria-pressed={selected}
    >
      <div className="flex items-start gap-2">
        <SourceBadge source={session.source} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{session.title}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{formatTime(session.updatedAt)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>{session.eventCount} events</span>
        <span>{session.toolCount} tools</span>
        <span>{formatDuration(session.durationMs)}</span>
        {session.status === "active" ? <span className="text-success">active</span> : null}
        {session.errorCount > 0 ? <span className="text-destructive">{session.errorCount} errors</span> : null}
      </div>
      {session.cwd ? <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{session.cwd}</div> : null}
    </button>
  );
}

function TimelineOverview({ events }: { events: TraceEvent[] }) {
  const timed = events.filter((event) => event.timestamp !== null);
  const start = timed.length ? Math.min(...timed.map((event) => event.timestamp ?? 0)) : 0;
  const end = timed.length ? Math.max(...timed.map((event) => (event.timestamp ?? 0) + (event.durationMs ?? 1))) : 1;
  const span = Math.max(1, end - start);
  return (
    <div className="rounded-md border border-border bg-muted/20 p-2">
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>Timing overview</span>
        <span>{formatDuration(end - start)}</span>
      </div>
      <div className="relative h-7 overflow-hidden rounded-sm bg-muted">
        {events.slice(-160).map((event, index) => {
          const position = event.timestamp === null ? index / Math.max(1, events.length) : ((event.timestamp - start) / span);
          const width = event.durationMs ? Math.max(0.004, event.durationMs / span) : 0.008;
          return (
            <span
              key={event.id}
              className={"absolute top-1 h-5 rounded-sm opacity-80 " + (event.kind === "tool" ? "bg-warning" : event.kind === "message" ? "bg-primary" : "bg-success")}
              style={{ left: Math.min(0.99, Math.max(0, position)) * 100 + "%", width: Math.min(0.2, width) * 100 + "%" }}
              title={event.title + " · " + formatClock(event.timestamp)}
            />
          );
        })}
      </div>
    </div>
  );
}

function EventLedger({
  events,
  selectedId,
  onSelect,
}: {
  events: TraceEvent[];
  selectedId: string | null;
  onSelect: (event: TraceEvent) => void;
}) {
  if (!events.length) {
    return <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">No indexed events in this session yet.</div>;
  }
  return (
    <div className="min-h-0 overflow-auto rounded-md border border-border">
      {events.map((event) => (
        <button
          type="button"
          key={event.id}
          className={
            "block w-full border-b border-border px-3 py-2 text-left last:border-b-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring " +
            (selectedId === event.id ? "bg-primary/10" : "hover:bg-state-hover")
          }
          style={{ paddingLeft: 12 + Math.min(event.depth, 4) * 18 }}
          onClick={() => onSelect(event)}
          aria-pressed={selectedId === event.id}
        >
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="w-12 shrink-0 font-mono">#{event.line}</span>
            <span className={"font-medium " + kindClass(event.kind)}>{event.type}</span>
            <span className="ml-auto shrink-0">{formatClock(event.timestamp)}</span>
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{event.title}</span>
            {event.durationMs !== null ? <span className="shrink-0 text-[10px] text-muted-foreground">{formatDuration(event.durationMs)}</span> : null}
          </div>
          <div className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">{shortText(event.summary)}</div>
          {event.inputTokens !== null || event.outputTokens !== null ? (
            <div className="mt-1 flex gap-3 text-[10px] text-muted-foreground">
              <span>in {formatTokens(event.inputTokens)}</span>
              <span>out {formatTokens(event.outputTokens)}</span>
            </div>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function SessionInspector({ event, raw }: { event: TraceEvent | null; raw: string | null }) {
  if (!event) {
    return (
      <div className="flex min-h-28 items-center justify-center rounded-md border border-dashed border-border px-4 text-center text-xs text-muted-foreground">
        Select a row to inspect its payload and timing.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-muted/20">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{event.title}</div>
          <div className="text-[11px] text-muted-foreground">{event.type} · line {event.line}</div>
        </div>
        <div className="flex gap-3 text-[10px] text-muted-foreground">
          <span>{formatClock(event.timestamp)}</span>
          <span>{formatDuration(event.durationMs)}</span>
        </div>
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
        {raw ?? event.rawJson}
      </pre>
      {event.rawTruncated ? <div className="border-t border-border px-3 py-2 text-[10px] text-warning">Payload preview is truncated; the source session file remains unchanged.</div> : null}
    </div>
  );
}

function SessionDetail({
  session,
  events,
  totalEvents,
  selectedEvent,
  raw,
  onSelectEvent,
}: {
  session: TraceSession | null;
  events: TraceEvent[];
  totalEvents: number;
  selectedEvent: TraceEvent | null;
  raw: string | null;
  onSelectEvent: (event: TraceEvent) => void;
}) {
  if (!session) {
    return (
      <div className="flex min-h-[20rem] flex-1 items-center justify-center p-8 text-center lg:min-h-0">
        <div>
          <div className="text-sm font-medium text-foreground">Select a session</div>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">The index is local-only. Choose a session to inspect its turns, tools, timing, and raw event payloads.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-[28rem] min-w-0 flex-1 flex-col gap-3 overflow-auto p-3 lg:min-h-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <SourceBadge source={session.source} />
            <h2 className="truncate text-base font-semibold text-foreground">{session.title}</h2>
            {session.status === "active" ? <span className="text-xs text-success">live</span> : null}
          </div>
          <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{session.filePath}</div>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-right">
          <Stat label="events" value={String(totalEvents)} />
          <Stat label="tools" value={String(session.toolCount)} />
          <Stat label="input" value={formatTokens(session.inputTokens)} />
          <Stat label="output" value={formatTokens(session.outputTokens)} />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-y border-border py-2 text-[11px] text-muted-foreground">
        <span>started {formatTime(session.startedAt)}</span>
        <span>updated {formatTime(session.updatedAt)}</span>
        <span>duration {formatDuration(session.durationMs)}</span>
        <span>{formatBytes(session.fileSizeBytes)} source</span>
        {session.model ? <span className="font-mono">{session.model}</span> : null}
      </div>
      <TimelineOverview events={events} />
      {totalEvents > events.length ? <div className="text-[11px] text-muted-foreground">Showing the first {events.length} of {totalEvents} indexed events.</div> : null}
      <EventLedger events={events} selectedId={selectedEvent?.id ?? null} onSelect={onSelectEvent} />
      <SessionInspector event={selectedEvent} raw={raw} />
    </div>
  );
}

function ArtifactList({
  artifacts,
  selectedId,
  onSelect,
}: {
  artifacts: TraceArtifact[];
  selectedId: string | null;
  onSelect: (artifact: TraceArtifact) => void;
}) {
  if (!artifacts.length) {
    return <div className="p-4 text-sm text-muted-foreground">No decision or context files found in the detected roots.</div>;
  }
  return (
    <div>
      {artifacts.map((artifact) => (
        <button
          type="button"
          key={artifact.id}
          className={
            "block w-full border-b border-border px-3 py-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring " +
            (selectedId === artifact.id ? "bg-primary/10" : "hover:bg-state-hover")
          }
          onClick={() => onSelect(artifact)}
          aria-pressed={selectedId === artifact.id}
        >
          <div className="flex items-center gap-2">
            <span className={"rounded-full border px-2 py-0.5 text-[11px] " + (artifact.kind === "decision" ? "border-warning/30 bg-warning/10 text-warning" : "border-border bg-muted text-muted-foreground")}>
              {artifact.kind}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{artifact.title}</span>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">{formatTime(artifact.updatedAt)} · {formatBytes(artifact.sizeBytes)}</div>
          <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{artifact.filePath}</div>
        </button>
      ))}
    </div>
  );
}

function ArtifactDetail({ artifact }: { artifact: TraceArtifact | null }) {
  if (!artifact) {
    return <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">Select a decision or context file.</div>;
  }
  return (
    <div className="min-h-[24rem] min-w-0 flex-1 overflow-auto p-4 lg:min-h-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className={"rounded-full border px-2 py-0.5 text-[11px] " + (artifact.kind === "decision" ? "border-warning/30 bg-warning/10 text-warning" : "border-border bg-muted text-muted-foreground")}>
          {artifact.kind}
        </span>
        <h2 className="text-base font-semibold text-foreground">{artifact.title}</h2>
      </div>
      <div className="mt-2 break-all font-mono text-[11px] text-muted-foreground">{artifact.filePath}</div>
      <pre className="mt-4 whitespace-pre-wrap break-words rounded-md border border-border bg-muted/20 p-4 font-mono text-xs leading-relaxed text-foreground">{artifact.preview}</pre>
    </div>
  );
}

function TracesPanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [status, setStatus] = useState<TraceStatus | null>(null);
  const [sessions, setSessions] = useState<TraceSession[]>([]);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [artifacts, setArtifacts] = useState<TraceArtifact[]>([]);
  const [view, setView] = useState<"sessions" | "artifacts">("sessions");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [session, setSession] = useState<TraceSession | null>(null);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [totalEvents, setTotalEvents] = useState(0);
  const [selectedEvent, setSelectedEvent] = useState<TraceEvent | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<TraceArtifact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextSessions, nextArtifacts] = await Promise.all([
        rpc.call("status", null),
        rpc.call("listSessions", { query: query || undefined, source: source || undefined, limit: 100, offset: 0 }),
        rpc.call("listArtifacts", { query: query || undefined, limit: 100, offset: 0 }),
      ]);
      setStatus(nextStatus);
      setSessions(nextSessions.sessions);
      setSessionTotal(nextSessions.total);
      setArtifacts(nextArtifacts.artifacts);
      setError(null);
      if (selectedSessionId && !nextSessions.sessions.some((item) => item.id === selectedSessionId)) setSelectedSessionId(nextSessions.sessions[0]?.id ?? null);
      if (!selectedSessionId && nextSessions.sessions[0]) setSelectedSessionId(nextSessions.sessions[0].id);
      if (selectedArtifactId && !nextArtifacts.artifacts.some((item) => item.id === selectedArtifactId)) setSelectedArtifactId(nextArtifacts.artifacts[0]?.id ?? null);
      if (!selectedArtifactId && nextArtifacts.artifacts[0]) setSelectedArtifactId(nextArtifacts.artifacts[0].id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc, query, source, selectedSessionId, selectedArtifactId]);

  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 120);
    return () => clearTimeout(timer);
  }, [refresh]);

  useRealtime("traces", () => {
    void refresh();
  });

  useEffect(() => {
    if (connection === "connected" || connection === "reconnecting") void refresh();
  }, [connection, refresh]);

  useEffect(() => {
    if (!selectedSessionId) {
      setSession(null);
      setEvents([]);
      setSelectedEvent(null);
      return;
    }
    let cancelled = false;
    void rpc.call("getSession", { id: selectedSessionId, limit: 1_000, offset: 0 }).then((result) => {
      if (cancelled) return;
      setSession(result.session);
      setEvents(result.events);
      setTotalEvents(result.totalEvents);
      setSelectedEvent(null);
      setRaw(null);
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [rpc, selectedSessionId]);

  useEffect(() => {
    if (!selectedEvent) {
      setRaw(null);
      return;
    }
    let cancelled = false;
    void rpc.call("getEventRaw", { id: selectedEvent.id }).then((result) => {
      if (!cancelled) setRaw(result.raw);
    }).catch(() => {
      if (!cancelled) setRaw(selectedEvent.rawJson);
    });
    return () => {
      cancelled = true;
    };
  }, [rpc, selectedEvent]);

  const sourceFilters = useMemo(() => {
    const values = new Map<string, string>();
    for (const root of status?.sources ?? []) {
      if (root.kind === "session") values.set(root.source, root.source);
    }
    return [...values.keys()];
  }, [status]);

  const sourceErrors = useMemo(
    () => (status?.sources ?? []).filter((root) => root.error && root.exists),
    [status],
  );

  async function rescan() {
    setBusy(true);
    try {
      const next = await rpc.call("rescan", null);
      setStatus(next);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="shrink-0 border-b border-border bg-muted/20 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-sm font-semibold">Local session explorer</span>
            <StatusDot status={status} />
            <span className="text-xs text-muted-foreground">private to this device</span>
          </div>
          <div className="flex items-center gap-2">
            {status ? <span className="text-[11px] text-muted-foreground">{status.sessions} sessions · {status.events} events · {formatBytes(status.bytes)}</span> : null}
            <button type="button" className={buttonClass} disabled={busy || status?.state === "indexing"} onClick={() => void rescan()}>
              {busy || status?.state === "indexing" ? "Indexing…" : "Re-scan"}
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="min-w-52 flex-1">
            <input
              className={inputClass}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search sessions, tools, prompts, and decision files"
              aria-label="Search local traces"
            />
          </div>
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            <button type="button" className={view === "sessions" ? primaryButtonClass : buttonClass} onClick={() => setView("sessions")}>Sessions</button>
            <button type="button" className={view === "artifacts" ? primaryButtonClass : buttonClass} onClick={() => setView("artifacts")}>Decisions</button>
          </div>
          {view === "sessions" ? (
            <div className="flex max-w-full items-center gap-1 overflow-auto">
              <button type="button" className={source === "" ? "rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary" : "rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-state-hover"} onClick={() => setSource("")}>All</button>
              {sourceFilters.map((item) => (
                <button key={item} type="button" className={source === item ? "rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary" : "rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-state-hover"} onClick={() => setSource(item)}>
                  {item === "dsh" ? "DeepSeek" : item}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {status?.lastError ? <div className="mt-2 text-xs text-destructive" role="alert">{status.lastError}</div> : null}
        {sourceErrors.length ? (
          <div className="mt-2 text-xs text-warning" role="status">
            {sourceErrors.length} local source{sourceErrors.length === 1 ? "" : "s"} need attention: {sourceErrors.map((root) => root.label + " — " + root.error).join("; ")}
          </div>
        ) : null}
        {error ? <div className="mt-2 text-xs text-destructive" role="alert">{error}</div> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {view === "sessions" ? (
          <div className="grid min-h-full min-w-0 grid-cols-1 lg:grid-cols-[minmax(280px,34%)_1fr]">
            <aside className="min-h-[16rem] overflow-auto border-b border-border lg:min-h-0 lg:border-b-0 lg:border-r" aria-label="Indexed sessions">
              <div className="flex items-center justify-between border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
                <span>{sessionTotal} matching sessions</span>
                <span>{status?.sources.filter((root) => root.kind === "session" && root.exists).length ?? 0} sources detected</span>
              </div>
              {sessions.length ? sessions.map((item) => <SessionRow key={item.id} session={item} selected={item.id === selectedSessionId} onSelect={() => setSelectedSessionId(item.id)} />) : (
                <div className="p-4 text-sm text-muted-foreground">{status?.state === "indexing" ? "Indexing local session files…" : "No sessions found in the detected roots."}</div>
              )}
            </aside>
            <SessionDetail session={session} events={events} totalEvents={totalEvents} selectedEvent={selectedEvent} raw={raw} onSelectEvent={setSelectedEvent} />
          </div>
        ) : (
          <div className="grid min-h-full min-w-0 grid-cols-1 lg:grid-cols-[minmax(280px,34%)_1fr]">
            <aside className="min-h-[16rem] overflow-auto border-b border-border lg:min-h-0 lg:border-b-0 lg:border-r" aria-label="Decision and context files">
              <div className="border-b border-border px-3 py-2 text-[11px] text-muted-foreground">{artifacts.length} indexed files</div>
              <ArtifactList artifacts={artifacts} selectedId={selectedArtifactId} onSelect={(item) => { setSelectedArtifactId(item.id); setSelectedArtifact(item); }} />
            </aside>
            <ArtifactDetail artifact={selectedArtifact ?? artifacts.find((item) => item.id === selectedArtifactId) ?? null} />
          </div>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "traces",
    title: "Traces",
    icon: "Activity",
    path: "traces",
    component: TracesPanel,
  });
});
