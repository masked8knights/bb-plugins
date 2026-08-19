import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSettings,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, TraceEvent, TraceSession, TraceSessionFacets, TraceStatus } from "./server";
import type { TraceEventCategory } from "./src/indexer";
import {
  addSessionRootEntry,
  configuredSessionRootEntries,
  removeSessionRootEntry,
} from "./src/settings";
import { getSessionInput, listSessionsInput, type EventFilters, type SessionListFilters } from "./src/rpc-input";

const buttonClass =
  "inline-flex min-h-8 items-center justify-center rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const quietButtonClass =
  "inline-flex min-h-8 items-center justify-center rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const inputClass =
  "h-8 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring";
type TraceRoute =
  | { kind: "sessions" }
  | { kind: "session"; id: string };

type SessionSort = "updated" | "started" | "events" | "duration" | "errors";
type InspectorTab = "json" | "raw" | "timing";
type TimelineLane = "input" | "model" | "tools";
type ErrorFilter = "all" | "only";

type TrajectoryFilters = EventFilters & {
  categories: TraceEventCategory[];
  toolTypes: string[];
  errorFilter: ErrorFilter;
};

const EVENT_CATEGORY_OPTIONS: Array<{ value: TraceEventCategory; label: string }> = [
  { value: "user", label: "User" },
  { value: "assistant", label: "Assistant" },
  { value: "tool", label: "Tools" },
  { value: "system", label: "System" },
  { value: "context", label: "Context" },
  { value: "telemetry", label: "Telemetry" },
  { value: "step", label: "Steps" },
  { value: "turn", label: "Turns" },
  { value: "other", label: "Other" },
];
const DETAIL_EVENT_PAGE_SIZE = 2_000;
const DETAIL_REQUEST_TIMEOUT_MS = 15_000;
const countFormatter = new Intl.NumberFormat();

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function decodeRouteValue(value: string): string {
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

function parseTraceRoute(subPath: string): TraceRoute {
  const parts = decodeRouteValue(subPath).split("/").filter(Boolean);
  if (parts[0] === "session" && parts.length > 1) {
    return { kind: "session", id: decodeRouteValue(parts.slice(1).join("/")) };
  }
  return { kind: "sessions" };
}

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

function formatCount(value: number): string {
  return countFormatter.format(value);
}

function formatDuration(value: number | null): string {
  if (value === null) return "—";
  if (value < 1_000) return Math.round(value) + " ms";
  const seconds = value / 1_000;
  if (seconds < 60) return seconds.toFixed(1) + " s";
  return Math.floor(seconds / 60) + "m " + Math.round(seconds % 60) + "s";
}

function sourceLabel(source: string): string {
  if (source === "dsh") return "DeepSeek";
  if (source === "codex") return "Codex";
  if (source === "claude") return "Claude";
  if (source === "pi") return "Pi";
  if (source === "omp") return "OMP";
  return source;
}

function sourceClass(source: string): string {
  if (source === "dsh") return "border-primary/30 bg-primary/10 text-primary";
  if (source === "claude") return "border-warning/30 bg-warning/10 text-warning";
  if (source === "pi" || source === "omp") return "border-success/30 bg-success/10 text-success";
  return "border-border bg-muted text-muted-foreground";
}

function shortText(value: string, max = 260): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : text.slice(0, max) + "…";
}

function StatusDot({ status }: { status: TraceStatus | null }) {
  const hasCachedRows = (status?.sessions ?? 0) > 0 || (status?.events ?? 0) > 0;
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
      {status?.state === "indexing"
        ? hasCachedRows ? "Index ready · updating" : "Indexing local files"
        : status?.state === "error"
          ? "Index needs attention"
          : "Local index ready"}
    </span>
  );
}

const TRACE_SETTINGS_URL = "/api/v1/plugins/traces/settings";

async function saveAdditionalSessionRoots(value: string): Promise<void> {
  const response = await fetch(TRACE_SETTINGS_URL, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { additionalSessionRoots: value } }),
  });
  const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (!response.ok || body?.ok !== true) {
    throw new Error(body?.error ?? `HTTP ${response.status}`);
  }
}

function SessionRootSettingsRow({
  root,
  onRemove,
  removing,
  disabled,
}: {
  root: TraceStatus["sources"][number];
  onRemove?: () => void;
  removing: boolean;
  disabled: boolean;
}) {
  const custom = root.source === "custom";
  return (
    <div className="flex min-w-0 items-center gap-3 border-t border-border py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2 text-sm text-foreground">
          <span className="truncate" title={root.path}>{root.path}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{custom ? "Custom" : "Built-in"}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>{root.label}</span>
          <span>{root.format ?? "jsonl"}</span>
          {root.exists ? <span>{formatCount(root.fileCount)} files · {formatBytes(root.byteCount)}</span> : <span className="text-warning">Not found</span>}
          {root.error ? <span className="text-warning">{root.error}</span> : null}
        </div>
      </div>
      {custom && onRemove ? (
        <button type="button" className={buttonClass + " shrink-0"} onClick={onRemove} disabled={disabled || removing}>
          {removing ? "Removing…" : "Remove"}
        </button>
      ) : null}
    </div>
  );
}

function TraceSettingsSection() {
  const { values, isLoading } = useSettings();
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<TraceStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [configuredEntries, setConfiguredEntries] = useState<string[]>([]);
  const [newRoot, setNewRoot] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    setConfiguredEntries(
      configuredSessionRootEntries(
        typeof values?.additionalSessionRoots === "string" ? values.additionalSessionRoots : "",
      ),
    );
  }, [values?.additionalSessionRoots]);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      setStatus(await rpc.call("status", null));
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setStatusLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const onIndexUpdated = useCallback(() => {
    void loadStatus();
  }, [loadStatus]);
  useRealtime("traces", onIndexUpdated);

  const saveEntries = useCallback(async (nextEntries: string[], successText: string): Promise<boolean> => {
    setSaving(true);
    setMessage(null);
    try {
      const nextValue = nextEntries.join("\n");
      await saveAdditionalSessionRoots(nextValue);
      setConfiguredEntries(nextEntries);
      setMessage({ kind: "success", text: successText });
      await loadStatus();
      return true;
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      setSaving(false);
    }
  }, [loadStatus]);

  const addRoot = () => {
    const entry = newRoot.trim();
    if (!entry) return;
    const nextEntries = configuredSessionRootEntries(addSessionRootEntry(configuredEntries.join("\n"), entry));
    void saveEntries(nextEntries, "Session directory added. A scan will start shortly.").then((saved) => {
      if (saved) setNewRoot("");
    });
  };

  const removeRoot = (root: TraceStatus["sources"][number]) => {
    const entry = root.configuredPath ?? root.path;
    setRemoving(entry);
    const nextEntries = configuredSessionRootEntries(removeSessionRootEntry(configuredEntries.join("\n"), entry));
    void saveEntries(nextEntries, "Session directory removed.").finally(() => setRemoving(null));
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm text-muted-foreground">
          Traces reads session files from the directories below. Built-in directories are detected automatically; custom directories are stored in this plugin&apos;s settings and can be removed here.
        </p>
      </div>

      <section aria-labelledby="trace-configured-roots-heading" className="border-y border-border">
        <div className="flex items-baseline justify-between gap-3 py-3">
          <h3 id="trace-configured-roots-heading" className="text-sm font-medium text-foreground">Configured roots</h3>
          <span className="text-[11px] text-muted-foreground">{statusLoading ? "Checking…" : `${status?.sources.length ?? 0} configured`}</span>
        </div>
        {statusLoading && !status ? <p className="border-t border-border py-3 text-xs text-muted-foreground">Loading configured directories…</p> : null}
        {status?.sources.map((root) => (
          <SessionRootSettingsRow
            key={root.id}
            root={root}
            removing={removing === (root.configuredPath ?? root.path)}
            disabled={saving}
            onRemove={root.source === "custom" ? () => removeRoot(root) : undefined}
          />
        ))}
        {!statusLoading && status?.sources.length === 0 ? <p className="border-t border-border py-3 text-xs text-muted-foreground">No session directories are configured.</p> : null}
      </section>

      <section aria-labelledby="trace-add-directory-heading" className="space-y-3">
        <div>
          <h3 id="trace-add-directory-heading" className="text-sm font-medium text-foreground">Add a custom directory</h3>
          <p className="mt-1 text-xs text-muted-foreground">Use an absolute path to a directory containing JSONL sessions. <code className="font-mono">~</code> is also accepted.</p>
        </div>
        <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); addRoot(); }}>
          <label className="sr-only" htmlFor="trace-new-session-directory">New session directory</label>
          <input
            id="trace-new-session-directory"
            className={inputClass + " min-w-64 flex-1"}
            value={newRoot}
            onChange={(event) => setNewRoot(event.target.value)}
            placeholder="/Users/me/.my-harness/sessions"
            disabled={saving || isLoading}
          />
          <button type="submit" className={buttonClass} disabled={!newRoot.trim() || saving || isLoading}>
            {saving ? "Saving…" : "Add directory"}
          </button>
        </form>
      </section>

      {message ? <p className={message.kind === "error" ? "text-xs text-destructive" : "text-xs text-success"} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p> : null}
    </div>
  );
}

function SourceBadge({ source }: { source: string }) {
  return (
    <span className={"inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium " + sourceClass(source)}>
      {sourceLabel(source)}
    </span>
  );
}

function eventKind(event: TraceEvent): string {
  if (event.kind === "tool") return "TOOL";
  if (event.role === "user") return "USER";
  if (event.role === "assistant") return "ASSISTANT";
  if (event.kind === "system") return "SYSTEM";
  if (event.kind === "reasoning") return "CONTEXT";
  if (event.kind === "step") return "STEP";
  return event.type.toUpperCase().slice(0, 14);
}

function eventKindClass(event: TraceEvent): string {
  if (event.kind === "tool") return "text-warning";
  if (event.role === "user") return "text-primary";
  if (event.role === "assistant") return "text-violet-300";
  if (event.kind === "system" || event.kind === "reasoning") return "text-muted-foreground";
  return "text-success";
}

function eventTagClass(event: TraceEvent): string {
  if (event.kind === "tool") return "bg-warning/15 text-warning";
  if (event.role === "user") return "bg-primary/15 text-primary";
  if (event.role === "assistant") return "bg-violet-500/15 text-violet-300";
  if (event.kind === "system" || event.kind === "reasoning") return "bg-muted text-muted-foreground";
  return "bg-success/15 text-success";
}

function eventLane(event: TraceEvent): TimelineLane {
  if (event.kind === "tool") return "tools";
  if (event.role === "user" || event.kind === "system" || event.kind === "reasoning") return "input";
  return "model";
}

function timelineSegmentClass(event: TraceEvent): string {
  if (event.kind === "tool") return "bg-warning";
  if (event.role === "user" || event.kind === "system" || event.kind === "reasoning") return "bg-primary";
  if (event.role === "assistant") return "bg-violet-400";
  return "bg-success";
}

function conversationContent(event: TraceEvent): string {
  if (event.kind === "tool") {
    const detail = shortText(event.summary || event.rawJson, 240);
    return detail ? event.title + "  " + detail : event.title;
  }
  return shortText(event.summary || event.title, 360);
}

const ROLE_COLUMN_DEFAULT = 156;
const ROLE_COLUMN_MIN = 128;
const ROLE_COLUMN_MAX = 280;
const PRETTY_PAYLOAD_CHAR_LIMIT = 120_000;

function formatPayload(raw: string): { text: string; isJson: boolean; clipped: boolean } {
  try {
    const pretty = JSON.stringify(JSON.parse(raw) as unknown, null, 2) ?? "null";
    return {
      text: pretty.slice(0, PRETTY_PAYLOAD_CHAR_LIMIT),
      isJson: true,
      clipped: pretty.length > PRETTY_PAYLOAD_CHAR_LIMIT,
    };
  } catch {
    return {
      text: raw.slice(0, PRETTY_PAYLOAD_CHAR_LIMIT),
      isJson: false,
      clipped: raw.length > PRETTY_PAYLOAD_CHAR_LIMIT,
    };
  }
}

function PrettyPayload({ event, raw }: { event: TraceEvent; raw: string | null }) {
  const source = raw ?? event.rawJson;
  const formatted = source ? formatPayload(source) : { text: "No payload recorded.", isJson: false, clipped: false };
  return (
    <div className="space-y-2">
      {raw === null ? <div className="text-[10px] text-muted-foreground" role="status">Showing the indexed preview while the full payload loads…</div> : null}
      <pre aria-label={formatted.isJson ? "Pretty-printed JSON" : "Payload preview"} className="max-h-[min(70vh,48rem)] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border/70 bg-background/60 p-3 font-mono text-[10px] leading-relaxed text-foreground">{formatted.text}</pre>
      {formatted.clipped ? <div className="text-[10px] text-muted-foreground">Preview clipped for responsiveness. Use Raw to inspect the complete payload.</div> : null}
    </div>
  );
}

function SessionRow({ session, onOpen }: { session: TraceSession; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="flex min-h-[30px] w-full items-center gap-2 border-b border-border px-2 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={onOpen}
    >
      <SourceBadge source={session.source} />
      <span className="min-w-0 max-w-[min(42vw,34rem)] truncate text-xs font-medium text-foreground" title={session.title}>{session.title}</span>
      {session.status === "active" ? <span className="shrink-0 text-[10px] text-success">active</span> : null}
      <span className="hidden shrink-0 text-[10px] text-muted-foreground sm:inline">{session.eventCount} events · {session.toolCount} tools · {formatDuration(session.durationMs)}</span>
      {session.errorCount > 0 ? <span className="hidden shrink-0 text-[10px] text-destructive md:inline">{session.errorCount} errors</span> : null}
      <span className="hidden min-w-0 max-w-[min(24vw,20rem)] truncate font-mono text-[10px] text-muted-foreground lg:inline" title={session.cwd ?? session.model ?? undefined}>{session.cwd ?? session.model ?? "local session"}</span>
      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{formatTokens(session.inputTokens)}/{formatTokens(session.outputTokens)}</span>
      <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">{formatTime(session.updatedAt)}</span>
    </button>
  );
}

function FilterPopover({ label, activeCount, children }: { label: string; activeCount: number; children: ReactNode }) {
  const triggerStateClass = activeCount > 0
    ? "bg-primary/15 text-primary"
    : "text-muted-foreground hover:bg-state-hover hover:text-foreground";
  return (
    <details className="relative z-20 shrink-0">
      <summary role="button" aria-label={label} className={`${quietButtonClass} cursor-pointer list-none gap-1.5 ${triggerStateClass} [&::-webkit-details-marker]:hidden`}>
        {label}
        {activeCount > 0 ? <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">{activeCount}</span> : null}
      </summary>
      <div className="absolute right-0 top-full mt-1 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-border bg-background p-2 shadow-lg">
        {children}
      </div>
    </details>
  );
}

function FilterCheck({ label, checked, onChange, count }: { label: string; checked: boolean; onChange: (checked: boolean) => void; count?: number }) {
  return (
    <label className="flex min-h-8 items-center gap-2 rounded px-2 text-xs text-foreground hover:bg-state-hover">
      <input type="checkbox" aria-label={label} className="size-3.5 accent-primary" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined ? <span className="font-mono text-[10px] text-muted-foreground">{formatCount(count)}</span> : null}
    </label>
  );
}

function CollectionHeader({
  status,
  busy,
  query,
  source,
  sourceFilters,
  sort,
  filters,
  onQuery,
  onSource,
  onSort,
  onFilters,
  onRescan,
  error,
}: {
  status: TraceStatus | null;
  busy: boolean;
  query: string;
  source: string;
  sourceFilters: string[];
  sort: SessionSort;
  filters: SessionListFilters;
  onQuery: (value: string) => void;
  onSource: (value: string) => void;
  onSort: (value: SessionSort) => void;
  onFilters: (value: SessionListFilters) => void;
  onRescan: () => void;
  error: string | null;
}) {
  const sourceErrors = (status?.sources ?? []).filter((root) => root.error && root.exists);
  const activeFilterCount = Number(filters.errorFilter === "only") + Number(filters.status === "active") + Number(filters.hasTools === true);
  return (
    <header className="shrink-0 border-b border-border bg-muted/20 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-sm font-semibold">Sessions</span>
          <StatusDot status={status} />
        </div>
        <div className="flex items-center gap-2">
          {status ? <span className="text-[11px] text-muted-foreground">{status.state === "indexing" ? `Indexing${status.sessions ? ` · ${status.sessions} cached` : "…"}` : `${status.sessions} sessions · ${status.events} events · ${formatBytes(status.bytes)}`}</span> : null}
          <button type="button" className={buttonClass} disabled={busy} onClick={onRescan}>
            {busy ? "Re-scanning…" : "Re-scan"}
          </button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="min-w-56 flex-1">
          <input
            className={inputClass}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            maxLength={500}
            placeholder="Search sessions, tools, prompts, and models"
            aria-label="Search local sessions"
          />
        </div>
        <div className="flex max-w-full items-center gap-1 overflow-auto">
          <button type="button" className={source === "" ? "rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary" : "rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-state-hover"} onClick={() => onSource("")}>All</button>
          {sourceFilters.map((item) => (
            <button key={item} type="button" className={source === item ? "rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary" : "rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-state-hover"} onClick={() => onSource(item)}>
              {sourceLabel(item)}
            </button>
          ))}
        </div>
        <label className="flex h-8 items-center gap-2 rounded-md border border-border px-2.5 text-xs text-muted-foreground">
          <span>Sort</span>
          <select className="bg-transparent text-xs text-foreground outline-none" value={sort} onChange={(event) => onSort(event.target.value as SessionSort)} aria-label="Sort sessions">
            <option value="updated">Recently updated</option>
            <option value="started">Recently started</option>
            <option value="events">Most events</option>
            <option value="duration">Longest duration</option>
            <option value="errors">Most errors</option>
          </select>
        </label>
        <FilterPopover label="Filters" activeCount={activeFilterCount}>
          <div className="space-y-1">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Session filters</div>
            <FilterCheck label="Errors only" checked={filters.errorFilter === "only"} onChange={(checked) => onFilters({ ...filters, errorFilter: checked ? "only" : "all" })} />
            <FilterCheck label="Active sessions" checked={filters.status === "active"} onChange={(checked) => onFilters({ ...filters, status: checked ? "active" : undefined })} />
            <FilterCheck label="Has tool calls" checked={filters.hasTools === true} onChange={(checked) => onFilters({ ...filters, hasTools: checked || undefined })} />
          </div>
        </FilterPopover>
      </div>
      {status?.lastError ? <div className="mt-2 text-xs text-destructive" role="alert">{status.lastError}</div> : null}
      {sourceErrors.length ? <div className="mt-2 text-xs text-warning" role="status">{sourceErrors.length} local source{sourceErrors.length === 1 ? "" : "s"} need attention: {sourceErrors.map((root) => root.label + " — " + root.error).join("; ")}</div> : null}
      {error ? <div className="mt-2 text-xs text-destructive" role="alert">{error}</div> : null}
    </header>
  );
}

function SessionCollection({
  sessions,
  total,
  status,
  loading,
  hasMore,
  hasFilter,
  onOpen,
  onLoadMore,
}: {
  sessions: TraceSession[];
  total: number;
  status: TraceStatus | null;
  loading: boolean;
  hasMore: boolean;
  hasFilter: boolean;
  onOpen: (session: TraceSession) => void;
  onLoadMore: () => void;
}) {
  const listRef = useRef<HTMLElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasMore || loading || typeof IntersectionObserver === "undefined") return;
    const list = listRef.current;
    const marker = loadMoreRef.current;
    if (!list || !marker) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { root: list, rootMargin: "240px 0px" },
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore]);

  return (
    <main ref={listRef} className="min-h-0 flex-1 overflow-auto">
      <div className="flex items-center justify-between border-b border-border px-4 py-2 text-[11px] text-muted-foreground">
        <span>{total} matching sessions{total > sessions.length ? ` · showing ${sessions.length}` : ""}</span>
        <span>{status?.sources.filter((root) => root.kind === "session" && root.exists).length ?? 0} sources detected</span>
      </div>
      {sessions.length ? sessions.map((session) => <SessionRow key={session.id} session={session} onOpen={() => onOpen(session)} />) : (
        <div className="flex min-h-48 items-center justify-center px-4 text-sm text-muted-foreground">{hasFilter ? "No sessions match the current filters." : loading || status?.state === "indexing" ? "Indexing local session files…" : "No sessions found in the detected roots."}</div>
      )}
      {sessions.length && hasMore ? (
        <div ref={loadMoreRef} className="flex justify-center border-t border-border px-3 py-3">
          <button type="button" className={buttonClass} disabled={loading} onClick={onLoadMore}>
            {loading ? "Loading…" : `Load more · ${Math.max(0, total - sessions.length)} remaining`}
          </button>
        </div>
      ) : null}
    </main>
  );
}

function TrajectoryToolbar({ filters, facets, onQuery, onToggleCategory, onToggleToolType, onErrorFilter, onClearFilters }: {
  filters: TrajectoryFilters;
  facets: TraceSessionFacets | null;
  onQuery: (value: string) => void;
  onToggleCategory: (category: TraceEventCategory, checked: boolean) => void;
  onToggleToolType: (toolType: string, checked: boolean) => void;
  onErrorFilter: (checked: boolean) => void;
  onClearFilters: () => void;
}) {
  const activeFilterCount = Number(Boolean(filters.query?.trim())) + filters.categories.length + filters.toolTypes.length + Number(filters.errorFilter === "only");
  const categoryOptions = facets === null
    ? EVENT_CATEGORY_OPTIONS
    : EVENT_CATEGORY_OPTIONS.filter((option) => facets.categories.some((item) => item.value === option.value && item.count > 0) || filters.categories.includes(option.value));
  return (
    <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b border-border bg-muted/20 px-2 py-1">
      <FilterPopover label="Event filters" activeCount={activeFilterCount}>
        <div className="max-h-[min(70vh,28rem)] space-y-3 overflow-auto">
          <section>
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Event state</div>
            <FilterCheck label="Errors only" checked={filters.errorFilter === "only"} onChange={onErrorFilter} count={facets?.errorCount} />
          </section>
          <section>
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Event categories</div>
            {categoryOptions.length ? categoryOptions.map((option) => {
              const facet = facets?.categories.find((item) => item.value === option.value);
              return <FilterCheck key={option.value} label={option.label} checked={filters.categories.includes(option.value)} onChange={(checked) => onToggleCategory(option.value, checked)} count={facet?.count ?? 0} />;
            }) : <div className="px-2 text-[11px] text-muted-foreground">No categorized events in this session.</div>}
          </section>
          <section>
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Tool types</div>
            {facets?.toolTypes.length ? facets.toolTypes.map((item) => <FilterCheck key={item.value} label={item.value} checked={filters.toolTypes.includes(item.value)} onChange={(checked) => onToggleToolType(item.value, checked)} count={item.count} />) : <div className="px-2 text-[11px] text-muted-foreground">No tool calls in this session.</div>}
          </section>
          {activeFilterCount ? <button type="button" className="w-full rounded px-2 py-1.5 text-left text-xs font-medium text-primary hover:bg-state-hover" onClick={onClearFilters}>Clear filters</button> : null}
        </div>
      </FilterPopover>
      <label className="ml-auto flex h-[22px] w-44 items-center rounded border border-border bg-muted/30 px-1.5 focus-within:border-ring focus-within:bg-background">
        <span className="sr-only">Search trajectory</span>
        <input className="min-w-0 w-full bg-transparent px-0.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground" value={filters.query ?? ""} onChange={(event) => onQuery(event.target.value)} maxLength={500} placeholder="Search events, tools, and messages" aria-label="Search trajectory" />
      </label>
    </div>
  );
}

function TrajectoryTimeline({ events, selectedId, onSelect }: { events: TraceEvent[]; selectedId: string | null; onSelect: (event: TraceEvent) => void }) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const timed = events.filter((event) => event.timestamp !== null);
  const start = timed.length ? Math.min(...timed.map((event) => event.timestamp ?? 0)) : 0;
  const end = timed.length ? Math.max(...timed.map((event) => (event.timestamp ?? 0) + (event.durationMs ?? 1))) : 1;
  const span = Math.max(1, end - start);
  const lanes: TimelineLane[] = ["input", "model", "tools"];
  const labels: Record<TimelineLane, string> = { input: "Input", model: "Model", tools: "Tools" };
  const turnBoundaries = events.filter((event, index) => event.turn !== null && event.turn !== events[index - 1]?.turn);
  const hoveredIndex = hoveredId === null ? -1 : events.findIndex((event) => event.id === hoveredId);
  const hoveredEvent = hoveredIndex >= 0 ? events[hoveredIndex] : null;
  const hoveredPosition = hoveredEvent
    ? hoveredEvent.timestamp === null
      ? hoveredIndex / Math.max(1, events.length)
      : (hoveredEvent.timestamp - start) / span
    : null;
  const hoveredLeft = hoveredPosition === null ? null : `${Math.min(99.5, Math.max(0, hoveredPosition * 100))}%`;
  const tooltipTransform = hoveredPosition !== null && hoveredPosition < 0.16 ? "translateX(0)" : hoveredPosition !== null && hoveredPosition > 0.84 ? "translateX(-100%)" : "translateX(-50%)";
  return (
    <div className="grid h-[50px] shrink-0 grid-cols-[44px_minmax(0,1fr)] border-b border-border bg-background" aria-label="Trajectory timeline" onMouseLeave={() => setHoveredId(null)}>
      <div className="grid grid-rows-3 border-r border-border text-[9px] uppercase leading-none text-muted-foreground">
        {lanes.map((lane) => <div key={lane} className="flex items-center justify-end border-b border-border/60 pr-1 last:border-b-0">{labels[lane]}</div>)}
      </div>
      <div className="relative min-w-0 overflow-hidden">
        {lanes.map((lane, index) => <div key={lane} className="absolute inset-x-0 border-b border-border/60 last:border-b-0" style={{ top: index * 16.66, height: 16.66 }} />)}
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((line) => <span key={line} className="absolute inset-y-0 border-l border-border/30" style={{ left: `${line * 10}%` }} aria-hidden="true" />)}
        {turnBoundaries.map((event, index) => {
          const position = event.timestamp === null ? events.indexOf(event) / Math.max(1, events.length) : (event.timestamp - start) / span;
          return <span key={`${event.id}-turn-${index}`} className="absolute inset-y-0 border-l border-primary/25" style={{ left: `${Math.min(99.5, Math.max(0, position * 100))}%` }} aria-hidden="true" />;
        })}
        {events.map((event, index) => {
          const position = event.timestamp === null ? index / Math.max(1, events.length) : (event.timestamp - start) / span;
          const width = event.durationMs === null ? 0.008 : Math.max(0.006, event.durationMs / span);
          const laneIndex = lanes.indexOf(eventLane(event));
          return (
            <button
              key={event.id}
              type="button"
              className={"absolute h-2 min-w-[3px] rounded-sm opacity-90 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring " + timelineSegmentClass(event) + (selectedId === event.id ? " ring-1 ring-foreground" : "")}
              style={{ left: `${Math.min(99.5, Math.max(0, position * 100))}%`, top: `${laneIndex * 16.66 + 4}px`, width: `${Math.min(20, width * 100)}%` }}
              onClick={() => onSelect(event)}
              onMouseEnter={() => setHoveredId(event.id)}
              onFocus={() => setHoveredId(event.id)}
              onBlur={() => setHoveredId(null)}
              title={`${eventKind(event)} · ${event.title} · ${formatClock(event.timestamp)}`}
              aria-label={`Select ${eventKind(event)} event ${event.line}`}
            />
          );
        })}
        {hoveredEvent && hoveredLeft !== null ? (
          <>
            <span data-testid="timeline-hover-guide" className="pointer-events-none absolute inset-y-0 z-10 w-px bg-foreground/80" style={{ left: hoveredLeft }} aria-hidden="true" />
            <div role="tooltip" className="pointer-events-none absolute top-1 z-20 flex max-w-[min(80%,28rem)] items-center gap-2 overflow-hidden rounded-sm border border-border bg-background/95 px-2 py-1 text-[10px] shadow-sm" style={{ left: hoveredLeft, transform: tooltipTransform }}>
              <span className={"shrink-0 font-semibold " + eventKindClass(hoveredEvent)}>{eventKind(hoveredEvent)}</span>
              <span className="min-w-0 truncate text-foreground" title={hoveredEvent.title}>{shortText(conversationContent(hoveredEvent), 180)}</span>
              <span className="shrink-0 font-mono text-[9px] text-muted-foreground">#{hoveredEvent.line} · {formatClock(hoveredEvent.timestamp)}</span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function EventLoadMoreRow({ loadedEventCount, totalEvents, eventsLoading, onLoadMore }: { loadedEventCount: number; totalEvents: number; eventsLoading: boolean; onLoadMore: () => void }) {
  const remaining = Math.max(0, totalEvents - loadedEventCount);
  const nextPage = Math.min(DETAIL_EVENT_PAGE_SIZE, remaining);
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 border-b border-border bg-muted/20 px-3 py-1.5 text-[10px] text-muted-foreground">
      <span>{formatCount(loadedEventCount)} of {formatCount(totalEvents)} events loaded · {formatCount(remaining)} remaining</span>
      <button
        type="button"
        className="shrink-0 rounded px-2 py-1 text-[10px] font-medium text-primary hover:bg-state-hover disabled:cursor-wait disabled:opacity-50"
        aria-label="Load more events"
        disabled={eventsLoading}
        onClick={onLoadMore}
      >
        {eventsLoading ? "Loading…" : `Load more events · ${formatCount(nextPage)} next`}
      </button>
    </div>
  );
}

function TrajectoryLedger({ events, loadedEventCount, totalEvents, eventsLoading, eventsHasMore, selectedId, onSelect, onLoadMore }: { events: TraceEvent[]; loadedEventCount: number; totalEvents: number; eventsLoading: boolean; eventsHasMore: boolean; selectedId: string | null; onSelect: (event: TraceEvent) => void; onLoadMore: () => void }) {
  const [roleColumnWidth, setRoleColumnWidth] = useState(ROLE_COLUMN_DEFAULT);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  const setWidth = (value: number) => setRoleColumnWidth(Math.min(ROLE_COLUMN_MAX, Math.max(ROLE_COLUMN_MIN, value)));
  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragState.current = { startX: event.clientX, startWidth: roleColumnWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragState.current) setWidth(dragState.current.startWidth + event.clientX - dragState.current.startX);
  };
  const onResizePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") setWidth(roleColumnWidth - 8);
    else if (event.key === "ArrowRight") setWidth(roleColumnWidth + 8);
    else if (event.key === "Home") setWidth(ROLE_COLUMN_MIN);
    else if (event.key === "End") setWidth(ROLE_COLUMN_MAX);
    else return;
    event.preventDefault();
  };
  if (!events.length) {
    return (
      <div className="min-w-0 flex-1 overflow-auto bg-background" aria-label="Trajectory event ledger">
        <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">{eventsLoading ? "Loading events…" : "No events match this trajectory filter."}</div>
        {eventsHasMore ? <EventLoadMoreRow loadedEventCount={loadedEventCount} totalEvents={totalEvents} eventsLoading={eventsLoading} onLoadMore={onLoadMore} /> : null}
      </div>
    );
  }
  let previousTurn: number | null = null;
  return (
    <div className="relative min-w-0 flex-1 overflow-auto bg-background" aria-label="Trajectory event ledger">
      <div className="relative sticky top-0 z-10 flex h-5 items-center border-b border-border bg-muted/40 text-[9px] uppercase tracking-wide text-muted-foreground">
        <div className="shrink-0 border-r border-border px-2" style={{ width: roleColumnWidth }}>Role</div>
        <div className="min-w-0 px-2">Event</div>
        <div
          role="separator"
          aria-label="Resize role column"
          aria-orientation="vertical"
          aria-valuemin={ROLE_COLUMN_MIN}
          aria-valuemax={ROLE_COLUMN_MAX}
          aria-valuenow={roleColumnWidth}
          aria-valuetext={`${roleColumnWidth}px`}
          tabIndex={0}
          className="absolute top-0 z-20 h-5 w-1 touch-none cursor-col-resize rounded-sm bg-border/70 hover:bg-primary focus-visible:bg-primary focus-visible:outline-none"
          style={{ left: roleColumnWidth - 2 }}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
          onKeyDown={onResizeKeyDown}
        />
      </div>
      {events.map((event) => {
        const turnStart = event.turn !== null && event.turn !== previousTurn;
        previousTurn = event.turn;
        return (
          <div key={event.id}>
            {turnStart ? <div className="flex h-5 items-center border-t-2 border-border bg-muted/20 px-2 text-[9px] uppercase tracking-wide text-muted-foreground">Turn {event.turn}</div> : null}
            <div className="relative">
              {event.turn !== null ? <span className={"pointer-events-none absolute inset-y-0 left-0 z-[1] w-px " + (selectedId === event.id ? "bg-primary" : "bg-primary/20")} aria-hidden="true" /> : null}
              <button
                type="button"
                className={"group grid min-h-[30px] w-full items-center gap-2 border-b border-border/80 px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring " + (selectedId === event.id ? "bg-primary/10" : "hover:bg-state-hover")}
                style={{ gridTemplateColumns: `${roleColumnWidth}px minmax(0, 1fr) auto` }}
                onClick={() => onSelect(event)}
                aria-pressed={selectedId === event.id}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="w-8 shrink-0 text-right font-mono text-[9px] text-muted-foreground">#{event.line}</span>
                  <span className={"inline-flex min-w-0 max-w-full items-center truncate rounded-[3px] px-1.5 text-[10px] font-semibold tracking-[0.035em] " + eventTagClass(event)} title={eventKind(event)}>{eventKind(event)}</span>
                </div>
                <div className={"min-w-0 truncate text-[11px] text-foreground " + (event.kind === "tool" ? "font-mono" : "")} title={event.summary || event.title} style={{ paddingLeft: Math.min(event.depth, 4) * 12 }}>
                  {conversationContent(event)}
                </div>
                <div className="flex shrink-0 items-center gap-2 text-[9px] text-muted-foreground">
                  <span>{formatClock(event.timestamp)}</span>
                  {event.durationMs !== null ? <span>{formatDuration(event.durationMs)}</span> : null}
                </div>
              </button>
            </div>
          </div>
        );
      })}
      {eventsHasMore ? <EventLoadMoreRow loadedEventCount={loadedEventCount} totalEvents={totalEvents} eventsLoading={eventsLoading} onLoadMore={onLoadMore} /> : null}
    </div>
  );
}

function inspectorTabs(): Array<{ id: InspectorTab; label: string }> {
  return [{ id: "json", label: "JSON" }, { id: "raw", label: "Raw" }, { id: "timing", label: "Timing" }];
}

function SessionInspector({ event, raw, onClose }: { event: TraceEvent; raw: string | null; onClose: () => void }) {
  const tabs = inspectorTabs();
  const [tab, setTab] = useState<InspectorTab>(tabs[0]!.id);
  useEffect(() => setTab(tabs[0]!.id), [event.id]);
  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-border bg-muted/10" aria-label="Selected event inspector">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className={"text-[10px] font-semibold " + eventKindClass(event)}>{eventKind(event)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">{event.type} · line {event.line}</span>
        <button type="button" className="size-6 rounded text-sm text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={onClose} aria-label="Close event inspector">×</button>
      </div>
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2">
        {tabs.map((item) => <button key={item.id} type="button" className={(tab === item.id ? "border-b-2 border-primary text-primary " : "border-b-2 border-transparent text-muted-foreground ") + "h-8 shrink-0 px-2 text-[10px] font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"} onClick={() => setTab(item.id)}>{item.label}</button>)}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === "json" ? <PrettyPayload event={event} raw={raw} /> : null}
        {tab === "raw" ? <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-foreground">{raw ?? event.rawJson}</pre> : null}
        {tab === "timing" ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[11px]">
            <dt className="text-muted-foreground">Timestamp</dt><dd className="text-foreground">{formatTime(event.timestamp)}</dd>
            <dt className="text-muted-foreground">Duration</dt><dd className="text-foreground">{formatDuration(event.durationMs)}</dd>
            <dt className="text-muted-foreground">Input tokens</dt><dd className="text-foreground">{formatTokens(event.inputTokens)}</dd>
            <dt className="text-muted-foreground">Output tokens</dt><dd className="text-foreground">{formatTokens(event.outputTokens)}</dd>
            <dt className="text-muted-foreground">Model</dt><dd className="break-all font-mono text-foreground">{event.model ?? "—"}</dd>
            <dt className="text-muted-foreground">Working directory</dt><dd className="break-all font-mono text-foreground">{event.cwd ?? "—"}</dd>
          </dl>
        ) : null}
      </div>
    </aside>
  );
}

function TrajectoryScreen({ session, events, totalEvents, eventsLoading, eventsHasMore, selectedEvent, raw, error, facets, filters, onQuery, onToggleCategory, onToggleToolType, onErrorFilter, onClearFilters, onSelectEvent, onLoadMore, onCloseInspector, onBack }: {
  session: TraceSession;
  events: TraceEvent[];
  totalEvents: number;
  eventsLoading: boolean;
  eventsHasMore: boolean;
  selectedEvent: TraceEvent | null;
  raw: string | null;
  error: string | null;
  facets: TraceSessionFacets | null;
  filters: TrajectoryFilters;
  onQuery: (value: string) => void;
  onToggleCategory: (category: TraceEventCategory, checked: boolean) => void;
  onToggleToolType: (toolType: string, checked: boolean) => void;
  onErrorFilter: (checked: boolean) => void;
  onClearFilters: () => void;
  onSelectEvent: (event: TraceEvent) => void;
  onLoadMore: () => void;
  onCloseInspector: () => void;
  onBack: () => void;
}) {
  const filtersActive = Boolean(filters.query?.trim() || filters.categories.length || filters.toolTypes.length || filters.errorFilter === "only");
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <button type="button" className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={onBack}>← Sessions</button>
        <SourceBadge source={session.source} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={session.filePath}>{session.title}</span>
        <span className="hidden shrink-0 text-[10px] text-muted-foreground md:inline">{filtersActive ? `${formatCount(totalEvents)} matching · ${formatCount(session.eventCount)} total` : `${formatCount(session.eventCount)} events`} · {session.toolCount} tools · {formatDuration(session.durationMs)}</span>
        {session.status === "active" ? <span className="shrink-0 text-[10px] text-success">active</span> : null}
      </header>
      <TrajectoryToolbar filters={filters} facets={facets} onQuery={onQuery} onToggleCategory={onToggleCategory} onToggleToolType={onToggleToolType} onErrorFilter={onErrorFilter} onClearFilters={onClearFilters} />
      <TrajectoryTimeline events={events} selectedId={selectedEvent?.id ?? null} onSelect={onSelectEvent} />
      {error ? <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-1 text-[10px] text-destructive" role="alert">{error}</div> : null}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <TrajectoryLedger events={events} loadedEventCount={events.length} totalEvents={totalEvents} eventsLoading={eventsLoading} eventsHasMore={eventsHasMore} selectedId={selectedEvent?.id ?? null} onSelect={onSelectEvent} onLoadMore={onLoadMore} />
        {selectedEvent ? <div className="max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-10 max-lg:w-[min(92%,420px)] lg:w-[clamp(320px,34%,440px)]"><SessionInspector event={selectedEvent} raw={raw} onClose={onCloseInspector} /></div> : null}
      </div>
    </div>
  );
}

function TracesPanel({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const route = parseTraceRoute(subPath);
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<TraceStatus | null>(null);
  const [sessions, setSessions] = useState<TraceSession[]>([]);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionHasMore, setSessionHasMore] = useState(false);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [sort, setSort] = useState<SessionSort>("updated");
  const [sessionFilters, setSessionFilters] = useState<SessionListFilters>({});
  const [session, setSession] = useState<TraceSession | null>(null);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [totalEvents, setTotalEvents] = useState(0);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsHasMore, setEventsHasMore] = useState(false);
  const [trajectoryFilters, setTrajectoryFilters] = useState<TrajectoryFilters>({ categories: [], toolTypes: [], errorFilter: "all" });
  const [eventFacets, setEventFacets] = useState<TraceSessionFacets | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<TraceEvent | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(() => route.kind === "session");
  const [detailRetry, setDetailRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRequest = useRef(0);
  const metadataRequest = useRef(0);
  const eventRequest = useRef(0);

  const refreshMetadata = useCallback(async () => {
    const requestId = ++metadataRequest.current;
    try {
      const nextStatus = await rpc.call("status", null);
      if (requestId !== metadataRequest.current) return;
      setStatus(nextStatus);
      setError(null);
    } catch (cause) {
      if (requestId === metadataRequest.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc]);

  const loadSessionPage = useCallback(async (offset: number, replace: boolean, preserveLoadedOrder = false) => {
    const requestId = ++sessionRequest.current;
    setSessionLoading(true);
    try {
      const next = await rpc.call("listSessions", listSessionsInput(query, source, sort, offset, 100, sessionFilters));
      if (requestId !== sessionRequest.current) return;
      setSessionTotal(next.total);
      setSessionHasMore(offset + next.sessions.length < next.total);
      setSessions((current) => {
        if (replace) return next.sessions;
        const known = new Set(current.map((item) => item.id));
        if (!preserveLoadedOrder || offset > 0) return current.concat(next.sessions.filter((item) => !known.has(item.id)));
        const incoming = new Map(next.sessions.map((item) => [item.id, item]));
        const updated = current.map((item) => incoming.get(item.id) ?? item);
        return next.sessions.filter((item) => !known.has(item.id)).concat(updated);
      });
      setError(null);
    } catch (cause) {
      if (requestId === sessionRequest.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestId === sessionRequest.current) setSessionLoading(false);
    }
  }, [rpc, query, source, sort, sessionFilters]);

  const refresh = useCallback(async (preserveLoadedRows = false) => {
    await Promise.all([refreshMetadata(), loadSessionPage(0, !preserveLoadedRows, preserveLoadedRows)]);
  }, [loadSessionPage, refreshMetadata]);

  useEffect(() => {
    if (route.kind !== "sessions") return;
    setSessions([]);
    setSessionTotal(0);
    setSessionHasMore(false);
    const timer = setTimeout(() => void loadSessionPage(0, true), 120);
    return () => clearTimeout(timer);
  }, [loadSessionPage, route.kind]);

  useEffect(() => {
    if (route.kind !== "sessions") return;
    const timer = setTimeout(() => void refreshMetadata(), 120);
    return () => clearTimeout(timer);
  }, [refreshMetadata, route.kind]);

  useEffect(() => {
    if (route.kind !== "sessions") return;
    const timer = setInterval(() => void refresh(true), 10_000);
    return () => clearInterval(timer);
  }, [refresh, route.kind]);

  const loadMoreSessions = useCallback(() => {
    if (sessionLoading || !sessionHasMore) return;
    void loadSessionPage(sessions.length, false);
  }, [loadSessionPage, sessionHasMore, sessionLoading, sessions.length]);

  const routeSessionId = route.kind === "session" ? route.id : null;

  const loadMoreEvents = useCallback(() => {
    if (!routeSessionId || eventsLoading || !eventsHasMore) return;
    const requestId = ++eventRequest.current;
    const offset = events.length;
    setEventsLoading(true);
    void withTimeout(
      rpc.call("getSession", getSessionInput(routeSessionId, DETAIL_EVENT_PAGE_SIZE, offset, trajectoryFilters)),
      DETAIL_REQUEST_TIMEOUT_MS,
      "Timed out while loading more events. The local index may still be busy.",
    ).then((result) => {
      if (requestId !== eventRequest.current) return;
      if (result.session) setSession(result.session);
      setEvents((current) => {
        const known = new Set(current.map((item) => item.id));
        return current.concat(result.events.filter((item) => !known.has(item.id)));
      });
      setTotalEvents(result.totalEvents);
      setEventsHasMore(offset + result.events.length < result.totalEvents);
    }).catch((cause) => {
      if (requestId === eventRequest.current) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (requestId === eventRequest.current) setEventsLoading(false);
    });
  }, [eventRequest, events.length, eventsHasMore, eventsLoading, routeSessionId, rpc, trajectoryFilters]);

  useEffect(() => {
    if (route.kind !== "session") {
      ++eventRequest.current;
      setDetailLoading(false);
      setSession(null);
      setEvents([]);
      setTotalEvents(0);
      setEventsLoading(false);
      setEventsHasMore(false);
      setSelectedEvent(null);
      setRaw(null);
      return;
    }
    let cancelled = false;
    const requestId = ++eventRequest.current;
    const sameSession = session?.id === route.id;
    setDetailLoading(!sameSession);
    setEventsLoading(true);
    setEventsHasMore(false);
    setEvents([]);
    setTotalEvents(0);
    if (!sameSession) setSession(null);
    setSelectedEvent(null);
    setRaw(null);
    setError(null);
    void withTimeout(
      rpc.call("getSession", getSessionInput(route.id, DETAIL_EVENT_PAGE_SIZE, 0, trajectoryFilters)),
      DETAIL_REQUEST_TIMEOUT_MS,
      "Timed out while loading the trace. The local index may still be busy.",
    ).then((result) => {
      if (cancelled || requestId !== eventRequest.current) return;
      setSession(result.session);
      setEvents(result.events);
      setTotalEvents(result.totalEvents);
      setEventsHasMore(result.events.length < result.totalEvents);
      setSelectedEvent(null);
      setRaw(null);
      setDetailLoading(false);
    }).catch((cause) => {
      if (!cancelled && requestId === eventRequest.current) {
        setDetailLoading(false);
        setSession(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }).finally(() => {
      if (!cancelled && requestId === eventRequest.current) setEventsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [detailRetry, eventRequest, rpc, route.kind, route.kind === "session" ? route.id : null, trajectoryFilters]);

  useEffect(() => {
    if (route.kind !== "session") {
      setEventFacets(null);
      return;
    }
    let cancelled = false;
    setEventFacets(null);
    void withTimeout(
      rpc.call("getSessionFacets", { id: route.id }),
      DETAIL_REQUEST_TIMEOUT_MS,
      "Timed out while loading trace filters.",
    ).then((facets) => {
      if (!cancelled) setEventFacets(facets);
    }).catch(() => {
      if (!cancelled) setEventFacets(null);
    });
    return () => {
      cancelled = true;
    };
  }, [detailRetry, rpc, route.kind, route.kind === "session" ? route.id : null]);

  useEffect(() => {
    if (!selectedEvent) {
      setRaw(null);
      return;
    }
    setRaw(null);
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
    for (const root of status?.sources ?? []) if (root.kind === "session") values.set(root.source, root.source);
    return [...values.keys()];
  }, [status]);

  const updateTrajectoryFilters = useCallback((update: Partial<TrajectoryFilters>) => {
    setTrajectoryFilters((current) => ({ ...current, ...update }));
    setSelectedEvent(null);
    setRaw(null);
  }, []);

  const toggleTrajectoryCategory = useCallback((category: TraceEventCategory, checked: boolean) => {
    setTrajectoryFilters((current) => ({
      ...current,
      categories: checked ? [...current.categories, category] : current.categories.filter((item) => item !== category),
    }));
    setSelectedEvent(null);
    setRaw(null);
  }, []);

  const toggleTrajectoryToolType = useCallback((toolType: string, checked: boolean) => {
    setTrajectoryFilters((current) => ({
      ...current,
      toolTypes: checked ? [...current.toolTypes, toolType] : current.toolTypes.filter((item) => item !== toolType),
    }));
    setSelectedEvent(null);
    setRaw(null);
  }, []);

  const clearTrajectoryFilters = useCallback(() => {
    setTrajectoryFilters({ categories: [], toolTypes: [], errorFilter: "all" });
    setSelectedEvent(null);
    setRaw(null);
  }, []);

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

  if (route.kind === "session") {
    if (detailLoading) return <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">Loading trajectory…</div>;
    if (!session) return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background text-center">
        <div className="text-sm font-medium text-foreground">{error ? "Unable to load trace" : "Session not found"}</div>
        <div className="max-w-md text-xs text-muted-foreground">{error ?? "This deep link no longer matches a locally indexed session."}</div>
        <div className="flex items-center gap-2">
          <button type="button" className={buttonClass} onClick={() => navigate.toPluginPanel("traces", { subPath: "", replace: true })}>Back to sessions</button>
          {error ? <button type="button" className={buttonClass} onClick={() => setDetailRetry((value) => value + 1)}>Retry</button> : null}
        </div>
      </div>
    );
    return <TrajectoryScreen session={session} events={events} totalEvents={totalEvents} eventsLoading={eventsLoading} eventsHasMore={eventsHasMore} selectedEvent={selectedEvent} raw={raw} error={error} facets={eventFacets} filters={trajectoryFilters} onQuery={(value) => updateTrajectoryFilters({ query: value })} onToggleCategory={toggleTrajectoryCategory} onToggleToolType={toggleTrajectoryToolType} onErrorFilter={(checked) => updateTrajectoryFilters({ errorFilter: checked ? "only" : "all" })} onClearFilters={clearTrajectoryFilters} onSelectEvent={setSelectedEvent} onLoadMore={loadMoreEvents} onCloseInspector={() => setSelectedEvent(null)} onBack={() => navigate.toPluginPanel("traces", { subPath: "", replace: true })} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <CollectionHeader status={status} busy={busy} query={query} source={source} sourceFilters={sourceFilters} sort={sort} filters={sessionFilters} onQuery={setQuery} onSource={setSource} onSort={setSort} onFilters={setSessionFilters} onRescan={() => void rescan()} error={error} />
      <SessionCollection sessions={sessions} total={sessionTotal} status={status} loading={sessionLoading} hasMore={sessionHasMore} hasFilter={Boolean(query.trim() || source || sessionFilters.errorFilter === "only" || sessionFilters.status || sessionFilters.hasTools)} onLoadMore={loadMoreSessions} onOpen={(item) => navigate.toPluginPanel("traces", { subPath: `session/${encodeURIComponent(item.id)}` })} />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "session-directories",
    title: "Session directories",
    description: "Review the local roots Traces indexes and manage additional directories.",
    component: TraceSettingsSection,
  });
  app.slots.navPanel({
    id: "traces",
    title: "Traces",
    icon: "Activity",
    path: "traces",
    component: TracesPanel,
  });
});
