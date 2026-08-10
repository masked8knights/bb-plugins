import { PROVIDER_LABELS, PROVIDER_SOURCES } from "./source-registry";
import { RANGE_MS } from "./types";
import { sessionCost, withSessionCost } from "./pricing";
import type {
  DashboardInput,
  DashboardResult,
  DashboardTotals,
  FindingRecord,
  NormalizedItem,
  PriceOverrides,
  ProviderSessionRecord,
  ProviderSummary,
  SourceStatusRecord,
} from "./types";

function rangeStart(range: DashboardInput["range"], now: number): number | null {
  return range === "lifetime" ? null : now - RANGE_MS[range];
}

function inRange(session: ProviderSessionRecord, start: number | null): boolean {
  return start === null || (session.updatedAt ?? session.startedAt ?? 0) >= start;
}

function sumNullable(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
}

function coverageFor(provider: ProviderSessionRecord["provider"], sources: SourceStatusRecord[]) {
  const rows = sources.filter((source) => source.provider === provider);
  return rows[0]?.capabilities ?? {
    metadata: "unavailable",
    turns: "unavailable",
    tools: "unavailable",
    tokens: "unavailable",
    context: "unavailable",
    errors: "unavailable",
    latency: "unavailable",
    models: "unavailable",
  };
}

function providerLabel(provider: ProviderSessionRecord["provider"]): string {
  if (provider === "other") return "Other providers";
  return PROVIDER_LABELS[provider] ?? provider;
}

function sessionFilter(
  sessions: ProviderSessionRecord[],
  input: DashboardInput,
  now: number,
): ProviderSessionRecord[] {
  const start = rangeStart(input.range, now);
  const acceptedLinks = new Set(
    sessions
      .filter((session) => session.source === "provider" && session.linkState === "linked" && session.bbThreadId)
      .map((session) => `bb:${session.bbThreadId}`),
  );
  return sessions.filter((session) => {
    if (!inRange(session, start)) return false;
    if (input.view === "provider" && session.source !== "provider") return false;
    if (input.view === "bb" && session.source !== "bb") return false;
    if (input.view === "unified" && session.source === "bb" && acceptedLinks.has(session.id)) return false;
    if (input.providers?.length && !input.providers.includes(session.provider as never)) return false;
    if (input.source && session.source !== input.source) return false;
    if (input.hostId && session.hostId !== input.hostId) return false;
    if (input.projectId && session.projectId !== input.projectId) return false;
    if (input.model && session.model !== input.model) return false;
    if (input.archived !== undefined && session.archived !== input.archived) return false;
    return true;
  });
}

function sumCosts(sessions: ProviderSessionRecord[], overrides: PriceOverrides) {
  let costUsd = 0;
  let anyPriced = false;
  let anyEstimated = false;
  for (const session of sessions) {
    const cost = sessionCost(session, overrides);
    if (!cost) continue;
    costUsd += cost.totalUsd;
    anyPriced = true;
    anyEstimated ||= cost.estimated;
  }
  return { costUsd: anyPriced ? costUsd : null, costEstimated: anyEstimated };
}

function totalsFor(sessions: ProviderSessionRecord[], overrides: PriceOverrides): DashboardTotals {
  const cost = sumCosts(sessions, overrides);
  return {
    sessions: sessions.length,
    active: sessions.filter((session) => session.status === "active").length,
    failed: sessions.filter((session) => session.status === "failed" || session.failureCount > 0).length,
    turns: sessions.reduce((total, session) => total + session.turnCount, 0),
    messages: sessions.reduce((total, session) => total + session.messageCount, 0),
    toolCalls: sessions.reduce((total, session) => total + session.toolCalls, 0),
    toolErrors: sessions.reduce((total, session) => total + session.toolErrors, 0),
    inputTokens: sumNullable(sessions.map((session) => session.inputTokens)),
    cachedInputTokens: sumNullable(sessions.map((session) => session.cachedInputTokens)),
    outputTokens: sumNullable(sessions.map((session) => session.outputTokens)),
    reasoningTokens: sumNullable(sessions.map((session) => session.reasoningTokens)),
    totalTokens: sumNullable(sessions.map((session) => session.totalTokens)),
    costUsd: cost.costUsd,
    costEstimated: cost.costEstimated,
    contextPeak: Math.max(...sessions.map((session) => session.contextPeak).filter((value): value is number => typeof value === "number"), 0) || null,
    compactions: sessions.reduce((total, session) => total + session.compactionCount, 0),
    sampleSize: sessions.length,
  };
}

function providerSummaries(
  sessions: ProviderSessionRecord[],
  sources: SourceStatusRecord[],
  overrides: PriceOverrides,
): ProviderSummary[] {
  const providerIds = new Set<ProviderSessionRecord["provider"]>([
    ...PROVIDER_SOURCES.map((source) => source.id),
    ...sessions.map((session) => session.provider),
  ]);
  return [...providerIds].map((provider) => {
    const rows = sessions.filter((session) => session.provider === provider);
    const cost = sumCosts(rows, overrides);
    return {
      provider,
      label: providerLabel(provider),
      sessions: rows.length,
      active: rows.filter((session) => session.status === "active").length,
      failed: rows.filter((session) => session.status === "failed" || session.failureCount > 0).length,
      turns: rows.reduce((total, session) => total + session.turnCount, 0),
      messages: rows.reduce((total, session) => total + session.messageCount, 0),
      toolCalls: rows.reduce((total, session) => total + session.toolCalls, 0),
      toolErrors: rows.reduce((total, session) => total + session.toolErrors, 0),
      inputTokens: sumNullable(rows.map((session) => session.inputTokens)),
      outputTokens: sumNullable(rows.map((session) => session.outputTokens)),
      totalTokens: sumNullable(rows.map((session) => session.totalTokens)),
      costUsd: cost.costUsd,
      costEstimated: cost.costEstimated,
      contextIssues: rows.filter((session) => (session.contextPeak ?? 0) >= 0.85 || session.compactionCount > 0).length,
      lastActivityAt: rows.reduce<number | null>((latest, session) => Math.max(latest ?? 0, session.updatedAt ?? 0) || latest, null),
      sampleSize: rows.length,
      coverage: coverageFor(provider, sources),
    } satisfies ProviderSummary;
  }).sort((a, b) => b.sessions - a.sessions || a.label.localeCompare(b.label));
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Math.round(sorted[index]);
}

function toolSummary(items: NormalizedItem[], sessions: ProviderSessionRecord[]) {
  const grouped = new Map<string, { provider: ProviderSessionRecord["provider"]; rows: NormalizedItem[] }>();
  const providerBySession = new Map(sessions.map((session) => [session.id, session.provider]));
  for (const item of items) {
    const name = item.toolName ?? item.kind;
    const provider = item.sessionId ? providerBySession.get(item.sessionId) ?? "other" : "other";
    const key = `${provider}:${name}`;
    const current = grouped.get(key) ?? { provider, rows: [] };
    current.rows.push(item);
    grouped.set(key, current);
  }
  return [...grouped.entries()].map(([key, group]) => {
    const name = key.slice(key.indexOf(":") + 1);
    const rows = group.rows;
    const failures = rows.filter((row) => row.status === "failed" || row.errorCategory).length;
    return {
      provider: group.provider,
      name,
      calls: rows.length,
      failures,
      failureRate: rows.length ? failures / rows.length : null,
      p50LatencyMs: percentile(rows.map((row) => row.durationMs).filter((value): value is number => value !== null), 0.5),
      p95LatencyMs: percentile(rows.map((row) => row.durationMs).filter((value): value is number => value !== null), 0.95),
    };
  }).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)).slice(0, 40);
}

function dailySummary(sessions: ProviderSessionRecord[]): DashboardResult["daily"] {
  const grouped = new Map<string, {
    sessions: number;
    turns: number;
    toolErrors: number;
    totalTokens: number;
    knownTokens: boolean;
    byProvider: Map<string, {
      sessions: number;
      turns: number;
      toolErrors: number;
      totalTokens: number;
      knownTokens: boolean;
    }>;
  }>();
  for (const session of sessions) {
    const date = new Date(session.updatedAt ?? session.startedAt ?? Date.now()).toISOString().slice(0, 10);
    const current = grouped.get(date) ?? {
      sessions: 0,
      turns: 0,
      toolErrors: 0,
      totalTokens: 0,
      knownTokens: false,
      byProvider: new Map(),
    };
    current.sessions += 1;
    current.turns += session.turnCount;
    current.toolErrors += session.toolErrors;
    if (session.totalTokens !== null) {
      current.totalTokens += session.totalTokens;
      current.knownTokens = true;
    }
    const provider = current.byProvider.get(session.provider) ?? {
      sessions: 0,
      turns: 0,
      toolErrors: 0,
      totalTokens: 0,
      knownTokens: false,
    };
    provider.sessions += 1;
    provider.turns += session.turnCount;
    provider.toolErrors += session.toolErrors;
    if (session.totalTokens !== null) {
      provider.totalTokens += session.totalTokens;
      provider.knownTokens = true;
    }
    current.byProvider.set(session.provider, provider);
    grouped.set(date, current);
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-31).map(([date, values]) => ({
    date,
    sessions: values.sessions,
    turns: values.turns,
    toolErrors: values.toolErrors,
    totalTokens: values.knownTokens ? values.totalTokens : null,
    byProvider: Object.fromEntries([...values.byProvider.entries()].map(([provider, summary]) => [provider, {
      sessions: summary.sessions,
      turns: summary.turns,
      toolErrors: summary.toolErrors,
      totalTokens: summary.knownTokens ? summary.totalTokens : null,
    }])),
  }));
}

function modelSummary(sessions: ProviderSessionRecord[]): DashboardResult["models"] {
  const grouped = new Map<string, ProviderSessionRecord[]>();
  for (const session of sessions) {
    if (!session.model) continue;
    const key = `${session.provider}:${session.model}`;
    const rows = grouped.get(key) ?? [];
    rows.push(session);
    grouped.set(key, rows);
  }
  return [...grouped.entries()].map(([key, rows]) => ({
    provider: rows[0].provider,
    model: key.slice(key.indexOf(":") + 1),
    sessions: rows.length,
    totalTokens: sumNullable(rows.map((row) => row.totalTokens)),
  })).sort((a, b) => b.sessions - a.sessions).slice(0, 30);
}

export function buildDashboard(
  allSessions: ProviderSessionRecord[],
  allItems: NormalizedItem[],
  findings: FindingRecord[],
  sources: SourceStatusRecord[],
  input: DashboardInput,
  now = Date.now(),
  overrides: PriceOverrides = {},
): DashboardResult {
  const sessions = sessionFilter(allSessions, input, now);
  const ids = new Set(sessions.map((session) => session.id));
  const sessionItems = allItems.filter((item) => item.sessionId && ids.has(item.sessionId));
  const providerFindings = findings.filter((finding) =>
    sessions.some((session) => session.provider === finding.provider) || finding.scope === "range",
  ).slice(0, 40);
  return {
    view: input.view,
    range: input.range,
    generatedAt: now,
    stale: false,
    totals: totalsFor(sessions, overrides),
    providers: providerSummaries(sessions, sources, overrides),
    findings: providerFindings,
    sessions: sessions.slice(0, 100).map((session) => withSessionCost(session, overrides)),
    tools: toolSummary(sessionItems, sessions),
    daily: dailySummary(sessions),
    models: modelSummary(sessions),
    coverage: sources.flatMap((source) => (Object.entries(source.capabilities) as Array<[DashboardResult["coverage"][number]["capability"], DashboardResult["coverage"][number]["level"]]>).map(([capability, level]) => ({
      provider: source.provider,
      capability,
      level,
      note: level === "complete" ? `${source.label} reports this metric.` : level === "partial" ? `${source.label} reports this metric for some records.` : `${source.label} does not report this metric.`,
    }))).slice(0, 120),
  };
}

export { rangeStart, sessionFilter };
