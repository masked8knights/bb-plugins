// bb-plugin-sessions — frontend: a "Session Search" nav panel that searches
// auto-discovered provider sessions (Codex, Claude Code, Pi, opencode, omp, …)
// and rehydrates one into a BB thread. Provider filters are built from the
// discovery status rather than being hard-coded.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import type { rpcContract, RehydrateResult, SessionDetail, StatusDto } from "./server";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type ProviderId = string;
type SearchResult = {
  id: string;
  provider: ProviderId;
  title: string;
  cwd: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  model: string | null;
  messageCount: number;
  firstUserMessage: string | null;
  summary: string | null;
  origin: string | null;
};

// Badge styles for known sources; anything unknown gets a neutral fallback.
const PROVIDER_META: Record<string, { label: string; badge: string }> = {
  codex: {
    label: "Codex",
    badge: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
  },
  claude: {
    label: "Claude",
    badge: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  },
  prime: {
    label: "Pi",
    badge: "bg-violet-500/15 text-violet-500 border-violet-500/30",
  },
  opencode: {
    label: "opencode",
    badge: "bg-sky-500/15 text-sky-500 border-sky-500/30",
  },
  omp: {
    label: "omp",
    badge: "bg-rose-500/15 text-rose-500 border-rose-500/30",
  },
};

function providerMeta(id: string): { label: string; badge: string } {
  return PROVIDER_META[id] ?? {
    label: id,
    badge: "bg-muted text-muted-foreground border-border",
  };
}

function timeAgo(ts: number | null): string {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

function ProviderBadge({ provider }: { provider: ProviderId }) {
  const meta = providerMeta(provider);
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.badge}`}
    >
      {meta.label}
    </span>
  );
}

function Detail({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={`truncate text-xs ${mono ? "font-mono" : ""}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function snippetOf(r: SearchResult): string {
  if (r.summary) return r.summary;
  if (r.firstUserMessage) return r.firstUserMessage;
  return `—`;
}

// ---------------------------------------------------------------------------

function ResultTable({
  results,
  onOpen,
}: {
  results: SearchResult[];
  onOpen: (r: SearchResult) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full table-fixed text-left text-xs">
        <thead>
          <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="w-[88px] px-3 py-2 font-medium">Provider</th>
            <th className="px-3 py-2 font-medium">Session</th>
            <th className="w-[96px] px-3 py-2 font-medium">Updated</th>
            <th className="hidden w-[160px] px-3 py-2 font-medium md:table-cell">
              Model
            </th>
            <th className="w-[52px] px-3 py-2 text-right font-medium">Msgs</th>
            <th className="hidden w-[220px] px-3 py-2 font-medium lg:table-cell">
              Cwd
            </th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr
              key={r.id}
              onClick={() => onOpen(r)}
              title={r.title}
              className="cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-accent/60"
            >
              <td className="whitespace-nowrap px-3 py-2 align-top">
                <ProviderBadge provider={r.provider} />
              </td>
              <td className="px-3 py-2 align-top">
                <div className="truncate font-medium text-foreground">
                  {r.title}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {snippetOf(r)}
                </div>
              </td>
              <td className="whitespace-nowrap px-3 py-2 align-top text-muted-foreground">
                {timeAgo(r.updatedAt)}
              </td>
              <td className="hidden truncate px-3 py-2 align-top font-mono text-muted-foreground md:table-cell">
                {r.model ?? "—"}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right align-top tabular-nums text-muted-foreground">
                {r.messageCount}
              </td>
              <td className="hidden truncate px-3 py-2 align-top font-mono text-muted-foreground lg:table-cell">
                {r.cwd ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------

function RehydrateBar({
  detail,
  projectId,
  onDone,
}: {
  detail: SessionDetail;
  projectId: string | null;
  onDone: (result: RehydrateResult) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [providers, setProviders] = useState<
    Array<{ id: string; displayName: string; available: boolean }> | null
  >(null);
  const [sourceDefault, setSourceDefault] = useState<Record<string, string | null>>({});
  const [provider, setProvider] = useState<string>("auto");
  const [mode, setMode] = useState<"full" | "condensed">("full");
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<string[] | null>(null);

  useEffect(() => {
    rpc
      .call("listProviders", null)
      .then((res) => {
        setProviders(res.providers);
        setSourceDefault(res.sourceDefault);
      })
      .catch(() => setProviders([]));
  }, [rpc]);

  const suggested = sourceDefault[detail.provider] ?? null;

  const doRehydrate = async () => {
    setBusy(true);
    setNotes(null);
    try {
      const result = await rpc.call("rehydrate", {
        id: detail.id,
        ...(projectId ? { projectId } : {}),
        ...(provider === "auto" ? {} : { providerId: provider }),
        mode,
      });
      toast.success(`Rehydrated "${result.threadTitle}"`);
      onDone(result);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Provider
          </label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="auto">
              Auto{suggested ? ` (${suggested})` : " (project default)"}
            </option>
            {(providers ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName} ({p.id})
                {p.available ? "" : " — unavailable"}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Context
          </label>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as "full" | "condensed")}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="full">Full transcript</option>
            <option value="condensed">Condensed (first + last)</option>
          </select>
        </div>
        <Button size="sm" disabled={busy} onClick={() => void doRehydrate()}>
          {busy ? "Rehydrating…" : "Rehydrate into BB thread"}
        </Button>
      </div>
      {notes && notes.length > 0 && (
        <ul className="mt-2 list-inside list-disc space-y-0.5 text-[11px] text-muted-foreground">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">
        Creates a new BB thread in the matched project with the transcript as
        its first message, then opens it. The thread continues the conversation
        with any provider.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SessionDetailView({
  detail,
  projectId,
  onBack,
  onDone,
}: {
  detail: SessionDetail;
  projectId: string | null;
  onBack: () => void;
  onDone: (result: RehydrateResult) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← Back
        </Button>
        <ProviderBadge provider={detail.provider} />
        <h2 className="truncate text-sm font-semibold">{detail.title}</h2>
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-3 pt-4 sm:grid-cols-3">
          <Detail label="Session" value={detail.providerSessionId} />
          <Detail label="Started" value={detail.startedAt ? new Date(detail.startedAt).toISOString() : "—"} />
          <Detail label="Updated" value={detail.updatedAt ? timeAgo(detail.updatedAt) : "—"} />
          <Detail label="Model" value={detail.model ?? "—"} />
          <Detail label="Messages" value={String(detail.messageCount)} />
          <Detail label="Origin" value={detail.origin ?? "—"} />
          {detail.cwd && <Detail label="Cwd" value={detail.cwd} />}
          {detail.gitRepoRoot && <Detail label="Repo" value={detail.gitRepoRoot} />}
          <Detail label="File" value={detail.filePath ?? "—"} />
        </CardContent>
      </Card>

      <RehydrateBar detail={detail} projectId={projectId} onDone={onDone} />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Transcript
            {detail.transcriptTruncated && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                (preview truncated — {detail.transcriptLength.toLocaleString()} chars stored)
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground/90">
            {detail.transcript}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

// Main page: latest sessions across *all* discovered providers, newest first.
// Typing narrows to a full-text search; explicit searches can return more.
const RECENT_LIMIT = 30;
const SEARCH_LIMIT = 50;

function SessionsPanel({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { projectId } = useBbContext();
  const [status, setStatus] = useState<StatusDto | null>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [providerFilter, setProviderFilter] = useState<string>("all");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const requestSeq = useRef(0);

  // Debounce the query input.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  // Track whether we ever got a status back, so a failure during initial
  // load (e.g. the plugin was mid-reload) is surfaced instead of silently
  // leaving the panel empty.
  const statusLoadedRef = useRef(false);

  const loadStatus = useCallback(async () => {
    try {
      const s = await rpc.call("status", null);
      statusLoadedRef.current = true;
      setStatus(s);
    } catch (err) {
      if (!statusLoadedRef.current) {
        setError(`Status check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, [rpc]);

  const runSearch = useCallback(
    async (q: string, provider: string, limit: number) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      try {
        const res = await rpc.call("search", {
          query: q,
          ...(provider === "all" ? {} : { providers: [provider] }),
          limit,
        });
        if (seq !== requestSeq.current) return;
        setResults(res.results);
        setTotal(res.total);
        setSearched(true);
      } catch (err) {
        if (seq === requestSeq.current) {
          setResults([]);
          setTotal(0);
          // Mark as searched so the empty state renders, and surface the
          // real error — previously a failed load silently rendered an
          // empty list with no message and no way to retry.
          setSearched(true);
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [rpc],
  );

  // The main page is the "recent sessions" feed: latest across all providers.
  const searchLimit = debounced.trim() ? SEARCH_LIMIT : RECENT_LIMIT;

  useEffect(() => {
    void loadStatus();
    void runSearch("", "all", RECENT_LIMIT);
  }, [loadStatus, runSearch]);

  useEffect(() => {
    void runSearch(debounced, providerFilter, searchLimit);
  }, [debounced, providerFilter, searchLimit, runSearch]);

  // Auto-recover: while a load is failing, retry with a short backoff so the
  // panel heals itself after a plugin reload or server hiccup instead of
  // sitting on an empty list.
  useEffect(() => {
    if (!error || loading) return;
    const t = setTimeout(() => {
      void loadStatus();
      void runSearch(debounced, providerFilter, searchLimit);
    }, 4000);
    return () => clearTimeout(t);
  }, [error, loading, loadStatus, runSearch, debounced, providerFilter, searchLimit]);

  // Reconcile after the realtime socket (re)connects: signals may have been
  // missed while disconnected, so re-fetch status + results.
  const connState = useRealtimeConnectionState();
  const prevConnRef = useRef(connState);
  useEffect(() => {
    if (prevConnRef.current !== connState && connState === "connected") {
      void loadStatus();
      void runSearch(debounced, providerFilter, searchLimit);
    }
    prevConnRef.current = connState;
  }, [connState, loadStatus, runSearch, debounced, providerFilter, searchLimit]);

  // Refresh when the background indexer reports progress.
  useRealtime("sessions-index", (payload) => {
    const p = payload as { phase?: string };
    setStatus((prev) => {
      if (!prev) return prev;
      const indexing =
        p.phase === "done" || p.phase === "error"
          ? { active: false, phase: p.phase, provider: null, done: 0, total: 0 }
          : {
              active: true,
              phase: p.phase ?? "indexing",
              provider: (payload as { provider?: string | null }).provider ?? null,
              done: (payload as { done?: number }).done ?? 0,
              total: (payload as { total?: number }).total ?? 0,
            };
      return { ...prev, indexing };
    });
    if (p.phase === "done" || p.phase === "error") {
      void loadStatus();
      void runSearch(debounced, providerFilter, searchLimit);
    }
  });

  const openDetail = async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await rpc.call("getSession", { id });
      setDetail(res.session);
    } catch (err) {
      toast.error(String(err));
      setSelectedId(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const reindex = async () => {
    try {
      await rpc.call("reindex", {});
      toast.success("Reindexing started");
    } catch (err) {
      toast.error(String(err));
    }
  };

  const onRehydrateDone = (result: RehydrateResult) => {
    navigate.toThread(result.threadId);
  };

  const filterChips = useMemo(
    () => [
      { id: "all", label: "All" },
      ...(status?.providers ?? [])
        .filter((p) => p.enabled || p.detected || p.count > 0)
        .map((p) => ({ id: p.id, label: p.label })),
    ],
    [status],
  );

  if (selectedId) {
    return (
      <div className="h-full overflow-y-auto p-4">
        <div className="mx-auto w-full max-w-3xl">
          {detailLoading && <p className="text-sm text-muted-foreground">Loading session…</p>}
          {detail && (
            <SessionDetailView
              detail={detail}
              projectId={projectId}
              onBack={() => setSelectedId(null)}
              onDone={onRehydrateDone}
            />
          )}
        </div>
      </div>
    );
  }

  const indexing = status?.indexing.active;

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              placeholder="Search sessions… (title, transcript, path)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1 pr-8"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                title="Clear search"
                aria-label="Clear search"
              >
                <span className="text-sm leading-none">✕</span>
              </button>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={() => void reindex()}>
            Reindex
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {filterChips.map((c) => (
            <button
              key={c.id}
              onClick={() => setProviderFilter(c.id)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                providerFilter === c.id
                  ? "border-foreground/30 bg-accent text-foreground"
                  : "border-border bg-card text-muted-foreground hover:bg-accent/60"
              }`}
            >
              {c.label}
            </button>
          ))}
          {status && (
            <span className="ml-auto text-[11px] text-muted-foreground">
              {status.totalSessions.toLocaleString()} indexed
              {status.lastIndexAt
                ? ` · ${timeAgo(status.lastIndexAt)}`
                : ""}
            </span>
          )}
        </div>

        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-foreground">
            {query.trim() ? "Search results" : "Recent sessions"}
          </h2>
          {searched && results.length > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {query.trim() ? (
                <>
                  {results.length < total
                    ? `Top ${results.length} of ${total.toLocaleString()} matches`
                    : `${total.toLocaleString()} match${total === 1 ? "" : "es"}`}
                </>
              ) : (
                <>
                  Latest {results.length} across all providers
                  {total > results.length ? ` · ${total.toLocaleString()} total` : ""}
                </>
              )}
            </span>
          )}
        </div>

        {indexing && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <span className="size-2 animate-pulse rounded-full bg-amber-500" />
            Indexing {status?.indexing.provider ?? ""} — {status?.indexing.done ?? 0}
            {status?.indexing.total ? ` / ${status.indexing.total}` : ""}
          </div>
        )}
        {error && !indexing && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <span className="min-w-0 truncate">{error}</span>
            <button
              onClick={() => {
                setError(null);
                void loadStatus();
                void runSearch(debounced, providerFilter, searchLimit);
              }}
              className="shrink-0 rounded border border-destructive/30 px-2 py-0.5 font-medium hover:bg-destructive/10"
            >
              Retry
            </button>
          </div>
        )}
        {status?.error && !indexing && !error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            Last index failed: {status.error}
          </div>
        )}

        {loading && results.length === 0 ? (
          <p className="text-sm text-muted-foreground">Searching…</p>
        ) : !loading && results.length === 0 && searched && !error ? (
          <p className="text-sm text-muted-foreground">
            {query.trim()
              ? "No matching sessions."
              : "No sessions indexed yet — hit Reindex (or wait for the background indexer)."}
          </p>
        ) : (
          <ResultTable results={results} onOpen={(r) => void openDetail(r.id)} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "sessions",
    title: "Session Search",
    icon: "History",
    path: "sessions",
    component: SessionsPanel,
  });
});
