import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  type PluginNavPanelProps,
  type PluginThreadPanelProps,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import type {
  DashboardInput,
  DashboardResult,
  FindingRecord,
  ProviderSessionRecord,
  SessionDetailResult,
  SourceStatusRecord,
} from "./src/types";
import { compactDashboardInput, reindexInput } from "./src/rpc-input";
import { PROVIDER_LABELS } from "./src/source-registry";
import type { rpcContract } from "./server";

type ChartMetric = "tokens" | "sessions" | "turns" | "errors";
type BreakdownMode = "model" | "day";

const providerColor: Record<string, string> = {
  codex: "#b8b8b8",
  claude: "#d97757",
  pi: "#a78bfa",
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
  return id === "other" ? "Other harnesses" : PROVIDER_LABELS[id as keyof typeof PROVIDER_LABELS] ?? id;
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

function ProviderBadge({ provider }: { provider: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${providerTone[provider] ?? providerTone.other}`}>
      <ProviderMark provider={provider} />
      {providerLabel(provider)}
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
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dateRangeLabel(dashboard: DashboardResult, range: DashboardInput["range"]): string {
  const first = dashboard.daily[0]?.date;
  const last = dashboard.daily[dashboard.daily.length - 1]?.date;
  if (first && last) return `${formatDay(first)} to ${formatDay(last)}`;
  return ranges.find((option) => option.id === range)?.label ?? range;
}

function statusTone(source: SourceStatusRecord): string {
  if (!source.enabled) return "text-muted-foreground";
  if (source.remoteDatabaseUnsupported || source.lastError) return "text-destructive";
  if (source.lastWarning) return "text-amber-700 dark:text-amber-300";
  if (source.detected) return "text-emerald-600 dark:text-emerald-400";
  return "text-muted-foreground";
}

function StatusDot({ source }: { source: SourceStatusRecord }) {
  return <span aria-hidden="true" className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-current align-middle ${statusTone(source)}`} />;
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
          className={`cursor-pointer px-2.5 py-1.5 text-[11px] transition-colors ${option.id === value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
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

function FindingList({ findings, onOpen }: { findings: FindingRecord[]; onOpen: (id: string) => void }) {
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
            {finding.scopeId && finding.scope === "session" ? (
              <button type="button" onClick={() => onOpen(finding.scopeId!)} className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-accent">
                Open session
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function SourceHealth({ sources }: { sources: SourceStatusRecord[] }) {
  if (!sources.length) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 border-y border-border py-2 text-xs">
      <span className="mr-1 text-muted-foreground">Sources</span>
      {sources.map((source) => (
        <span
          key={source.id}
          className={statusTone(source)}
          title={[source.pathLabel, `${source.storeKind} on ${source.hostId}`, source.lastSuccessAt ? `last scan ${new Date(source.lastSuccessAt).toLocaleString()}` : "never scanned", source.lastError ?? "", source.lastWarning ?? ""].filter(Boolean).join(" · ")}
        >
          <StatusDot source={source} />
          {source.label}
          <span className="ml-1 text-muted-foreground">
            {!source.enabled
              ? "disabled"
              : source.remoteDatabaseUnsupported
                ? "remote DB unsupported"
                : source.detected
                  ? `${source.count} records${source.lastWarning ? " · partial" : ""}`
                  : "not detected"}
          </span>
        </span>
      ))}
    </div>
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
          <select aria-label="View" value={input.view} onChange={(event) => onChange({ view: event.target.value as DashboardInput["view"] })} className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground">
            <option value="provider">By harness</option>
            <option value="unified">Unified</option>
            <option value="bb">bb threads</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>Harness</span>
          <select aria-label="Harness" value={selectedProvider} onChange={(event) => onChange({ providers: event.target.value === "all" ? undefined : [event.target.value as NonNullable<DashboardInput["providers"]>[number]] })} className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground">
            <option value="all">All harnesses</option>
            {availableProviders.map((provider) => <option key={provider} value={provider}>{providerLabel(provider)}</option>)}
          </select>
        </label>
        <label className="flex h-8 items-center gap-2 rounded-md border border-border px-2 text-xs text-muted-foreground">
          <input aria-label="Include archived" type="checkbox" checked={input.archived !== false} onChange={(event) => onChange({ archived: event.target.checked ? undefined : false })} />
          Include archived
        </label>
      </div>
      <span className="text-xs text-muted-foreground">{busy ? "Indexing sources…" : "Metrics are local to this view"}</span>
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
  const step = values.length === 1 ? 0 : width / (values.length - 1);
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
  const ticks = peak > 0 ? [peak, peak / 2, 0] : [0];
  const hasValues = peak > 0 && dashboard.daily.length > 0;

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
            <svg className="h-full w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Daily ${metricLabel(metric).toLowerCase()} by harness`}>
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
          {metric === "tokens" ? `Observed across ${formatNumber(dashboard.totals.sessions)} sessions.` : `Observed across ${formatNumber(dashboard.totals.sessions)} sessions and ${formatNumber(dashboard.totals.turns)} turns.`}
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
  const tokensPerTurn = totals.totalTokens != null && totals.turns > 0 ? totals.totalTokens / totals.turns : null;
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
      <Metric label="Processed tokens" value={formatTokens(dashboard.totals.totalTokens)} detail={`${formatTokens(metrics.tokensPerTurn)} per turn`} />
      <Metric label="Estimated cost" value={formatUsd(dashboard.totals.costUsd)} detail={costDetail} />
      <Metric label="Cache read share" value={formatPercent(metrics.cacheReadShare)} detail={cacheDetail} />
      <Metric label="Tool success" value={formatPercent(metrics.toolSuccess)} detail={`${formatNumber(dashboard.totals.toolCalls)} calls observed`} />
      <Metric label="Context peak" value={formatPercent(dashboard.totals.contextPeak)} detail={contextDetail} />
      <Metric label="Active sessions" value={formatNumber(dashboard.totals.active)} detail={`of ${formatNumber(dashboard.totals.sessions)} in view`} />
      <Metric label="Failed sessions" value={formatNumber(dashboard.totals.failed)} detail={dashboard.totals.failed ? "Needs review" : "No failed sessions"} />
    </section>
  );
}

function harnessStats(dashboard: DashboardResult, provider: DashboardResult["providers"][number]) {
  const rows = dashboard.sessions.filter((session) => session.provider === provider.provider);
  const durations = rows.map((row) => row.durationMs).filter((value): value is number => value != null && value >= 0);
  const contextPeaks = rows.map((row) => row.contextPeak).filter((value): value is number => value != null);
  return {
    turnsPerSession: provider.sessions > 0 ? provider.turns / provider.sessions : null,
    tokensPerTurn: provider.totalTokens != null && provider.turns > 0 ? provider.totalTokens / provider.turns : null,
    toolSuccess: provider.toolCalls > 0 ? 1 - provider.toolErrors / provider.toolCalls : null,
    contextPeak: contextPeaks.length ? Math.max(...contextPeaks) : null,
    averageDuration: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
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
              const stats = harnessStats(dashboard, provider);
              return (
                <tr key={provider.provider} className="border-b border-border/50 last:border-b-0">
                  <td className="py-2 pr-3"><ProviderBadge provider={provider.provider} /></td>
                  <td className="px-3 py-2 text-right text-foreground tabular-nums">{formatNumber(provider.sessions)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{stats.turnsPerSession == null ? "—" : stats.turnsPerSession.toFixed(1)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{formatTokens(stats.tokensPerTurn)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{formatNumber(provider.toolCalls)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${stats.toolSuccess != null && stats.toolSuccess < 0.9 ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>{formatPercent(stats.toolSuccess)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{formatPercent(stats.contextPeak)}</td>
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
        <h2 className="text-sm font-medium text-foreground">Tool breakdown</h2>
        <span className="text-xs text-muted-foreground">Calls, failures, and observed latency</span>
      </div>
      <div className="overflow-x-auto border-y border-border">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b border-border text-xs text-muted-foreground">
            <tr>
              <th className="py-2 pr-3 text-left font-normal">Harness</th>
              <th className="px-3 py-2 text-left font-normal">Tool</th>
              <th className="px-3 py-2 text-right font-normal">Calls</th>
              <th className="px-3 py-2 text-right font-normal">Failed</th>
              <th className="px-3 py-2 text-right font-normal">Failure rate</th>
              <th className="px-3 py-2 text-right font-normal">P50</th>
              <th className="py-2 pl-3 text-right font-normal">P95</th>
            </tr>
          </thead>
          <tbody>
            {dashboard.tools.length ? dashboard.tools.map((tool) => (
              <tr key={`${tool.provider}:${tool.name}`} className="border-b border-border/50 last:border-b-0">
                <td className="py-2 pr-3"><ProviderBadge provider={tool.provider} /></td>
                <td className="max-w-[300px] truncate px-3 py-2 font-mono text-[11px] text-foreground" title={tool.name}>{tool.name}</td>
                <td className="px-3 py-2 text-right text-foreground tabular-nums">{formatNumber(tool.calls)}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${tool.failures ? "text-destructive" : "text-muted-foreground"}`}>{formatNumber(tool.failures)}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${tool.failureRate != null && tool.failureRate >= 0.25 ? "text-destructive" : "text-muted-foreground"}`}>{formatPercent(tool.failureRate)}</td>
                <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{formatDuration(tool.p50LatencyMs)}</td>
                <td className="py-2 pl-3 text-right text-muted-foreground tabular-nums">{formatDuration(tool.p95LatencyMs)}</td>
              </tr>
            )) : <tr><td colSpan={7} className="py-6 text-center text-muted-foreground">No structured tool events are available.</td></tr>}
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
                  <td className="px-3 py-2"><ProviderBadge provider={model.provider} /></td>
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

function SessionTable({ sessions, onOpen }: { sessions: ProviderSessionRecord[]; onOpen: (id: string) => void }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">Sessions</h2>
        <span className="text-xs text-muted-foreground">Open a row for turn-level evidence</span>
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
                  <button type="button" onClick={() => onOpen(session.id)} className="block max-w-full text-left">
                    <span className="block truncate font-medium text-foreground" title={session.title}>{session.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{session.linkState === "linked" ? "Linked to a bb thread" : session.linkState === "suggested" ? "Possible bb link" : session.source === "bb" ? "Native bb thread" : "Provider session"}</span>
                  </button>
                </td>
                <td className="px-3 py-2"><ProviderBadge provider={session.provider} /></td>
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

function Dashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [input, setInput] = useState<DashboardInput>({ view: "provider", range: "7d" });
  const [dashboard, setDashboard] = useState<DashboardResult | null>(null);
  const [sources, setSources] = useState<SourceStatusRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [firstLoad, setFirstLoad] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const [chartMetric, setChartMetric] = useState<ChartMetric>("tokens");
  const [breakdownMode, setBreakdownMode] = useState<BreakdownMode>("model");

  const load = useCallback(async () => {
    try {
      const status = await rpc.call("status", null);
      const nextInput = firstLoad
        ? compactDashboardInput({ ...input, view: status.defaultView, range: status.defaultRange })
        : input;
      if (nextInput.view !== input.view || nextInput.range !== input.range) setInput(nextInput);
      const nextDashboard = await rpc.call("dashboard", compactDashboardInput(nextInput));
      setDashboard(nextDashboard);
      setSources(status.sources);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setFirstLoad(false);
    }
  }, [firstLoad, input, rpc]);

  useRealtime("telemetry-index", () => setRefreshToken((value) => value + 1));
  useEffect(() => { void load(); }, [load, refreshToken]);
  useEffect(() => { if (connection === "connected") void load(); }, [connection, load]);

  const updateInput = (next: Partial<DashboardInput>) => setInput((current) => compactDashboardInput({ ...current, ...next }));
  const refresh = async () => {
    setBusy(true);
    try {
      await rpc.call("reindex", reindexInput(input));
      setRefreshToken((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const clearAndRescan = async () => {
    if (!window.confirm("Clear all indexed telemetry and rescan every provider store and bb thread?")) return;
    setBusy(true);
    try {
      await rpc.call("reindex", { clear: true });
      setRefreshToken((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (firstLoad && !dashboard) return <div className="h-full min-h-0 overflow-y-auto p-5 text-sm text-muted-foreground">Loading telemetry…</div>;
  return (
    <div className="h-full min-h-0 overflow-y-auto text-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-6 md:px-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold text-foreground">Telemetry</h1>
            <p className="text-sm text-muted-foreground">{dashboard ? dateRangeLabel(dashboard, input.range) : ranges.find((option) => option.id === input.range)?.label}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl ariaLabel="Time range" options={ranges.map(({ id, short }) => ({ id, label: short }))} value={input.range} onChange={(range) => updateInput({ range })} />
            <button type="button" aria-label="Clear and rescan" title="Clear all indexed telemetry and rescan from scratch" onClick={() => void clearAndRescan()} disabled={busy} className="rounded-md border border-destructive/40 px-2.5 py-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-wait disabled:opacity-50">Clear &amp; rescan</button>
            <button type="button" aria-label="Refresh" title="Refresh telemetry" onClick={() => void refresh()} disabled={busy} className="rounded-md border border-border p-2 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-wait disabled:opacity-50"><RefreshIcon /></button>
          </div>
        </header>

        <SourceHealth sources={sources} />
        {connection === "reconnecting" ? <div className="border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">Realtime connection is reconnecting. Refresh will reconcile durable data.</div> : null}
        {error ? <div className="flex items-center justify-between gap-3 border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"><span>{error}</span><button type="button" onClick={() => void load()} className="rounded-md border border-destructive/30 px-2 py-1 text-xs hover:bg-destructive/10">Retry</button></div> : null}

        {dashboard ? <>
          <Toolbar input={input} sources={sources} busy={busy} onChange={updateInput} />

          <section className="grid gap-8 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
            <HeadlinePanel dashboard={dashboard} metric={chartMetric} />
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-medium text-foreground">Daily {metricLabel(chartMetric).toLowerCase()}</h2>
                <SegmentedControl ariaLabel="Chart metric" options={chartMetricOptions} value={chartMetric} onChange={setChartMetric} />
              </div>
              <TelemetryChart dashboard={dashboard} metric={chartMetric} />
            </div>
          </section>

          <MetricsStrip dashboard={dashboard} />
          <FindingList findings={dashboard.findings} onOpen={onOpen} />
          <HarnessTable dashboard={dashboard} />
          <ToolsTable dashboard={dashboard} />
          <Breakdown dashboard={dashboard} mode={breakdownMode} onModeChange={setBreakdownMode} />
          <SessionTable sessions={dashboard.sessions} onOpen={onOpen} />
        </> : <div className="border-y border-border py-8 text-sm text-muted-foreground">No indexed data yet. Use Refresh to discover provider sessions and bb threads.</div>}
      </div>
    </div>
  );
}

function DetailValue({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="min-w-0"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div><div className={`mt-1 truncate text-sm ${mono ? "font-mono" : ""}`} title={value}>{value}</div></div>;
}

function SessionDetail({ sourceRecordId, onBack }: { sourceRecordId: string; onBack: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [detail, setDetail] = useState<SessionDetailResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDetail(null);
    setError(null);
    const request = sourceRecordId.startsWith("bb:")
      ? rpc.call("threadDetail", { threadId: sourceRecordId.slice(3) })
      : rpc.call("sessionDetail", { sourceRecordId });
    void request.then(setDetail).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [rpc, sourceRecordId]);
  if (error) return <div className="h-full min-h-0 overflow-y-auto p-5"><button type="button" onClick={onBack} className="mb-4 text-sm text-muted-foreground hover:text-foreground">← Back to telemetry</button><div className="border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">{error}</div></div>;
  if (!detail) return <div className="h-full min-h-0 overflow-y-auto p-5 text-sm text-muted-foreground">Loading session…</div>;
  const session = detail.session;
  const anyEstimatedCost = (detail.cost?.estimated ?? false) || detail.turns.some((turn) => turn.costEstimated);
  return (
    <div className="h-full min-h-0 overflow-y-auto text-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-5 py-6 md:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
          <div>
            <button type="button" onClick={onBack} className="mb-2 text-xs text-muted-foreground hover:text-foreground">← Back to telemetry</button>
            <h1 className="max-w-2xl text-lg font-semibold">{session.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2"><ProviderBadge provider={session.provider} /><span className="text-xs text-muted-foreground">{session.source} · {session.status}</span>{session.linkState !== "none" ? <span className="text-xs text-muted-foreground">· {session.linkState} bb link</span> : null}</div>
          </div>
          {session.bbThreadId ? <button type="button" onClick={() => navigate.toThread(session.bbThreadId!)} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent">Open thread</button> : null}
        </div>
        <div className="grid gap-3 border-y border-border py-3 sm:grid-cols-2 lg:grid-cols-4"><DetailValue label="Host" value={session.hostId} /><DetailValue label="Store" value={session.storeLabel} /><DetailValue label="Model" value={session.model ?? "Not available"} mono /><DetailValue label="Updated" value={session.updatedAt ? new Date(session.updatedAt).toLocaleString() : "Not available"} /><DetailValue label="Provider session ID" value={session.providerSessionId ?? "Not available"} mono /><DetailValue label="Turns" value={formatNumber(session.turnCount)} /><DetailValue label="Tools" value={`${formatNumber(session.toolCalls)} · ${formatNumber(session.toolErrors)} errors`} /><DetailValue label="Tokens" value={formatTokens(session.totalTokens)} /><DetailValue label="Cost" value={`${formatUsd(session.costUsd)}${session.costEstimated ? "*" : ""}`} /></div>
        <section className="flex flex-col gap-2"><h2 className="text-sm font-medium">Coverage</h2><div className="flex flex-wrap gap-2 border-y border-border py-3">{Object.entries(session.coverage).map(([name, level]) => <span key={name} className={`rounded-md border px-2 py-1 text-xs ${level === "complete" ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300" : level === "partial" ? "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300" : "border-border text-muted-foreground"}`}>{name}: {level}</span>)}</div></section>
        {detail.findings.length ? <FindingList findings={detail.findings} onOpen={() => undefined} /> : null}
        <section className="flex flex-col gap-2"><h2 className="text-sm font-medium">Turn summary</h2><div className="overflow-x-auto border-y border-border"><table className="w-full min-w-[600px] text-sm"><thead className="border-b border-border text-left text-xs text-muted-foreground"><tr><th className="py-2 pr-3 font-normal">Turn</th><th className="px-3 py-2 font-normal">Status</th><th className="px-3 py-2 text-right font-normal">Steps</th><th className="px-3 py-2 text-right font-normal">Tools</th><th className="px-3 py-2 text-right font-normal">Tokens</th><th className="px-3 py-2 text-right font-normal">Cost</th><th className="py-2 pl-3 text-right font-normal">Duration</th></tr></thead><tbody>{detail.turns.length ? detail.turns.map((turn) => <tr key={turn.id} className="border-b border-border/50 last:border-b-0"><td className="py-2 pr-3 font-mono text-[11px]">{turn.id}</td><td className="px-3 py-2">{turn.status}</td><td className="px-3 py-2 text-right tabular-nums">{formatNumber(turn.steps)}</td><td className="px-3 py-2 text-right tabular-nums">{formatNumber(turn.toolCalls)}{turn.toolErrors ? ` · ${turn.toolErrors} errors` : ""}</td><td className="px-3 py-2 text-right tabular-nums">{formatTokens(turn.totalTokens)}</td><td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{formatUsd(turn.costUsd)}</td><td className="py-2 pl-3 text-right tabular-nums text-muted-foreground">{formatDuration(turn.durationMs)}</td></tr>) : <tr><td colSpan={7} className="py-4 text-muted-foreground">No structured turn events are available.</td></tr>}</tbody></table></div></section>
        <section className="flex flex-col gap-2"><h2 className="text-sm font-medium">Evidence</h2><div className="border-y border-border">{detail.evidence.slice(0, 80).map((evidence) => <div key={`${evidence.source}:${evidence.sourceSequence}:${evidence.eventType}`} className="flex flex-wrap gap-x-3 gap-y-1 border-b border-border/50 py-2 text-xs last:border-b-0"><span className="text-muted-foreground">{evidence.source}</span><span className="font-mono">{evidence.eventType}</span><span className="text-muted-foreground">seq {evidence.sourceSequence ?? "—"}</span><span className="text-muted-foreground">{evidence.at ? new Date(evidence.at).toLocaleTimeString() : "—"}</span></div>)}</div></section>
        {detail.cost ? (
          <div className="border border-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
            Estimated cost: <span className="font-medium text-foreground">{formatUsd(detail.cost.totalUsd)}</span> · {formatNumber(detail.cost.pricedTokens)} tokens priced ·{" "}
            {detail.cost.estimated ? (
              <>fallback {session.provider} pricing for <span className="font-mono">{session.model ?? "unknown model"}</span> — set the telemetry <span className="font-mono">priceTable</span> setting for verified prices</>
            ) : (
              <>priced from the price table{detail.cost.model ? <> for <span className="font-mono">{detail.cost.model}</span></> : null}</>
            )}
          </div>
        ) : (
          <div className="border border-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">Cost is not available — no token usage was recorded for this session.</div>
        )}
        {anyEstimatedCost ? <div className="text-[11px] text-muted-foreground">* fallback price used; see <span className="font-mono">bb telemetry prices</span> for the effective table.</div> : null}
      </div>
    </div>
  );
}

function TelemetryPanel({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  // bb's panel route encodes each subPath segment and passes the splat back
  // raw (matchPath does not decode), so decode exactly once here. Do NOT
  // encode on the way out — getPluginPanelRoutePath already encodes.
  let detailId: string | null = null;
  if (subPath.startsWith("session/")) {
    try {
      detailId = decodeURIComponent(subPath.slice("session/".length));
    } catch {
      detailId = null;
    }
  }
  if (detailId) return <SessionDetail sourceRecordId={detailId} onBack={() => navigate.toPluginPanel("telemetry")} />;
  return <Dashboard onOpen={(id) => navigate.toPluginPanel("telemetry", { subPath: `session/${id}` })} />;
}

function ThreadTelemetryPanel({ threadId }: PluginThreadPanelProps) {
  const navigate = useBbNavigate();
  return <SessionDetail sourceRecordId={`bb:${threadId}`} onBack={() => navigate.toPluginPanel("telemetry")} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "telemetry",
    title: "Telemetry",
    icon: "Activity",
    path: "telemetry",
    component: TelemetryPanel,
  });
  app.slots.threadPanelAction({
    id: "analyze-thread",
    title: "Analyze thread",
    icon: "Activity",
    layout: "flush",
    run: async ({ openPanel }) => openPanel({ title: "Thread telemetry" }),
    component: ThreadTelemetryPanel,
  });
});
