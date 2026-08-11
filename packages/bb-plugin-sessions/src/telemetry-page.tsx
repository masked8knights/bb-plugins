import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import type {
  DashboardInput,
  DashboardResult,
  FindingRecord,
  ProviderAvailability,
  ProviderSessionRecord,
  SourceStatusRecord,
} from "./telemetry";
import type { rpcContract } from "../server";
import { PANEL_CONTENT_CLASS, PANEL_GUTTER_CLASS } from "./panel-layout";
import { providerLabel as canonicalProviderLabel } from "./provider-labels";
import { sourceIsStale } from "./source-freshness";

type ChartMetric = "tokens" | "sessions" | "turns" | "errors";
type BreakdownMode = "model" | "day";

let pendingOverviewFocusId: string | null = null;
let pendingOverviewFocusAttempts = 0;

/** Remember the Overview row that opened a trace so Back can restore focus. */
export function rememberOverviewFocus(id: string): void {
  pendingOverviewFocusId = id;
  pendingOverviewFocusAttempts = 0;
}

function restorePendingOverviewFocus(): void {
  if (!pendingOverviewFocusId || typeof document === "undefined") return;
  const target = document.getElementById(`overview-session-${encodeURIComponent(pendingOverviewFocusId)}`);
  if (target instanceof HTMLElement) {
    pendingOverviewFocusId = null;
    pendingOverviewFocusAttempts = 0;
    target.focus();
    return;
  }
  pendingOverviewFocusAttempts += 1;
  if (pendingOverviewFocusAttempts < 60) {
    requestAnimationFrame(restorePendingOverviewFocus);
    return;
  }
  const fallback = document.getElementById("observability-tab-overview");
  pendingOverviewFocusId = null;
  pendingOverviewFocusAttempts = 0;
  if (fallback instanceof HTMLElement) fallback.focus();
}

function compactDashboardInput(input: DashboardInput): DashboardInput {
  const compact: DashboardInput = { view: input.view, range: input.range };
  if (input.providers !== undefined) compact.providers = input.providers;
  if (input.hostId !== undefined) compact.hostId = input.hostId;
  if (input.projectId !== undefined) compact.projectId = input.projectId;
  if (input.model !== undefined) compact.model = input.model;
  if (input.archived !== undefined) compact.archived = input.archived;
  return compact;
}

const providerColor: Record<string, string> = {
  codex: "#b8b8b8",
  claude: "#d97757",
  pi: "#a78bfa",
  hermes: "#22d3ee",
  prime: "#818cf8",
  opencode: "#38bdf8",
  omp: "#fb7185",
  other: "#94a3b8",
};

const providerTone: Record<string, string> = {
  codex: "border-foreground/25 bg-foreground/5",
  claude: "border-orange-500/35 bg-orange-500/10",
  pi: "border-violet-500/35 bg-violet-500/10",
  prime: "border-indigo-500/35 bg-indigo-500/10",
  opencode: "border-sky-500/35 bg-sky-500/10",
  hermes: "border-cyan-500/35 bg-cyan-500/10",
  omp: "border-rose-500/35 bg-rose-500/10",
  other: "border-border bg-muted/50",
};

const ranges: Array<{ id: DashboardInput["range"]; label: string; short: string }> = [
  { id: "1h", label: "1 hour", short: "1h" },
  { id: "6h", label: "6 hours", short: "6h" },
  { id: "24h", label: "24 hours", short: "24h" },
  { id: "7d", label: "7 days", short: "7d" },
  { id: "30d", label: "30 days", short: "30d" },
  { id: "lifetime", label: "Lifetime", short: "All" },
];

const chartMetricOptions: Array<{ id: ChartMetric; label: string }> = [
  { id: "tokens", label: "Tokens" },
  { id: "sessions", label: "Sessions" },
  { id: "turns", label: "Turns" },
  { id: "errors", label: "Errors" },
];

function providerLabel(id: string): string {
  return canonicalProviderLabel(id);
}

function ProviderMark({ provider, className = "h-2 w-2" }: { provider: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 rounded-full ${className}`}
      style={{ backgroundColor: providerColor[provider] ?? providerColor.other }}
    />
  );
}

function ProviderBadge({
  provider,
  historical = false,
  availability,
}: {
  provider: string;
  historical?: boolean;
  availability?: ProviderAvailability;
}) {
  const isHistorical = historical || availability === "historical";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${providerTone[provider] ?? providerTone.other}`}>
        <ProviderMark provider={provider} />
        {providerLabel(provider)}
      </span>
      {isHistorical ? <span className="rounded border border-amber-500/30 px-1 py-0.5 text-[10px] font-normal text-amber-700 dark:text-amber-300">historical</span> : availability === "unknown" ? <span className="rounded border border-amber-500/30 px-1 py-0.5 text-[10px] font-normal text-amber-700 dark:text-amber-300">availability unknown</span> : null}
    </span>
  );
}

function formatNumber(value: number | null | undefined): string {
  return value == null ? "—" : new Intl.NumberFormat().format(value);
}

function formatTokens(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return formatNumber(value);
}

function tokenCoverageNote(coverage: { known: number; missing: number }): string {
  return coverage.missing > 0
    ? `${formatNumber(coverage.missing)} session${coverage.missing === 1 ? "" : "s"} missing token telemetry`
    : "Complete token telemetry";
}

function formatUsd(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

function formatPercent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : `${Math.round(value * 100)}%`;
}

function formatDuration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value < 1_000) return `${Math.round(value)}ms`;
  const seconds = value / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
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

function formatDay(value: string): string {
  const hourly = value.includes(" ");
  const date = new Date(hourly ? value.replace(" ", "T") : `${value}T12:00:00`);
  return Number.isNaN(date.valueOf())
    ? value
    : hourly
      ? date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" })
      : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dateRangeLabel(_dashboard: DashboardResult, range: DashboardInput["range"]): string {
  return ranges.find((option) => option.id === range)?.label ?? range;
}

function statusTone(source: SourceStatusRecord): string {
  if (!source.enabled) return "text-muted-foreground";
  if (source.remoteDatabaseUnsupported || source.lastError) return "text-destructive";
  if (source.availability !== "active") return "text-amber-700 dark:text-amber-300";
  if (source.lastWarning) return "text-amber-700 dark:text-amber-300";
  if (sourceIsStale(source)) return "text-amber-700 dark:text-amber-300";
  if (source.detected) return "text-emerald-600 dark:text-emerald-400";
  return "text-muted-foreground";
}

function StatusDot({ source }: { source: SourceStatusRecord }) {
  return <span aria-hidden="true" className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-current align-middle ${statusTone(source)}`} />;
}

function sourceTitle(source: SourceStatusRecord): string {
  return [
    source.pathLabel,
    `${source.storeKind} on ${source.hostId}`,
    source.lastSuccessAt ? `last scan ${new Date(source.lastSuccessAt).toLocaleString()}` : "never scanned",
    source.lastError ?? "",
    source.lastWarning ?? "",
  ].filter(Boolean).join(" · ");
}

function sourceQuietState(source: SourceStatusRecord): string {
  if (!source.enabled) return "disabled";
  if (source.remoteDatabaseUnsupported) return "remote DB unsupported";
  if (source.lastError) return "scan error";
  if (source.availability === "historical") return "historical/unavailable";
  if (source.availability === "unknown") return "availability unknown";
  if (sourceIsStale(source)) return `stale · last scan ${timeAgo(source.lastSuccessAt)}`;
  if (source.detected) return "no sessions indexed";
  return "not detected";
}

function RefreshIcon() {
  return (
    <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none">
      <path d="M13.25 5.75A5.25 5.25 0 1 0 13.5 9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M13.25 2.75v3.5h-3.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SegmentedControl<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
}: {
  ariaLabel: string;
  options: Array<{ id: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div aria-label={ariaLabel} className="flex overflow-hidden rounded-md border border-border" role="group">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={option.id === value}
          onClick={() => onChange(option.id)}
          className={`cursor-pointer px-2.5 py-1.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${option.id === value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 bg-background px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-lg text-foreground tabular-nums">{value}</span>
      <span className="truncate text-xs text-muted-foreground">{detail}</span>
    </div>
  );
}

function FindingList({ findings }: { findings: FindingRecord[] }) {
  if (!findings.length) return null;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">Reliability signals</h2>
        <span className="text-xs text-muted-foreground">Evidence-backed observations</span>
      </div>
      <div className="divide-y divide-border/60 border-y border-border">
        {findings.slice(0, 8).map((finding) => (
          <div key={finding.id} className="flex flex-wrap items-start gap-3 py-3">
            <span className={`mt-0.5 w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wide ${finding.severity === "critical" ? "text-destructive" : finding.severity === "warning" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>
              {finding.severity}
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-medium text-foreground">{finding.title}</div>
              <div className="mt-1 text-sm text-muted-foreground">{finding.summary}</div>
              <div className="mt-1 text-xs text-muted-foreground">{finding.coverageNote}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SourceHealth({
  sources,
  indexedSessions,
  uncovered = [],
}: {
  sources: SourceStatusRecord[];
  indexedSessions?: number;
  uncovered?: Array<{ id: string; displayName: string }>;
}) {
  if (!sources.length && !uncovered.length) return null;
  const indexedSources = sources.filter((source) => source.count > 0);
  const quietSources = sources.filter((source) => source.count === 0);
  const indexedCount = indexedSessions ?? indexedSources.reduce((total, source) => total + source.count, 0);

  return (
    <section aria-labelledby="indexed-sources-heading" className="border-y border-border">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="indexed-sources-heading" className="text-sm font-medium text-foreground">Indexed sources</h2>
          <p className="text-xs text-muted-foreground">
            {formatNumber(indexedCount)} sessions indexed · {indexedSources.length} sources
          </p>
        </div>
        <span className="text-[11px] text-muted-foreground">Local index</span>
      </div>

      {indexedSources.length ? (
        <div className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-3 lg:grid-cols-4">
          {indexedSources.map((source) => (
            <div key={source.id} className="min-w-0 bg-background px-3 py-3" title={sourceTitle(source)}>
              <div className={`flex min-w-0 items-center text-xs font-medium ${statusTone(source)}`}>
                <StatusDot source={source} />
                <span className="truncate text-foreground">{source.label}</span>
                {source.availability === "historical" ? <span className="ml-auto pl-2 text-[10px] font-normal text-amber-700 dark:text-amber-300">historical</span> : source.availability === "unknown" ? <span className="ml-auto pl-2 text-[10px] font-normal text-amber-700 dark:text-amber-300">unknown</span> : null}
                {sourceIsStale(source) ? <span className="ml-auto pl-2 text-[10px] font-normal text-amber-700 dark:text-amber-300">stale</span> : null}
                {source.lastWarning ? <span className="ml-auto pl-2 text-[10px] font-normal text-amber-700 dark:text-amber-300">partial</span> : null}
              </div>
              <div className="mt-2 text-lg leading-none text-foreground tabular-nums">{formatNumber(source.count)}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                sessions · {source.lastSuccessAt ? `last scan ${timeAgo(source.lastSuccessAt)}` : "never scanned"}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="border-t border-border px-3 py-3 text-xs text-muted-foreground">No sessions indexed yet.</div>
      )}

      {quietSources.length ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">Not indexed</span>
          {quietSources.map((source) => (
            <span key={source.id} title={sourceTitle(source)}>
              <StatusDot source={source} />
              {source.label}
              <span className="ml-1">{sourceQuietState(source)}</span>
              {!sourceIsStale(source) && source.lastSuccessAt ? <span className="ml-1">· last scan {timeAgo(source.lastSuccessAt)}</span> : null}
            </span>
          ))}
        </div>
      ) : null}
      {uncovered.length ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">Active providers without session adapters</span>
          {uncovered.map((provider) => (
            <span key={provider.id} title={provider.id}>
              {provider.displayName}
              <span className="ml-1">not indexed</span>
            </span>
          ))}
        </div>
      ) : null}
      {sources.some((source) => source.lastError || source.lastWarning) ? (
        <div role="alert" className="border-t border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <div className="font-medium">Source scan warnings</div>
          <div className="mt-1 space-y-0.5">
            {sources.filter((source) => source.lastError || source.lastWarning).map((source) => (
              <div key={source.id}>{source.label}: {source.lastError ?? source.lastWarning}</div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Toolbar({
  input,
  sources,
  busy,
  onChange,
}: {
  input: DashboardInput;
  sources: SourceStatusRecord[];
  busy: boolean;
  onChange: (next: Partial<DashboardInput>) => void;
}) {
  const selectedProvider = input.providers?.[0] ?? "all";
  const availableProviders = [...new Set(sources.map((source) => source.provider))];
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>View</span>
          <select aria-label="View" value={input.view} onChange={(event) => onChange({ view: event.target.value as DashboardInput["view"] })} className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <option value="provider">By harness</option>
            <option value="unified">Unified</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>Harness</span>
          <select aria-label="Harness" value={selectedProvider} onChange={(event) => onChange({ providers: event.target.value === "all" ? undefined : [event.target.value as NonNullable<DashboardInput["providers"]>[number]] })} className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <option value="all">All harnesses</option>
            {availableProviders.map((provider) => {
              const source = sources.find((candidate) => candidate.provider === provider);
              return <option key={provider} value={provider}>{providerLabel(provider)}{source?.availability === "historical" ? " · historical" : source?.availability === "unknown" ? " · availability unknown" : ""}</option>;
            })}
          </select>
        </label>
      </div>
      <span className="text-xs text-muted-foreground">{busy ? "Indexing sources…" : "Metrics are local to the Sessions index"}</span>
    </div>
  );
}

function totalForMetric(dashboard: DashboardResult, metric: ChartMetric): number | null {
  if (metric === "tokens") return dashboard.totals.totalTokens;
  if (metric === "sessions") return dashboard.totals.sessions;
  if (metric === "turns") return dashboard.totals.turns;
  return dashboard.totals.toolErrors;
}

function providerValueForMetric(provider: DashboardResult["providers"][number], metric: ChartMetric): number | null {
  if (metric === "tokens") return provider.totalTokens;
  if (metric === "sessions") return provider.sessions;
  if (metric === "turns") return provider.turns;
  return provider.toolErrors;
}

function metricLabel(metric: ChartMetric): string {
  return chartMetricOptions.find((option) => option.id === metric)?.label ?? metric;
}

function formatMetricValue(value: number | null, metric: ChartMetric): string {
  return metric === "tokens" ? formatTokens(value) : formatNumber(value);
}

function metricValueForDay(
  day: DashboardResult["daily"][number],
  provider: string,
  metric: ChartMetric,
): number {
  const row = day.byProvider[provider];
  if (row === undefined) return 0;
  if (metric === "tokens") return row.totalTokens ?? 0;
  if (metric === "sessions") return row.sessions;
  if (metric === "turns") return row.turns;
  return row.toolErrors;
}

function linePath(values: number[], max: number, width: number, height: number): string {
  if (!values.length || max <= 0) return "";
  if (values.length === 1) {
    const y = height - (values[0]! / max) * (height - 8);
    return `M0,${y.toFixed(2)} L${width},${y.toFixed(2)}`;
  }
  const step = width / (values.length - 1);
  return values.map((value, index) => {
    const x = index * step;
    const y = height - (value / max) * (height - 8);
    return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

function TelemetryChart({ dashboard, metric }: { dashboard: DashboardResult; metric: ChartMetric }) {
  const width = 960;
  const height = 220;
  const providers = dashboard.providers.filter((provider) => provider.sessions > 0);
  const series = providers.map((provider) => ({
    provider: provider.provider,
    values: dashboard.daily.map((day) => metricValueForDay(day, provider.provider, metric)),
  }));
  const peak = Math.max(0, ...series.flatMap((item) => item.values));
  const ticks = peak > 0 ? [peak, peak / 2, 0] : [];
  const hasValues = peak > 0 && dashboard.daily.length > 0;
  const dataTableId = `telemetry-data-${metric}`;
  const bucketWord = dashboard.range === "1h" || dashboard.range === "6h" || dashboard.range === "24h"
    ? "Hourly"
    : "Daily";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <div className="relative h-56 w-14 shrink-0">
          {ticks.map((tick) => (
            <span key={tick} className="absolute right-0 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums" style={{ top: `${peak === 0 ? 100 : ((peak - tick) / peak) * 92 + 4}%` }}>
              {formatMetricValue(tick, metric)}
            </span>
          ))}
        </div>
        <div className="relative h-56 min-w-0 flex-1">
          {hasValues ? (
            <svg className="h-full w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${bucketWord} ${metricLabel(metric).toLowerCase()} by harness`} aria-describedby={dataTableId}>
              {ticks.map((tick) => {
                const y = peak === 0 ? height : height - (tick / peak) * (height - 8);
                return <line key={tick} x1="0" x2={width} y1={y} y2={y} stroke="currentColor" strokeWidth="1" className="text-border" vectorEffect="non-scaling-stroke" />;
              })}
              {series.map(({ provider, values }) => {
                const path = linePath(values, peak, width, height);
                if (!path) return null;
                return <path key={`${provider}-area`} d={`${path} L${width},${height} L0,${height} Z`} fill={providerColor[provider] ?? providerColor.other} fillOpacity="0.12" />;
              })}
              {series.map(({ provider, values }) => {
                const path = linePath(values, peak, width, height);
                return path ? <path key={provider} d={path} fill="none" stroke={providerColor[provider] ?? providerColor.other} strokeWidth="2" vectorEffect="non-scaling-stroke" /> : null;
              })}
            </svg>
          ) : (
            <div className="flex h-full items-center justify-center border-y border-border text-xs text-muted-foreground">
              No measured {metricLabel(metric).toLowerCase()} in this window.
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-between pl-16 text-[10px] uppercase text-muted-foreground">
        <span>{dashboard.daily[0] ? formatDay(dashboard.daily[0].date) : ""}</span>
        <span>{dashboard.daily[Math.floor(dashboard.daily.length / 2)] ? formatDay(dashboard.daily[Math.floor(dashboard.daily.length / 2)]!.date) : ""}</span>
        <span>{dashboard.daily[dashboard.daily.length - 1] ? formatDay(dashboard.daily[dashboard.daily.length - 1]!.date) : ""}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-16 pt-2">
        {providers.map((provider) => (
          <span key={provider.provider} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ProviderMark provider={provider.provider} />
            {providerLabel(provider.provider)}
          </span>
        ))}
      </div>
      <div id={dataTableId} className="sr-only">
        <table>
          <caption>{bucketWord} {metricLabel(metric).toLowerCase()} by harness</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              {providers.map((provider) => <th scope="col" key={provider.provider}>{providerLabel(provider.provider)}</th>)}
            </tr>
          </thead>
          <tbody>
            {dashboard.daily.map((day) => (
              <tr key={day.date}>
                <th scope="row">{formatDay(day.date)}</th>
                {providers.map((provider) => (
                  <td key={provider.provider}>{formatMetricValue(metricValueForDay(day, provider.provider, metric), metric)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HeadlinePanel({ dashboard, metric }: { dashboard: DashboardResult; metric: ChartMetric }) {
  const total = totalForMetric(dashboard, metric);
  const providers = dashboard.providers.filter((provider) => provider.sessions > 0);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">{metricLabel(metric)}</span>
        <span className="text-4xl font-semibold text-foreground tabular-nums">{formatMetricValue(total, metric)}</span>
        <span className="text-xs text-muted-foreground">
          {metric === "tokens"
            ? `Observed across ${formatNumber(dashboard.totals.sessions)} sessions in this range${dashboard.range === "lifetime" ? "." : ` · ${formatNumber(dashboard.indexedSessions)} indexed lifetime.`} ${tokenCoverageNote(dashboard.totals.totalTokenCoverage)}`
            : `Observed across ${formatNumber(dashboard.totals.sessions)} sessions and ${formatNumber(dashboard.totals.turns)} turns${dashboard.range === "lifetime" ? "." : ` · ${formatNumber(dashboard.indexedSessions)} indexed lifetime.`}`}
        </span>
      </div>
      {providers.length ? providers.map((provider) => {
        const value = providerValueForMetric(provider, metric);
        const share = value != null && total != null && total > 0 ? value / total : 0;
        return (
          <div key={provider.provider} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2 text-sm text-foreground"><ProviderMark provider={provider.provider} className="h-2.5 w-2.5" />{providerLabel(provider.provider)}</span>
              <span className="shrink-0 text-sm text-foreground tabular-nums">{formatMetricValue(value, metric)}</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted"><div className="h-full" style={{ width: `${Math.min(100, share * 100).toFixed(1)}%`, backgroundColor: providerColor[provider.provider] ?? providerColor.other }} /></div>
            <span className="text-xs text-muted-foreground">{formatPercent(total && total > 0 ? share : null)} of view</span>
          </div>
        );
      }) : <div className="border-y border-border py-4 text-xs text-muted-foreground">No harness activity in this window.</div>}
    </div>
  );
}

function deriveMetrics(dashboard: DashboardResult) {
  const totals = dashboard.totals;
  const observedInput = (totals.inputTokens ?? 0) + (totals.cachedInputTokens ?? 0);
  const cacheReadShare = observedInput > 0 && totals.cachedInputTokens != null ? totals.cachedInputTokens / observedInput : null;
  const tokensPerTurn = totals.totalTokenCoverage.missing === 0 && totals.totalTokens != null && totals.turns > 0 ? totals.totalTokens / totals.turns : null;
  const toolSuccess = totals.toolCalls > 0 ? 1 - totals.toolErrors / totals.toolCalls : null;
  return { cacheReadShare, tokensPerTurn, toolSuccess };
}

function MetricsStrip({ dashboard }: { dashboard: DashboardResult }) {
  const metrics = deriveMetrics(dashboard);
  const cacheDetail = dashboard.totals.cachedInputTokens == null ? "Token cache data unavailable" : `${formatTokens(dashboard.totals.cachedInputTokens)} cached input`;
  const contextDetail = dashboard.totals.contextPeak == null ? "No context snapshots" : `${formatNumber(dashboard.totals.compactions)} compactions`;
  const costDetail = dashboard.totals.costUsd == null ? "Token usage unavailable" : dashboard.totals.costEstimated ? "Some models use fallback pricing" : "Model-matched list prices";
  return (
    <section className="grid grid-cols-2 gap-px border-y border-border bg-border md:grid-cols-4 lg:grid-cols-7">
      <Metric label="Processed tokens" value={formatTokens(dashboard.totals.totalTokens)} detail={metrics.tokensPerTurn == null ? tokenCoverageNote(dashboard.totals.totalTokenCoverage) : `${formatTokens(metrics.tokensPerTurn)} per turn`} />
      <Metric label="Estimated cost" value={formatUsd(dashboard.totals.costUsd)} detail={costDetail} />
      <Metric label="Cache read share" value={formatPercent(metrics.cacheReadShare)} detail={cacheDetail} />
      <Metric label="Tool success" value={formatPercent(metrics.toolSuccess)} detail={`${formatNumber(dashboard.totals.toolCalls)} calls observed`} />
      <Metric label="Context peak" value={formatTokens(dashboard.totals.contextPeak)} detail={contextDetail} />
      <Metric label="Active sessions" value={formatNumber(dashboard.totals.active)} detail={`of ${formatNumber(dashboard.totals.sessions)} in view`} />
      <Metric label="Failed sessions" value={formatNumber(dashboard.totals.failed)} detail={dashboard.totals.failed ? "Needs review" : "No failed sessions"} />
    </section>
  );
}

function harnessStats(provider: DashboardResult["providers"][number]) {
  return {
    turnsPerSession: provider.sessions > 0 ? provider.turns / provider.sessions : null,
    tokensPerTurn: provider.totalTokenCoverage.missing === 0 && provider.totalTokens != null && provider.turns > 0 ? provider.totalTokens / provider.turns : null,
    toolSuccess: provider.toolCalls > 0 ? 1 - provider.toolErrors / provider.toolCalls : null,
    contextPeak: provider.contextPeak,
    averageDuration: provider.averageDurationMs,
  };
}

function HarnessTable({ dashboard }: { dashboard: DashboardResult }) {
  const providers = dashboard.providers.filter((provider) => provider.sessions > 0);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">Harness breakdown</h2>
        <span className="text-xs text-muted-foreground">Performance and reliability by runtime</span>
      </div>
      <div className="overflow-x-auto border-y border-border">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="border-b border-border text-xs text-muted-foreground">
            <tr>
              <th className="py-2 pr-3 font-normal">Harness</th>
              <th className="px-3 py-2 text-right font-normal">Sessions</th>
              <th className="px-3 py-2 text-right font-normal">Turns / session</th>
              <th className="px-3 py-2 text-right font-normal">Tokens / turn</th>
              <th className="px-3 py-2 text-right font-normal">Tool calls</th>
              <th className="px-3 py-2 text-right font-normal">Tool success</th>
              <th className="px-3 py-2 text-right font-normal">Context peak</th>
              <th className="px-3 py-2 text-right font-normal">Cost</th>
              <th className="py-2 pl-3 text-right font-normal">Avg session</th>
            </tr>
          </thead>
          <tbody>
            {providers.length ? providers.map((provider) => {
              const stats = harnessStats(provider);
              return (
                <tr key={provider.provider} className="border-b border-border/50 last:border-b-0">
                  <td className="py-2 pr-3"><ProviderBadge provider={provider.provider} availability={provider.availability} /></td>
                  <td className="px-3 py-2 text-right text-foreground tabular-nums">{formatNumber(provider.sessions)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{stats.turnsPerSession == null ? "—" : stats.turnsPerSession.toFixed(1)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{formatTokens(stats.tokensPerTurn)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{formatNumber(provider.toolCalls)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${stats.toolSuccess != null && stats.toolSuccess < 0.9 ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>{formatPercent(stats.toolSuccess)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{formatTokens(stats.contextPeak)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums" title={provider.costEstimated ? "Some sessions use fallback pricing" : undefined}>{formatUsd(provider.costUsd)}{provider.costEstimated ? "*" : ""}</td>
                  <td className="py-2 pl-3 text-right text-muted-foreground tabular-nums">{formatDuration(stats.averageDuration)}</td>
                </tr>
              );
            }) : <tr><td colSpan={9} className="py-6 text-center text-muted-foreground">No harness activity in this window.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ToolsTable({ dashboard }: { dashboard: DashboardResult }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">Tool totals by harness</h2>
        <span className="text-xs text-muted-foreground">Provider-level indexed tool metrics</span>
      </div>
      <div className="overflow-x-auto border-y border-border">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b border-border text-xs text-muted-foreground">
            <tr>
              <th className="py-2 pr-3 text-left font-normal">Harness</th>
              <th className="px-3 py-2 text-left font-normal">Tool</th>
              <th className="px-3 py-2 text-right font-normal">Calls</th>
              <th className="px-3 py-2 text-right font-normal">Failed</th>
              <th className="py-2 pl-3 text-right font-normal">Failure rate</th>
            </tr>
          </thead>
          <tbody>
            {dashboard.tools.length ? dashboard.tools.map((tool) => (
              <tr key={`${tool.provider}:${tool.name}`} className="border-b border-border/50 last:border-b-0">
                <td className="py-2 pr-3"><ProviderBadge provider={tool.provider} availability={dashboard.providers.find((provider) => provider.provider === tool.provider)?.availability} /></td>
                <td className="max-w-[300px] truncate px-3 py-2 font-mono text-[11px] text-foreground" title={tool.name}>{tool.name}</td>
                <td className="px-3 py-2 text-right text-foreground tabular-nums">{formatNumber(tool.calls)}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${tool.failures ? "text-destructive" : "text-muted-foreground"}`}>{formatNumber(tool.failures)}</td>
                <td className={`py-2 pl-3 text-right tabular-nums ${tool.failureRate != null && tool.failureRate >= 0.25 ? "text-destructive" : "text-muted-foreground"}`}>{formatPercent(tool.failureRate)}</td>
              </tr>
            )) : <tr><td colSpan={5} className="py-6 text-center text-muted-foreground">No indexed tool metrics are available.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Breakdown({ dashboard, mode, onModeChange }: { dashboard: DashboardResult; mode: BreakdownMode; onModeChange: (mode: BreakdownMode) => void }) {
  const recentDays = [...dashboard.daily].reverse().slice(0, 8);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
        <SegmentedControl ariaLabel="Breakdown view" options={[{ id: "model", label: "Model" }, { id: "day", label: "Day" }]} value={mode} onChange={onModeChange} />
      </div>
      {mode === "model" ? (
        <div className="overflow-x-auto border-y border-border">
          <table className="w-full min-w-[580px] text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr><th className="py-2 pr-3 font-normal">Model</th><th className="px-3 py-2 font-normal">Harness</th><th className="px-3 py-2 text-right font-normal">Sessions</th><th className="py-2 pl-3 text-right font-normal">Tokens</th></tr>
            </thead>
            <tbody>
              {dashboard.models.length ? dashboard.models.map((model) => (
                <tr key={`${model.provider}:${model.model}`} className="border-b border-border/50 last:border-b-0">
                  <td className="max-w-[360px] truncate py-2 pr-3 font-mono text-[11px] text-foreground" title={model.model}>{model.model}</td>
                  <td className="px-3 py-2"><ProviderBadge provider={model.provider} availability={dashboard.providers.find((provider) => provider.provider === model.provider)?.availability} /></td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{formatNumber(model.sessions)}</td>
                  <td className="py-2 pl-3 text-right text-muted-foreground tabular-nums">{formatTokens(model.totalTokens)}</td>
                </tr>
              )) : <tr><td colSpan={4} className="py-6 text-center text-muted-foreground">Model metadata is not available.</td></tr>}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto border-y border-border">
          <table className="w-full min-w-[580px] text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr><th className="py-2 pr-3 font-normal">Day</th><th className="px-3 py-2 text-right font-normal">Sessions</th><th className="px-3 py-2 text-right font-normal">Turns</th><th className="px-3 py-2 text-right font-normal">Tool errors</th><th className="py-2 pl-3 text-right font-normal">Tokens</th></tr>
            </thead>
            <tbody>
              {recentDays.length ? recentDays.map((day) => (
                <tr key={day.date} className="border-b border-border/50 last:border-b-0">
                  <td className="py-2 pr-3 text-foreground">{formatDay(day.date)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{formatNumber(day.sessions)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{formatNumber(day.turns)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${day.toolErrors ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>{formatNumber(day.toolErrors)}</td>
                  <td className="py-2 pl-3 text-right text-muted-foreground tabular-nums">{formatTokens(day.totalTokens)}</td>
                </tr>
              )) : <tr><td colSpan={5} className="py-6 text-center text-muted-foreground">No activity in this window.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SessionTable({
  sessions,
  totalSessions,
  onOpen,
  providerAvailability,
}: {
  sessions: ProviderSessionRecord[];
  totalSessions: number;
  onOpen: (id: string) => void;
  providerAvailability: ReadonlyMap<string, ProviderAvailability>;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">Latest 100 sessions</h2>
        <span className="text-xs text-muted-foreground">Showing {formatNumber(sessions.length)} of {formatNumber(totalSessions)} matching sessions · open one for turn-level evidence</span>
      </div>
      <div className="overflow-x-auto border-y border-border">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr><th className="py-2 pr-3 font-normal">Session</th><th className="px-3 py-2 font-normal">Harness</th><th className="px-3 py-2 font-normal">Model</th><th className="px-3 py-2 text-right font-normal">Turns</th><th className="px-3 py-2 text-right font-normal">Tokens</th><th className="px-3 py-2 text-right font-normal">Cost</th><th className="px-3 py-2 text-right font-normal">Failures</th><th className="py-2 pl-3 font-normal">Updated</th></tr>
          </thead>
          <tbody>
            {sessions.length ? sessions.map((session) => (
              <tr key={session.id} className="border-b border-border/50 last:border-b-0 hover:bg-accent/45">
                <td className="max-w-[340px] py-2 pr-3">
                  <div className="block max-w-full">
                    <button
                      type="button"
                      id={`overview-session-${encodeURIComponent(session.id)}`}
                      onClick={() => onOpen(session.id)}
                      className="block max-w-full truncate text-left font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      title={`Open ${session.title}`}
                    >
                      {session.title}
                    </button>
                    <span className="block truncate text-[11px] text-muted-foreground">Provider session</span>
                  </div>
                </td>
                <td className="px-3 py-2"><ProviderBadge provider={session.provider} availability={providerAvailability.get(session.provider)} /></td>
                <td className="max-w-[170px] truncate px-3 py-2 font-mono text-[11px] text-muted-foreground" title={session.model ?? undefined}>{session.model ?? "—"}</td>
                <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{formatNumber(session.turnCount)}</td>
                <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{formatTokens(session.totalTokens)}</td>
                <td className="px-3 py-2 text-right text-muted-foreground tabular-nums" title={session.costEstimated ? "Fallback pricing — model not in the price table" : undefined}>{formatUsd(session.costUsd)}{session.costEstimated ? "*" : ""}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${session.failureCount || session.toolErrors ? "text-destructive" : "text-muted-foreground"}`}>{formatNumber(session.failureCount + session.toolErrors)}</td>
                <td className="whitespace-nowrap py-2 pl-3 text-muted-foreground">{timeAgo(session.updatedAt)}</td>
              </tr>
            )) : <tr><td colSpan={8} className="py-6 text-center text-muted-foreground">No sessions match these filters.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Dashboard() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const connection = useRealtimeConnectionState();
  const [input, setInput] = useState<DashboardInput>({ view: "provider", range: "7d" });
  const [dashboard, setDashboard] = useState<DashboardResult | null>(null);
  const [sources, setSources] = useState<SourceStatusRecord[]>([]);
  const [uncovered, setUncovered] = useState<Array<{ id: string; displayName: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [providerDiscoveryError, setProviderDiscoveryError] = useState<string | null>(null);
  const [providerDiscoveryState, setProviderDiscoveryState] = useState<"fresh" | "stale" | "unknown">("fresh");
  const [indexing, setIndexing] = useState<{ active: boolean; phase: string; provider: string | null; done: number; total: number } | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [firstLoad, setFirstLoad] = useState(true);
  const [loading, setLoading] = useState(false);
  const loadSeq = useRef(0);
  const previousConnection = useRef(connection);
  const [refreshToken, setRefreshToken] = useState(0);
  const [chartMetric, setChartMetric] = useState<ChartMetric>("tokens");
  const [breakdownMode, setBreakdownMode] = useState<BreakdownMode>("model");
  const providerAvailability = useMemo(
    () => new Map(sources.map((source) => [source.provider, source.availability] as const)),
    [sources],
  );

  useEffect(() => {
    if (!pendingOverviewFocusId) return;
    if (dashboard || (!firstLoad && !loading)) {
      requestAnimationFrame(restorePendingOverviewFocus);
    }
  }, [dashboard, firstLoad, loading]);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const response = await rpc.call("telemetryDashboard", compactDashboardInput(input));
      if (seq !== loadSeq.current) return;
      setDashboard(response.dashboard);
      setSources(response.sources);
      setUncovered(response.uncovered);
      setIndexing(response.indexing);
      setIndexError(response.error);
      setProviderDiscoveryError(response.providerDiscoveryError);
      setProviderDiscoveryState(response.providerDiscoveryState);
      setError(null);
    } catch (reason) {
      if (seq === loadSeq.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (seq === loadSeq.current) {
        setFirstLoad(false);
        setLoading(false);
      }
    }
  }, [input, rpc]);

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

  const updateInput = (next: Partial<DashboardInput>) => {
    setError(null);
    setInput((current) => compactDashboardInput({ ...current, ...next }));
  };
  const refresh = async () => {
    setBusy(true);
    try {
      await rpc.call("reindex", { providers: input.providers });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  if (firstLoad && !dashboard) {
    return (
      <div className="h-full min-h-0 overflow-y-auto">
        <div className={`${PANEL_CONTENT_CLASS} ${PANEL_GUTTER_CLASS} py-6 text-sm text-muted-foreground`}>Loading telemetry…</div>
      </div>
    );
  }
  return (
    <div className="h-full min-h-0 overflow-y-auto text-foreground" aria-busy={loading}>
      <div className={`${PANEL_CONTENT_CLASS} ${PANEL_GUTTER_CLASS} flex flex-col gap-8 py-6`}>
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold text-foreground">Telemetry</h1>
            <p className="text-sm text-muted-foreground">
              {dashboard ? dateRangeLabel(dashboard, dashboard.range) : ranges.find((option) => option.id === input.range)?.label}
              {dashboard && dashboard.range !== "lifetime" ? ` · ${formatNumber(dashboard.indexedSessions)} indexed lifetime` : ""}
              {dashboard?.stale ? " · data may be stale" : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl ariaLabel="Time range" options={ranges.map(({ id, short }) => ({ id, label: short }))} value={input.range} onChange={(range) => updateInput({ range })} />
            <button type="button" aria-label="Reindex selected sources" title="Rescan selected provider sessions" onClick={() => void refresh()} disabled={busy} className="rounded-md border border-border px-2.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-50">Reindex</button>
            <button type="button" aria-label="Refresh telemetry" title="Refresh telemetry" onClick={() => { setRefreshToken((value) => value + 1); }} className="rounded-md border border-border p-2 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"><RefreshIcon /></button>
          </div>
        </header>

        <SourceHealth sources={sources} indexedSessions={dashboard?.indexedSessions} uncovered={uncovered} />
        {indexing?.active ? <div role="status" aria-live="polite" className="motion-safe:animate-pulse motion-reduce:animate-none border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">Indexing {indexing.provider ?? "sources"} — {indexing.phase}{indexing.total ? ` · ${indexing.done} / ${indexing.total}` : ""}</div> : null}
        {indexError && !indexing?.active ? <div role="alert" className="border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">Last index failed: {indexError}</div> : null}
        {connection !== "connected" ? <div role="status" aria-live="polite" className="border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">Realtime connection is {connection}. Showing the last synced telemetry; refresh will reconcile durable data when it reconnects.</div> : null}
        {error ? <div role="alert" className="flex items-center justify-between gap-3 border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"><span>{error}</span><button type="button" onClick={() => void load()} className="rounded-md border border-destructive/30 px-2 py-1 text-xs hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">Retry</button></div> : null}
        {providerDiscoveryError && !error ? <div role="alert" className="border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">Provider discovery {providerDiscoveryState === "stale" ? "is using a stale catalog" : "is unavailable"}; provider availability is not confirmed. {providerDiscoveryError}</div> : null}
        {loading && dashboard ? <div role="status" aria-live="polite" className="border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">Refreshing telemetry… previous results are shown until the new request finishes loading.</div> : null}
        {loading && !dashboard ? <div role="status" aria-live="polite" className="border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">Loading telemetry for the selected filters…</div> : null}

        {dashboard ? <>
          <Toolbar input={input} sources={sources} busy={busy} onChange={updateInput} />

          <section className="grid gap-8 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
            <HeadlinePanel dashboard={dashboard} metric={chartMetric} />
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-medium text-foreground">{dashboard.range === "1h" || dashboard.range === "6h" || dashboard.range === "24h" ? "Hourly" : "Daily"} {metricLabel(chartMetric).toLowerCase()} <span className="font-normal text-muted-foreground">· {dashboard.range === "lifetime" ? "last 31 days shown" : `${ranges.find((option) => option.id === dashboard.range)?.label ?? dashboard.range} shown`}</span></h2>
                <SegmentedControl ariaLabel="Chart metric" options={chartMetricOptions} value={chartMetric} onChange={setChartMetric} />
              </div>
              <TelemetryChart dashboard={dashboard} metric={chartMetric} />
            </div>
          </section>

          <MetricsStrip dashboard={dashboard} />
          <FindingList findings={dashboard.findings} />
          <HarnessTable dashboard={dashboard} />
          <ToolsTable dashboard={dashboard} />
          <Breakdown dashboard={dashboard} mode={breakdownMode} onModeChange={setBreakdownMode} />
          <SessionTable
            sessions={dashboard.sessions}
            totalSessions={dashboard.totals.sessions}
            providerAvailability={providerAvailability}
            onOpen={(id) => {
              rememberOverviewFocus(id);
              navigate.toPluginPanel("sessions", { subPath: `trace/overview/${encodeURIComponent(id)}` });
            }}
          />
        </> : !error && !loading ? <div className="border-y border-border py-8 text-sm text-muted-foreground">No indexed data yet. Use Refresh to discover provider sessions.</div> : null}
      </div>
    </div>
  );
}

export default function TelemetryDashboardPage() {
  return <Dashboard />;
}
