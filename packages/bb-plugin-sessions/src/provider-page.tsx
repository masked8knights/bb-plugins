import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { DashboardResult, SourceStatusRecord } from "./telemetry";
import { PANEL_CONTENT_CLASS, PANEL_GUTTER_CLASS } from "./panel-layout";
import { providerLabel } from "./provider-labels";
import { sourceIsStale } from "./source-freshness";

type Range = "1h" | "6h" | "24h" | "7d" | "30d" | "lifetime";

const ranges: Array<{ id: Range; label: string }> = [
  { id: "1h", label: "1 hour" },
  { id: "6h", label: "6 hours" },
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "lifetime", label: "Lifetime" },
];

function formatNumber(value: number | null): string {
  return value === null ? "—" : new Intl.NumberFormat().format(value);
}

function formatTokens(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return formatNumber(value);
}

function formatUsd(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(value);
}

function tokenCoverageDetail(coverage: { known: number; missing: number }): string {
  return coverage.missing > 0
    ? `${coverage.missing.toLocaleString()} session${coverage.missing === 1 ? "" : "s"} missing token telemetry`
    : "Complete token telemetry";
}

function formatRate(errors: number, calls: number): string {
  if (calls === 0) return "—";
  return `${Math.round((errors / calls) * 100)}%`;
}

function timeAgo(value: number | null): string {
  if (!value) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function providerRisk(provider: DashboardResult["providers"][number]): "healthy" | "watch" | "failing" {
  if (provider.historicalOnly || provider.availability === "unknown") return "watch";
  if (provider.failed > 0 || provider.toolErrors > 0) return "failing";
  if (provider.sessions === 0 || provider.coverage.tools === "unavailable") return "watch";
  return "healthy";
}

function riskLabel(risk: ReturnType<typeof providerRisk>): string {
  if (risk === "failing") return "Needs attention";
  if (risk === "watch") return "Limited signal";
  return "Healthy";
}

export default function ProviderAggregatesPage() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [range, setRange] = useState<Range>("7d");
  const [dashboard, setDashboard] = useState<DashboardResult | null>(null);
  const [sources, setSources] = useState<SourceStatusRecord[]>([]);
  const [uncovered, setUncovered] = useState<Array<{ id: string; displayName: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [providerDiscoveryError, setProviderDiscoveryError] = useState<string | null>(null);
  const [providerDiscoveryState, setProviderDiscoveryState] = useState<"fresh" | "stale" | "unknown">("fresh");
  const [loading, setLoading] = useState(true);
  const [indexing, setIndexing] = useState<{ active: boolean; phase: string; provider: string | null; done: number; total: number } | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const loadSeq = useRef(0);
  const previousConnection = useRef(connection);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await rpc.call("telemetryDashboard", {
        view: "provider",
        range,
      });
      if (seq === loadSeq.current) {
        setDashboard(result.dashboard);
        setSources(result.sources);
        setUncovered(result.uncovered);
        setIndexing(result.indexing);
        setIndexError(result.error);
        setProviderDiscoveryError(result.providerDiscoveryError);
        setProviderDiscoveryState(result.providerDiscoveryState);
        setError(null);
      }
    } catch (reason) {
      if (seq === loadSeq.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [range, rpc]);

  useRealtime("sessions-index", (payload) => {
    const progress = payload as {
      phase?: string;
      provider?: string | null;
      done?: number;
      total?: number;
      message?: string;
    };
    const phase = progress.phase;
    if (phase === "done" || phase === "error") {
      setIndexing({
        active: false,
        phase,
        provider: null,
        done: progress.done ?? progress.total ?? 0,
        total: progress.total ?? 0,
      });
      setIndexError(phase === "error" ? progress.message ?? "Index failed" : null);
      setRefreshToken((value) => value + 1);
    } else {
      setIndexing((previous) => ({
        active: true,
        phase: phase ?? "indexing",
        provider: progress.provider ?? previous?.provider ?? null,
        done: progress.done ?? previous?.done ?? 0,
        total: progress.total ?? previous?.total ?? 0,
      }));
      setIndexError(null);
    }
  });
  useEffect(() => { void load(); }, [load, refreshToken]);
  useEffect(() => {
    if (previousConnection.current !== connection && connection === "connected") void load();
    previousConnection.current = connection;
  }, [connection, load]);

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className={`${PANEL_CONTENT_CLASS} ${PANEL_GUTTER_CLASS} flex flex-col gap-6 py-6`}>
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Provider aggregates</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Compare reliability, tool behavior, and usage across local harnesses.
              {dashboard?.stale ? " Data may be stale while the index recovers." : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="provider-range">Time range</label>
            <select
              id="provider-range"
              value={range}
              onChange={(event) => {
                setError(null);
                setRange(event.target.value as Range);
              }}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {ranges.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md border border-border px-2.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              Refresh
            </button>
          </div>
        </header>

        {connection !== "connected" && (
          <div role="status" aria-live="polite" className="border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            Realtime connection is {connection}. Showing the last synced provider data; refresh will reconcile durable data when it reconnects.
          </div>
        )}
        {indexing?.active && (
          <div role="status" aria-live="polite" className="motion-safe:animate-pulse motion-reduce:animate-none border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            Indexing {indexing.provider ?? "sources"} — {indexing.phase} · {indexing.done}{indexing.total ? ` / ${indexing.total}` : ""}
          </div>
        )}
        {indexError && !indexing?.active && (
          <div role="alert" className="border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            Last index failed: {indexError}
          </div>
        )}
        {error && (
          <div role="alert" className="flex items-center justify-between gap-3 border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <span>{error}</span>
            <button type="button" onClick={() => void load()} className="rounded-md border border-destructive/30 px-2 py-1 text-xs hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">Retry</button>
          </div>
        )}
        {providerDiscoveryError && !error && (
          <div role="alert" className="border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            Provider discovery {providerDiscoveryState === "stale" ? "is using a stale catalog" : "is unavailable"}; provider availability is not confirmed. {providerDiscoveryError}
          </div>
        )}
        {sources.some((source) => source.lastError || source.lastWarning) && (
          <div role="alert" className="border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            <div className="font-medium">Source scan warnings</div>
            <div className="mt-1 space-y-0.5 text-xs">
              {sources.filter((source) => source.lastError || source.lastWarning).map((source) => (
                <div key={source.id}>{source.label}: {source.lastError ?? source.lastWarning}</div>
              ))}
            </div>
          </div>
        )}
        {sources.some((source) => sourceIsStale(source)) && (
          <div role="status" className="border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            Some source data is stale. {sources.filter((source) => sourceIsStale(source)).map((source) => `${source.label} (last scan ${timeAgo(source.lastSuccessAt)})`).join(", ")}.
          </div>
        )}
        {uncovered.length > 0 && (
          <div role="status" className="border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Active providers without session adapters:</span>{" "}
            {uncovered.map((provider) => `${provider.displayName} (${provider.id})`).join(", ")}
          </div>
        )}

        {loading && dashboard && (
          <div role="status" aria-live="polite" className="border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">Refreshing provider aggregates… previous results are shown until the new request finishes loading.</div>
        )}
        {loading && !dashboard ? (
          <p role="status" aria-live="polite" className="border-y border-border py-8 text-sm text-muted-foreground">Loading provider aggregates…</p>
        ) : dashboard ? (
          <>
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-y border-border py-4 sm:grid-cols-4">
              <div><span className="block text-[11px] uppercase tracking-wide text-muted-foreground">Sessions</span><strong className="mt-1 block text-lg font-semibold tabular-nums">{formatNumber(dashboard.totals.sessions)}</strong></div>
              <div><span className="block text-[11px] uppercase tracking-wide text-muted-foreground">Failed</span><strong className={`mt-1 block text-lg font-semibold tabular-nums ${dashboard.totals.failed ? "text-destructive" : ""}`}>{formatNumber(dashboard.totals.failed)}</strong></div>
              <div><span className="block text-[11px] uppercase tracking-wide text-muted-foreground">Tool errors</span><strong className={`mt-1 block text-lg font-semibold tabular-nums ${dashboard.totals.toolErrors ? "text-destructive" : ""}`}>{formatNumber(dashboard.totals.toolErrors)}</strong></div>
              <div><span className="block text-[11px] uppercase tracking-wide text-muted-foreground">Tokens</span><strong className="mt-1 block text-lg font-semibold tabular-nums">{formatTokens(dashboard.totals.totalTokens)}</strong></div>
            </div>

            <section>
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-medium text-foreground">Harness health</h2>
                <span className="text-xs text-muted-foreground">{ranges.find((option) => option.id === dashboard.range)?.label}</span>
              </div>
              <div className="overflow-x-auto border-y border-border">
                <table className="w-full min-w-[760px] text-left text-xs">
                  <thead className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Provider</th>
                      <th className="px-3 py-2 text-right font-medium">Sessions</th>
                      <th className="px-3 py-2 text-right font-medium">Failed</th>
                      <th className="px-3 py-2 text-right font-medium">Tool calls</th>
                      <th className="px-3 py-2 text-right font-medium">Tool errors</th>
                      <th className="px-3 py-2 text-right font-medium">Error rate</th>
                      <th className="px-3 py-2 text-right font-medium">Tokens</th>
                      <th className="px-3 py-2 text-right font-medium">Cost</th>
                      <th className="py-2 pl-3 text-right font-medium">Last activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.providers.length ? dashboard.providers.map((provider) => {
                      const risk = providerRisk(provider);
                      return (
                        <tr key={provider.provider} className="border-b border-border/60 last:border-0">
                          <td className="py-3 pr-3">
                            <div className="flex items-center gap-2">
                              <span className={`size-2 rounded-full ${risk === "failing" ? "bg-destructive" : risk === "watch" ? "bg-amber-500" : "bg-emerald-500"}`} aria-hidden="true" />
                              <span className="font-medium text-foreground">{provider.label || providerLabel(provider.provider)}</span>
                              {provider.historicalOnly ? <span className="rounded border border-amber-500/30 px-1.5 py-0.5 text-[10px] font-normal text-amber-700 dark:text-amber-300">historical</span> : provider.availability === "unknown" ? <span className="rounded border border-amber-500/30 px-1.5 py-0.5 text-[10px] font-normal text-amber-700 dark:text-amber-300">availability unknown</span> : null}
                            </div>
                            <span className="ml-4 block text-[11px] text-muted-foreground">{provider.historicalOnly ? "Historical only · rehydrate may use project defaults" : provider.availability === "unknown" ? "Availability unknown until provider discovery recovers" : riskLabel(risk)}</span>
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{formatNumber(provider.sessions)}</td>
                          <td className={`px-3 py-3 text-right tabular-nums ${provider.failed ? "text-destructive" : "text-muted-foreground"}`}>{formatNumber(provider.failed)}</td>
                          <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{formatNumber(provider.toolCalls)}</td>
                          <td className={`px-3 py-3 text-right tabular-nums ${provider.toolErrors ? "text-destructive" : "text-muted-foreground"}`}>{formatNumber(provider.toolErrors)}</td>
                          <td className={`px-3 py-3 text-right tabular-nums ${provider.toolErrors ? "text-destructive" : "text-muted-foreground"}`}>{formatRate(provider.toolErrors, provider.toolCalls)}</td>
                          <td className="px-3 py-3 text-right tabular-nums text-muted-foreground" title={provider.totalTokenCoverage.missing > 0 ? tokenCoverageDetail(provider.totalTokenCoverage) : undefined}>{formatTokens(provider.totalTokens)}{provider.totalTokenCoverage.missing > 0 ? "†" : ""}</td>
                          <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{formatUsd(provider.costUsd)}{provider.costEstimated ? "*" : ""}</td>
                          <td className="py-3 pl-3 text-right text-muted-foreground">{timeAgo(provider.lastActivityAt)}</td>
                        </tr>
                      );
                    }) : <tr><td colSpan={9} className="py-6 text-center text-muted-foreground">No provider activity in this range.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-medium text-foreground">Tool errors by harness</h2>
                <span className="text-xs text-muted-foreground">provider-level indexed metrics</span>
              </div>
              <div className="border-y border-border">
                {dashboard.tools.filter((tool) => tool.failures > 0).sort((left, right) => right.failures - left.failures).slice(0, 8).map((tool) => (
                  <div key={`${tool.provider}:${tool.name}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 py-3 last:border-0">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{tool.name}</span>
                    <span className="text-xs text-muted-foreground">{providerLabel(tool.provider)}</span>
                    <span className="text-xs tabular-nums text-destructive">{tool.failures} failures</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{tool.calls} calls · {formatRate(tool.failures, tool.calls)}</span>
                  </div>
                ))}
                {dashboard.tools.length === 0 ? (
                  <p className="py-6 text-sm text-muted-foreground">No tool telemetry in this range.</p>
                ) : dashboard.tools.every((tool) => tool.failures === 0) ? (
                  <p className="py-6 text-sm text-muted-foreground">No tool errors in this range.</p>
                ) : dashboard.tools.filter((tool) => tool.failures > 0).length > 8 ? (
                  <p className="border-t border-border/60 py-2 text-xs text-muted-foreground">Showing 8 error sources; {dashboard.tools.filter((tool) => tool.failures > 0).length - 8} more are present.</p>
                ) : null}
              </div>
            </section>
          </>
        ) : !error ? (
          <p className="border-y border-border py-8 text-sm text-muted-foreground">No provider data yet.</p>
        ) : null}
      </div>
    </div>
  );
}
