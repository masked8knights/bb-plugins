import { PROVIDER_LABELS } from "./source-registry";
import type {
  FindingRecord,
  NormalizedItem,
  ProviderSessionRecord,
  SourceStatusRecord,
} from "./types";

function findingId(ruleId: string, scope: string, scopeId: string | null): string {
  return `${ruleId}:${scope}:${scopeId ?? "range"}`;
}

function sourceDescription(sessions: ProviderSessionRecord[]): string {
  const hasProvider = sessions.some((session) => session.source === "provider");
  const hasBb = sessions.some((session) => session.source === "bb");
  if (hasProvider && hasBb) return "provider and bb telemetry";
  if (hasBb) return "bb telemetry";
  return "provider telemetry";
}

function baseFinding(
  ruleId: string,
  severity: FindingRecord["severity"],
  source: FindingRecord["source"],
  provider: FindingRecord["provider"],
  scope: FindingRecord["scope"],
  scopeId: string | null,
  title: string,
  summary: string,
  recommendation: string,
  metricValue: number | null,
  threshold: number | null,
  sampleSize: number,
  coverageNote: string,
  evidence: FindingRecord["evidence"],
  createdAt: number,
): FindingRecord {
  return {
    id: findingId(ruleId, scope, scopeId),
    ruleId,
    severity,
    source,
    provider,
    scope,
    scopeId,
    title,
    summary,
    recommendation,
    metricValue,
    threshold,
    sampleSize,
    coverageNote,
    evidence,
    createdAt,
  };
}

export function analyzeFindings(
  sessions: ProviderSessionRecord[],
  items: NormalizedItem[],
  sources: SourceStatusRecord[],
  now = Date.now(),
): FindingRecord[] {
  const findings: FindingRecord[] = [];
  const providerIds = [...new Set(sessions.map((session) => session.provider))];
  for (const provider of providerIds) {
    const rows = sessions.filter((session) => session.provider === provider);
    if (!rows.length) continue;
    const failures = rows.reduce((total, row) => total + row.failureCount, 0);
    const toolCalls = rows.reduce((total, row) => total + row.toolCalls, 0);
    const toolErrors = rows.reduce((total, row) => total + row.toolErrors, 0);
    const sourceLabel = sourceDescription(rows);
    if (failures > 0) {
      findings.push(baseFinding(
        "provider-reliability",
        failures / rows.length >= 0.5 ? "critical" : "warning",
        rows[0].source,
        provider,
        "provider",
        provider,
        `${PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS] ?? provider} telemetry reports failures`,
        `${failures} failure${failures === 1 ? "" : "s"} appeared across ${rows.length} indexed session${rows.length === 1 ? "" : "s"} in ${sourceLabel}.`,
        "Open the affected sessions and compare the error categories before changing provider settings.",
        failures,
        1,
        rows.length,
        `Error events are available from ${sourceLabel} for this sample.`,
        rows.flatMap((row) => [{ source: row.source, sourceRecordId: row.id, sourceSequence: null, eventType: "provider-error", at: row.updatedAt }]).slice(0, 8),
        now,
      ));
    }
    if (toolCalls >= 5 && toolErrors / toolCalls >= 0.25) {
      findings.push(baseFinding(
        "tool-reliability",
        toolErrors / toolCalls >= 0.5 ? "critical" : "warning",
        rows[0].source,
        provider,
        "provider",
        provider,
        `${PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS] ?? provider} telemetry tool failures are elevated`,
        `${toolErrors} of ${toolCalls} indexed tool calls failed (${Math.round((toolErrors / toolCalls) * 100)}%).`,
        "Inspect the tool breakdown below. Repeated failures in one tool are stronger evidence than the aggregate rate.",
        toolErrors / toolCalls,
        0.25,
        toolCalls,
        "Tool events include structured status values.",
        rows.slice(0, 8).map((row) => ({ source: row.source, sourceRecordId: row.id, sourceSequence: null, eventType: "tool-failure", at: row.updatedAt })),
        now,
      ));
    }
    const contextRows = rows.filter((row) => row.contextPeak !== null);
    const highContext = contextRows.filter((row) => (row.contextPeak ?? 0) >= 0.85);
    if (highContext.length) {
      findings.push(baseFinding(
        "context-pressure",
        highContext.some((row) => row.compactionCount > 0) ? "critical" : "warning",
        rows[0].source,
        provider,
        "provider",
        provider,
        `${PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS] ?? provider} telemetry reaches high context pressure`,
        `${highContext.length} of ${contextRows.length} sessions reached at least 85% of the known context window.`,
        "Compare compaction and turn length in the session drilldown before changing context limits.",
        highContext.length / contextRows.length,
        0.85,
        contextRows.length,
        "Context values are shown only when the source reports a limit or utilization value.",
        highContext.slice(0, 8).map((row) => ({ source: row.source, sourceRecordId: row.id, sourceSequence: null, eventType: "context-pressure", at: row.updatedAt })),
        now,
      ));
    }
    const source = sources.find((candidate) => candidate.provider === provider);
    if (source && source.capabilities.tokens === "unavailable" && rows.length >= 3) {
      findings.push(baseFinding(
        "coverage-gap",
        "info",
        "provider",
        provider,
        "provider",
        provider,
        `${PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS] ?? provider} token data is unavailable`,
        "This provider cannot be compared on token volume from the current source.",
        "Treat token comparisons as unavailable. Do not read missing values as zero.",
        null,
        null,
        rows.length,
        "Token coverage is unavailable from the detected provider store.",
        [],
        now,
      ));
    }
  }

  const byTool = new Map<string, NormalizedItem[]>();
  for (const item of items) {
    const name = item.toolName ?? item.kind;
    const list = byTool.get(name) ?? [];
    list.push(item);
    byTool.set(name, list);
  }
  for (const [name, toolItems] of byTool) {
    const failures = toolItems.filter((item) => item.status === "failed" || item.errorCategory).length;
    if (toolItems.length < 5 || failures / toolItems.length < 0.5) continue;
    const firstSession = sessions.find((session) => toolItems.some((item) => item.sessionId === session.id));
    findings.push(baseFinding(
      "repeated-tool-failure",
      "warning",
      firstSession?.source ?? "provider",
      firstSession?.provider ?? "codex",
      "tool",
      name,
      `${name} fails repeatedly`,
      `${failures} of ${toolItems.length} indexed calls failed.`,
      "Inspect the failure trajectory by session. A repeated error category often points to a provider or permission issue.",
      failures / toolItems.length,
      0.5,
      toolItems.length,
      "Tool failure evidence is available from structured events.",
      [],
      now,
    ));
  }

  return findings.sort((a, b) => {
    const severity = { critical: 3, warning: 2, info: 1 };
    return severity[b.severity] - severity[a.severity] || b.createdAt - a.createdAt;
  });
}
