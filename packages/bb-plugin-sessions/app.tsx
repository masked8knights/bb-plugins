// bb-plugin-sessions — local agent observability: overview metrics, provider
// aggregates, searchable traces, and trace inspection over one corpus.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import type {
  rpcContract,
  RehydrateResult,
  SessionDetail,
  StatusDto,
} from "./server";
import TelemetryDashboardPage from "./src/telemetry-page";
import ProviderAggregatesPage from "./src/provider-page";
import { PANEL_CONTENT_CLASS, PANEL_GUTTER_CLASS } from "./src/panel-layout";
import { providerLabel } from "./src/provider-labels";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
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
const PROVIDER_META: Record<string, { badge: string }> = {
  pi: {
    badge: "bg-violet-500/15 text-violet-500 border-violet-500/30",
  },
  prime: {
    badge: "bg-fuchsia-500/15 text-fuchsia-500 border-fuchsia-500/30",
  },
  omp: {
    badge: "bg-rose-500/15 text-rose-500 border-rose-500/30",
  },
  hermes: {
    badge: "bg-cyan-500/15 text-cyan-500 border-cyan-500/30",
  },
  codex: {
    badge: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
  },
  claude: {
    badge: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  },
  opencode: {
    badge: "bg-sky-500/15 text-sky-500 border-sky-500/30",
  },
};

function providerMeta(id: string): { label: string; badge: string } {
  return {
    label: providerLabel(id),
    badge: PROVIDER_META[id]?.badge ?? "bg-muted text-muted-foreground border-border",
  };
}

function formatTokens(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
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

function ProviderBadge({
  provider,
  historical = false,
  availability,
}: {
  provider: ProviderId;
  historical?: boolean;
  availability?: "active" | "historical" | "unknown";
}) {
  const meta = providerMeta(provider);
  const isHistorical = historical || availability === "historical";
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.badge}`}>
        {meta.label}
      </span>
      {isHistorical ? <span className="rounded border border-amber-500/30 px-1 py-0.5 text-[10px] font-normal text-amber-700 dark:text-amber-300">historical</span> : availability === "unknown" ? <span className="rounded border border-amber-500/30 px-1 py-0.5 text-[10px] font-normal text-amber-700 dark:text-amber-300">availability unknown</span> : null}
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
  providerAvailability,
}: {
  results: SearchResult[];
  onOpen: (r: SearchResult) => void;
  providerAvailability: ReadonlyMap<string, "active" | "historical" | "unknown">;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full table-fixed text-left text-xs">
        <thead>
          <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="w-[88px] px-3 py-2 font-medium">Provider</th>
            <th className="px-3 py-2 font-medium">Trace</th>
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
              className="border-b border-border/60 transition-colors last:border-0 hover:bg-accent/60"
            >
              <td className="whitespace-nowrap px-3 py-2 align-top">
                <ProviderBadge provider={r.provider} availability={providerAvailability.get(r.provider)} />
              </td>
              <td className="px-3 py-2 align-top">
                <button
                  type="button"
                  onClick={() => onOpen(r)}
                  className="block max-w-full truncate text-left font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  title={r.title}
                >
                  {r.title}
                </button>
                <div className="truncate text-[11px] text-muted-foreground">
                  {snippetOf(r)}
                </div>
              </td>
              <td className="whitespace-nowrap px-3 py-2 align-top text-muted-foreground">
                {timeAgo(r.updatedAt)}
              </td>
              <td className="hidden truncate px-3 py-2 align-top font-mono text-muted-foreground md:table-cell" title={r.model ?? undefined}>
                {r.model ?? "—"}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right align-top tabular-nums text-muted-foreground">
                {r.messageCount}
              </td>
              <td className="hidden truncate px-3 py-2 align-top font-mono text-muted-foreground lg:table-cell" title={r.cwd ?? undefined}>
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
  historical,
  onDone,
}: {
  detail: SessionDetail;
  projectId: string | null;
  historical: boolean;
  onDone: (result: RehydrateResult) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [providers, setProviders] = useState<
    Array<{ id: string; displayName: string; available: boolean }> | null
  >(null);
  const [providerCatalogError, setProviderCatalogError] = useState<string | null>(null);
  const [sourceDefault, setSourceDefault] = useState<Record<string, string | null>>({});
  const [provider, setProvider] = useState<string>("auto");
  const [mode, setMode] = useState<"full" | "condensed">("full");
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<string[] | null>(null);
  const mountedRef = useRef(true);
  const actionSeq = useRef(0);

  useEffect(() => () => {
    mountedRef.current = false;
    actionSeq.current += 1;
  }, []);

  useEffect(() => {
    let active = true;
    rpc
      .call("listProviders", { sessionId: detail.id, ...(projectId ? { projectId } : {}) })
      .then((res) => {
        if (!active || !mountedRef.current) return;
        setProviders(res.providers.filter((provider) => provider.available));
        setSourceDefault(res.sourceDefault);
        setProviderCatalogError(res.error);
      })
      .catch((error) => {
        if (!active || !mountedRef.current) return;
        setProviders([]);
        setProviderCatalogError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [detail.id, projectId, rpc]);

  const suggested = sourceDefault[detail.provider] ?? null;

  const doRehydrate = async () => {
    const seq = ++actionSeq.current;
    setBusy(true);
    setNotes(null);
    try {
      const result = await rpc.call("rehydrate", {
        id: detail.id,
        ...(projectId ? { projectId } : {}),
        ...(provider === "auto" ? {} : { providerId: provider }),
        mode,
      });
      if (!mountedRef.current || seq !== actionSeq.current) return;
      const note = result.notes.length > 0 ? result.notes.join(" · ") : undefined;
      toast.success(`Rehydrated "${result.threadTitle}"`, note ? { description: note } : undefined);
      onDone(result);
    } catch (err) {
      if (!mountedRef.current || seq !== actionSeq.current) return;
      toast.error(String(err));
    } finally {
      if (mountedRef.current && seq === actionSeq.current) setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3" aria-busy={busy || providers === null}>
      {providerCatalogError ? (
        <div role="alert" className="mb-3 border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          Provider discovery unavailable; provider choices may be incomplete. {providerCatalogError}
        </div>
      ) : null}
      {providers === null && !providerCatalogError ? (
        <p role="status" aria-live="polite" className="mb-3 text-xs text-muted-foreground">
          Loading provider choices for this project…
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="rehydrate-provider" className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Provider
          </label>
          <select
            id="rehydrate-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            disabled={providers === null || busy}
            aria-busy={providers === null}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
          >
            <option value="auto">
              Auto{suggested ? ` (${providerLabel(suggested)})` : " (project default)"}
            </option>
            {(providers ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName} ({p.id})
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="rehydrate-mode" className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Context
          </label>
          <select
            id="rehydrate-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as "full" | "condensed")}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="full">{detail.transcriptSourceTruncated ? "Full indexed transcript" : "Full transcript"}</option>
            <option value="condensed">{detail.transcriptSourceTruncated ? "Condensed (first + indexed preview)" : "Condensed (first + last)"}</option>
          </select>
        </div>
        <Button size="sm" disabled={busy} onClick={() => void doRehydrate()}>
          {busy ? "Rehydrating…" : "Rehydrate into BB thread"}
        </Button>
      </div>
      {detail.transcriptSourceTruncated ? (
        <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
          The indexed source is bounded ({detail.transcriptLength.toLocaleString()} stored characters); rehydration cannot include content outside the indexed transcript.
        </p>
      ) : detail.transcriptPreviewTruncated ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          The inspector shows the first 40,000 of {detail.transcriptLength.toLocaleString()} indexed characters. Rehydration may include additional indexed content.
        </p>
      ) : null}
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
      {historical ? (
        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
          This source is historical or unavailable here; rehydration may use the project&apos;s default provider.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

type TraceEntry = SessionDetail["trace"][number];

function traceEntryMeta(entry: TraceEntry): {
  icon: "UserRound" | "AiContentGenerator01" | "Terminal" | "Workflow";
  label: string;
  tone: string;
} {
  if (entry.kind === "user") {
    return {
      icon: "UserRound",
      label: "User",
      tone: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
    };
  }
  if (entry.kind === "assistant") {
    return {
      icon: "AiContentGenerator01",
      label: "Assistant",
      tone: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
    };
  }
  if (entry.kind === "tool") {
    return {
      icon: "Terminal",
      label: (entry.toolName ?? entry.title) || "Tool call",
      tone: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }
  return {
    icon: "Workflow",
    label: entry.title || "Event",
    tone: "bg-muted text-muted-foreground",
  };
}

function traceRoleLabel(entry: TraceEntry): string {
  if (entry.kind === "user") return "User";
  if (entry.kind === "assistant") return "Assistant";
  if (entry.kind === "tool") return "Tool";
  return "System";
}

function traceTime(ts: number | null): string {
  if (ts === null) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(ts));
}

function tracePreview(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > 82 ? `${line.slice(0, 82)}…` : line;
}

function traceStatusLabel(status: TraceEntry["status"]): string {
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  if (status === "interrupted") return "Interrupted";
  return "Unclassified";
}

function TraceGlyph({ entry }: { entry: TraceEntry }) {
  const meta = traceEntryMeta(entry);
  return (
    <span className={`flex size-7 shrink-0 items-center justify-center rounded-md ${meta.tone}`}>
      <Icon name={meta.icon} aria-hidden="true" className="size-4" />
    </span>
  );
}

function TraceRail({
  entries,
  selectedId,
  onSelect,
  truncated,
}: {
  entries: TraceEntry[];
  selectedId: string;
  onSelect: (id: string) => void;
  truncated: boolean;
}) {
  return (
    <aside className="flex min-h-0 flex-col border-b border-border bg-muted/20 md:border-b-0 md:border-r">
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div>
          <h3 className="text-xs font-semibold text-foreground">Trace</h3>
          <p className="text-[11px] text-muted-foreground">Select an entry to inspect it</p>
        </div>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {entries.length}
        </span>
      </div>
      <nav aria-label="Trace entries" className="min-h-0 max-h-[38vh] overflow-y-auto p-2 md:max-h-none md:flex-1">
        <ul className="space-y-0.5">
          {entries.map((entry) => {
            const meta = traceEntryMeta(entry);
            const roleLabel = traceRoleLabel(entry);
            const selected = entry.id === selectedId;
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  aria-current={selected ? "true" : undefined}
                  aria-label={`${roleLabel}${meta.label !== roleLabel ? `: ${meta.label}` : ""}. ${traceStatusLabel(entry.status)}`}
                  title={meta.label !== roleLabel ? meta.label : undefined}
                  onClick={() => onSelect(entry.id)}
                  className={`group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                    selected
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  }`}
                >
                  <TraceGlyph entry={entry} />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{roleLabel}</span>
                  <span className="sr-only">{traceStatusLabel(entry.status)}</span>
                  {entry.status === "failed" && (
                    <>
                      <span className="mt-1 size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
                    </>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {truncated && (
          <p className="px-2 py-2 text-[11px] leading-relaxed text-muted-foreground">
            The trace rail is capped for large sessions. The raw transcript below remains available.
          </p>
        )}
      </nav>
    </aside>
  );
}

function traceContentSections(text: string): Array<{ label: string; text: string }> {
  const parts = text.split(/\n\n(?=(?:Input|Output|Error)\n)/u);
  return parts.map((part) => {
    const match = /^(Input|Output|Error)\n([\s\S]*)$/u.exec(part);
    return {
      label: match?.[1] ?? "Details",
      text: match?.[2] ?? part,
    };
  });
}

function TraceEntryContent({ entry }: { entry: TraceEntry }) {
  if (entry.kind !== "tool") {
    return (
      <div className="max-w-3xl rounded-lg border border-border/70 bg-muted/20 px-4 py-4 whitespace-pre-wrap break-words text-sm leading-7 text-foreground">
        {entry.text || "No content captured for this entry."}
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-3">
      {traceContentSections(entry.text || "No content captured for this entry.").map((section, index) => (
        <div key={`${section.label}-${index}`} className={`overflow-hidden rounded-lg border ${section.label === "Error" ? "border-destructive/50 bg-destructive/5" : "border-border bg-muted/20"}`}>
          <div className="border-b border-border/70 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {section.label}
          </div>
          <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words bg-background/40 px-3 py-3 font-mono text-xs leading-6 text-foreground">
            {section.text || "No content captured for this section."}
          </pre>
        </div>
      ))}
    </div>
  );
}

function TraceEntryInspector({ entry }: { entry: TraceEntry }) {
  const meta = traceEntryMeta(entry);
  const roleLabel = traceRoleLabel(entry);
  const statusClass =
    entry.status === "failed"
      ? "text-destructive"
      : entry.status === "running"
        ? "text-amber-600 dark:text-amber-400"
        : "text-muted-foreground";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <span className="sr-only" aria-live="polite">
        {meta.label} event {entry.sourceSequence} selected. {traceStatusLabel(entry.status)}. {tracePreview(entry.text) || "No content"}.
      </span>
      <div className="border-b border-border px-4 py-4 md:px-6">
        <div className="flex items-start gap-3">
          <TraceGlyph entry={entry} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="truncate text-sm font-semibold text-foreground">{meta.label}</h3>
              <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                {roleLabel}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              <span className={statusClass}>{traceStatusLabel(entry.status)}</span>
              {entry.timestamp !== null && <span className="text-muted-foreground">{traceTime(entry.timestamp)}</span>}
              <span className="font-mono text-muted-foreground">event {entry.sourceSequence}</span>
            </div>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
        <TraceEntryContent entry={entry} />
      </div>
    </div>
  );
}

function SessionDetailView({
  detail,
  projectId,
  historical,
  availability,
  headingRef,
  onBack,
  onDone,
}: {
  detail: SessionDetail;
  projectId: string | null;
  historical: boolean;
  availability?: "active" | "historical" | "unknown";
  headingRef: RefObject<HTMLHeadingElement | null>;
  onBack: () => void;
  onDone: (result: RehydrateResult) => void;
}) {
  const entries = useMemo(
    () => detail.trace.length > 0
      ? detail.trace
      : [{
          id: "transcript",
          kind: "system" as const,
          title: "Transcript",
          text: detail.transcript,
          timestamp: null,
          status: "unknown" as const,
          toolName: null,
          sourceSequence: 1,
        }],
    [detail.trace, detail.transcript],
  );
  const [selectedId, setSelectedId] = useState(entries[0]?.id ?? "transcript");
  useEffect(() => {
    if (!entries.some((entry) => entry.id === selectedId)) {
      setSelectedId(entries[0]?.id ?? "transcript");
    }
  }, [entries, selectedId]);
  const selectedEntry = entries.find((entry) => entry.id === selectedId) ?? entries[0]!;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <Icon name="ChevronLeft" aria-hidden="true" />
          Back
        </Button>
        <ProviderBadge provider={detail.provider} historical={historical} availability={availability} />
        <h2 ref={headingRef} tabIndex={-1} className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground outline-none">{detail.title}</h2>
        <span className="text-[11px] text-muted-foreground">{timeAgo(detail.updatedAt)}</span>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-y border-border py-3 text-xs">
        <Detail label="Status" value={detail.analytics.status} mono={false} />
        <Detail label="Messages" value={String(detail.messageCount)} />
        <Detail label="Turns" value={String(detail.analytics.turnCount)} />
        <Detail label="Tools" value={`${detail.analytics.toolCalls}${detail.analytics.toolErrors ? ` · ${detail.analytics.toolErrors} errors` : ""}`} />
        <Detail label="Tokens" value={formatTokens(detail.analytics.totalTokens)} />
        <Detail label="Model" value={detail.model ?? "—"} />
      </div>

      <RehydrateBar detail={detail} projectId={projectId} historical={historical} onDone={onDone} />

      <section className="overflow-hidden rounded-lg border border-border bg-card" aria-label="Trace inspector">
        <div className="grid min-h-[540px] md:grid-cols-[260px_minmax(0,1fr)]">
          <TraceRail
            entries={entries}
            selectedId={selectedEntry.id}
            onSelect={setSelectedId}
            truncated={detail.traceTruncated}
          />
          <TraceEntryInspector entry={selectedEntry} />
        </div>
        <details className="border-t border-border">
          <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring md:px-6">
            Raw transcript
            {detail.transcriptPreviewTruncated && (
              <span className="ml-2 font-normal">display preview capped at 40,000 of {detail.transcriptLength.toLocaleString()} indexed chars</span>
            )}
            {detail.transcriptSourceTruncated && (
              <span className="ml-2 font-normal">source transcript is bounded</span>
            )}
          </summary>
          <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap border-t border-border bg-muted/30 px-4 py-4 font-mono text-xs leading-relaxed text-foreground/90 md:px-6">
            {detail.transcript}
          </pre>
        </details>
      </section>

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
          Source session metadata
        </summary>
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 sm:grid-cols-3">
          <Detail label="Session" value={detail.providerSessionId} />
          <Detail label="Started" value={detail.startedAt ? new Date(detail.startedAt).toISOString() : "—"} />
          <Detail label="Origin" value={detail.origin ?? "—"} />
          {detail.cwd && <Detail label="Cwd" value={detail.cwd} />}
          {detail.gitRepoRoot && <Detail label="Repo" value={detail.gitRepoRoot} />}
          <Detail label="File" value={detail.filePath ?? "—"} />
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------

type ObservabilityView = "overview" | "providers" | "traces";

function PanelTabs({ active, panelId }: { active: ObservabilityView; panelId?: string }) {
  const navigate = useBbNavigate();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const views = ["overview", "providers", "traces"] as const;
  const targetPanelId = panelId ?? `observability-panel-${active}`;
  const selectView = (view: ObservabilityView) => {
    navigate.toPluginPanel("sessions", { subPath: view === "overview" ? "" : view });
    // The current tab unmounts during route navigation. Restore focus after
    // the destination tablist mounts so keyboard users can continue moving
    // across views with the arrow keys.
    requestAnimationFrame(() => {
      const focusDestination = () => document.getElementById(`observability-tab-${view}`)?.focus();
      focusDestination();
      requestAnimationFrame(focusDestination);
    });
  };
  return (
    <div className="flex items-center gap-1 border-b border-border" role="tablist" aria-label="Observability views">
      {views.map((view, index) => (
        <button
          key={view}
          type="button"
          role="tab"
          id={`observability-tab-${view}`}
          aria-controls={active === view ? targetPanelId : undefined}
          aria-selected={active === view}
          tabIndex={active === view ? 0 : -1}
          ref={(element) => { tabRefs.current[index] = element; }}
          onClick={() => selectView(view)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
            const nextIndex = event.key === "Home"
              ? 0
              : event.key === "End"
                ? views.length - 1
                : (index + delta + views.length) % views.length;
            const next = views[nextIndex]!;
            selectView(next);
          }}
          className={`border-b-2 px-2.5 py-2 text-xs font-medium transition-colors ${
            active === view
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`}
        >
          {view[0]!.toUpperCase() + view.slice(1)}
        </button>
      ))}
    </div>
  );
}

function SessionsSurface({ children, active = "traces" }: { children: ReactNode; active?: ObservabilityView }) {
  const panelId = `observability-panel-${active}`;
  return (
    <div className="h-full overflow-y-auto">
      <div className={`${PANEL_CONTENT_CLASS} ${PANEL_GUTTER_CLASS} pt-2`}>
        <PanelTabs active={active} panelId={panelId} />
      </div>
      <div id={panelId} role="tabpanel" tabIndex={0} aria-labelledby={`observability-tab-${active}`} className={`${PANEL_CONTENT_CLASS} ${PANEL_GUTTER_CLASS} space-y-4 py-6`}>
        {children}
      </div>
    </div>
  );
}

function TelemetryPanel({ active = "overview" }: { active?: "overview" | "providers" }) {
  const panelId = `observability-panel-${active}`;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`${PANEL_CONTENT_CLASS} ${PANEL_GUTTER_CLASS} flex-none pt-2`}>
        <PanelTabs active={active} panelId={panelId} />
      </div>
      <div id={panelId} role="tabpanel" tabIndex={0} aria-labelledby={`observability-tab-${active}`} className="min-h-0 flex-1 outline-none">
        {active === "providers" ? <ProviderAggregatesPage /> : <TelemetryDashboardPage />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

// Main page: latest sessions across *all* discovered providers, newest first.
// Typing narrows to a full-text search; explicit searches can return more.
const RECENT_LIMIT = 30;
const SEARCH_LIMIT = 50;

function SessionSearchPanel({
  initialSessionId,
  returnSubPath = "traces",
}: {
  initialSessionId?: string;
  returnSubPath?: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { projectId } = useBbContext();
  const [status, setStatus] = useState<StatusDto | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
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
  const [autoRetryCount, setAutoRetryCount] = useState(0);
  const requestSeq = useRef(0);
  const detailSeq = useRef(0);
  const statusSeq = useRef(0);
  const loadingHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Debounce the query input.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  const loadStatus = useCallback(async () => {
    const seq = ++statusSeq.current;
    try {
      const s = await rpc.call("status", null);
      if (seq !== statusSeq.current) return;
      setStatus(s);
      setStatusError(null);
    } catch (err) {
      if (seq === statusSeq.current) {
        setStatusError(`Status check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, [rpc]);

  const runSearch = useCallback(
    async (q: string, provider: string, limit: number) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      setResults([]);
      setTotal(0);
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
        setAutoRetryCount(0);
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
  }, [loadStatus, runSearch]);

  useEffect(() => {
    void runSearch(debounced, providerFilter, searchLimit);
  }, [debounced, providerFilter, searchLimit, runSearch]);

  // Auto-recover: while a load is failing, retry with a short backoff so the
  // panel heals itself after a plugin reload or server hiccup instead of
  // sitting on an empty list.
  useEffect(() => {
    if (!error || loading || autoRetryCount >= 3) return;
    const delay = Math.min(4_000 * 2 ** autoRetryCount, 30_000);
    const t = setTimeout(() => {
      setAutoRetryCount((count) => count + 1);
      void loadStatus();
      void runSearch(debounced, providerFilter, searchLimit);
    }, delay);
    return () => clearTimeout(t);
  }, [error, loading, autoRetryCount, loadStatus, runSearch, debounced, providerFilter, searchLimit]);

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

  const leaveDetail = useCallback(() => {
    detailSeq.current++;
    setSelectedId(null);
    setDetail(null);
    setDetailLoading(false);
    navigate.toPluginPanel("sessions", { subPath: returnSubPath, replace: true });
  }, [navigate, returnSubPath]);

  const openDetail = useCallback(async (id: string, updateRoute = true) => {
    const seq = ++detailSeq.current;
    if (updateRoute) {
      navigate.toPluginPanel("sessions", { subPath: `trace/traces/${encodeURIComponent(id)}` });
    }
    setSelectedId(id);
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await rpc.call("getSession", { id });
      if (seq === detailSeq.current) setDetail(res.session);
    } catch (err) {
      if (seq === detailSeq.current) {
        toast.error(String(err));
        leaveDetail();
      }
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  }, [leaveDetail, rpc, navigate]);

  useEffect(() => {
    if (initialSessionId) {
      void openDetail(initialSessionId, false);
    } else {
      detailSeq.current++;
      setSelectedId(null);
      setDetail(null);
      setDetailLoading(false);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [initialSessionId, openDetail]);

  useEffect(() => {
    if (!detailLoading || detail) return;
    loadingHeadingRef.current?.focus();
  }, [detailLoading, detail]);

  useEffect(() => {
    if (!detail) return;
    requestAnimationFrame(() => detailHeadingRef.current?.focus());
  }, [detail]);

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
        .filter((p) => p.count > 0)
        .map((p) => ({
          id: p.id,
          label: p.availability === "historical"
            ? `${p.label} · historical`
            : p.availability === "unknown"
              ? `${p.label} · availability unknown`
              : p.label,
        })),
    ],
    [status],
  );
  const providerAvailability = useMemo(
    () => new Map((status?.providers ?? []).map((provider) => [provider.id, provider.availability] as const)),
    [status],
  );
  const historicalProviders = useMemo(
    () => new Set((status?.providers ?? []).filter((provider) => provider.availability === "historical").map((provider) => provider.id)),
    [status],
  );

  if (selectedId) {
    return (
      <SessionsSurface active={returnSubPath === "" ? "overview" : "traces"}>
        {detailLoading && !detail && (
          <div className="flex items-center gap-3" role="status" aria-live="polite">
            <Button size="sm" variant="ghost" onClick={leaveDetail}>
              <Icon name="ChevronLeft" aria-hidden="true" />
              Back
            </Button>
            <h2 ref={loadingHeadingRef} tabIndex={-1} className="text-sm text-muted-foreground outline-none">
              Loading session…
            </h2>
          </div>
        )}
        {detail && (
          <SessionDetailView
            detail={detail}
            projectId={projectId}
            historical={historicalProviders.has(detail.provider)}
            availability={providerAvailability.get(detail.provider)}
            headingRef={detailHeadingRef}
            onBack={() => {
              leaveDetail();
            }}
            onDone={onRehydrateDone}
          />
        )}
      </SessionsSurface>
    );
  }

  const indexing = status?.indexing.active;

  return (
    <SessionsSurface>
      <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              ref={searchInputRef}
              aria-label="Search traces"
              placeholder="Search traces… (title, transcript, path)"
              maxLength={500}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1 pr-8"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
              type="button"
              key={c.id}
              onClick={() => setProviderFilter(c.id)}
              aria-pressed={providerFilter === c.id}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                providerFilter === c.id
                  ? "border-foreground/30 bg-accent text-foreground"
                  : "border-border bg-card text-muted-foreground hover:bg-accent/60"
              } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`}
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
            {query.trim() ? "Search results" : "Recent traces"}
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
          <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <span className="size-2 rounded-full bg-amber-500 motion-safe:animate-pulse motion-reduce:animate-none" />
            Indexing {status?.indexing.provider ?? ""} — {status?.indexing.done ?? 0}
            {status?.indexing.total ? ` / ${status.indexing.total}` : ""}
          </div>
        )}
        {error && !indexing && (
          <div role="alert" className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <span className="min-w-0 truncate">{error}</span>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setStatusError(null);
                setAutoRetryCount(0);
                void loadStatus();
                void runSearch(debounced, providerFilter, searchLimit);
              }}
              className="shrink-0 rounded border border-destructive/30 px-2 py-0.5 font-medium hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              Retry
            </button>
          </div>
        )}
        {statusError && !indexing && (
          <div role="alert" className="flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            <span className="min-w-0 truncate">Status unavailable: {statusError}. Search results can still be shown.</span>
            <button type="button" onClick={() => void loadStatus()} className="shrink-0 rounded border border-amber-500/30 px-2 py-0.5 font-medium hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">Retry status</button>
          </div>
        )}
        {status?.error && !indexing && !error && (
          <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            Last index failed: {status.error}
          </div>
        )}
        {status?.providers.some((provider) => provider.lastWarning) && (
          <div role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            <div className="font-medium">Source scan warnings</div>
            <div className="mt-1 space-y-0.5">
              {status.providers.filter((provider) => provider.lastWarning).map((provider) => <div key={provider.id}>{provider.label}: {provider.lastWarning}</div>)}
            </div>
          </div>
        )}
        {status?.providerDiscoveryError && (
          <div role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            Provider discovery {status.providerDiscoveryState === "stale" ? "is using a stale catalog" : "is unavailable"}; provider availability is not confirmed. {status.providerDiscoveryError}
          </div>
        )}
        {connState !== "connected" && (
          <div role="status" aria-live="polite" className="border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            Realtime connection is {connState}. Showing the last synced traces; refresh will reconcile durable data when it reconnects.
          </div>
        )}

        {loading && results.length === 0 ? (
          <p className="text-sm text-muted-foreground">Searching…</p>
        ) : !loading && results.length === 0 && searched && !error ? (
          <p className="text-sm text-muted-foreground">
            {query.trim()
              ? "No matching traces."
              : "No traces indexed yet — hit Reindex (or wait for the background indexer)."}
          </p>
        ) : error ? null : (
          <ResultTable results={results} providerAvailability={providerAvailability} onOpen={(r) => void openDetail(r.id)} />
        )}
    </SessionsSurface>
  );
}

// ---------------------------------------------------------------------------

function SessionsPanel({ subPath }: { subPath: string }) {
  if (subPath === "" || subPath === "overview" || subPath === "telemetry") {
    return <TelemetryPanel />;
  }
  if (subPath === "providers") {
    return <TelemetryPanel active="providers" />;
  }
  const traceOrigins: Array<{ prefix: string; returnSubPath: string }> = [
    { prefix: "trace/overview/", returnSubPath: "" },
    { prefix: "trace/traces/", returnSubPath: "traces" },
    { prefix: "trace/", returnSubPath: "traces" },
  ];
  const traceOrigin = traceOrigins.find(({ prefix }) => subPath.startsWith(prefix));
  if (traceOrigin) {
    try {
      return (
        <SessionSearchPanel
          initialSessionId={decodeURIComponent(subPath.slice(traceOrigin.prefix.length))}
          returnSubPath={traceOrigin.returnSubPath}
        />
      );
    } catch {
      return <SessionSearchPanel />;
    }
  }
  return <SessionSearchPanel />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "sessions",
    title: "Observability",
    icon: "History",
    path: "sessions",
    component: SessionsPanel,
  });
});
