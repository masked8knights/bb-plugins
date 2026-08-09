import {
  emptyCapabilities,
  type CapabilityReport,
  type ProviderId,
  type AnalyticsProviderId,
  type ProviderSourceDescriptor,
  type SourceSettings,
} from "./types";

export const PROVIDER_SOURCES: ProviderSourceDescriptor[] = [
  {
    id: "codex",
    label: "Codex",
    bbProviderIds: ["codex"],
    storeKind: "jsonl",
    defaultPath: "~/.codex/sessions",
    archivePath: "~/.codex/archived_sessions",
  },
  {
    id: "claude",
    label: "Claude Code",
    bbProviderIds: ["claude-code"],
    storeKind: "jsonl",
    defaultPath: "~/.claude/projects",
  },
  {
    id: "prime",
    label: "Pi / Prime Agent",
    bbProviderIds: ["pi", "acp-prime-agent", "acp-hermes-agent"],
    storeKind: "jsonl",
    defaultPath: "~/.prime/agent/sessions",
    defaultDbPath: "~/.hermes/state.db",
  },
  {
    id: "opencode",
    label: "opencode",
    bbProviderIds: ["acp-opencode"],
    storeKind: "sqlite",
    defaultPath: "~/.local/share/opencode/opencode.db",
  },
  {
    id: "omp",
    label: "omp",
    bbProviderIds: ["acp-omp"],
    storeKind: "jsonl",
    defaultPath: "~/.omp/agent/sessions",
  },
];

export const PROVIDER_LABELS: Record<ProviderId, string> = Object.fromEntries(
  PROVIDER_SOURCES.map((source) => [source.id, source.label]),
) as Record<ProviderId, string>;

export function getSource(provider: ProviderId): ProviderSourceDescriptor {
  return PROVIDER_SOURCES.find((source) => source.id === provider)!;
}

export function isProviderId(value: string): value is ProviderId {
  return PROVIDER_SOURCES.some((source) => source.id === value);
}

export function defaultSettings(): SourceSettings {
  return {
    autoIndex: true,
    includeArchived: true,
    excludeCodexBar: true,
    defaultView: "provider",
    defaultRange: "7d",
    retentionDays: 90,
    privacyMode: "strict",
    hostId: "",
    sources: Object.fromEntries(
      PROVIDER_SOURCES.map((source) => [
        source.id,
        { enabled: true, path: source.defaultPath, hostId: "" },
      ]),
    ) as SourceSettings["sources"],
  };
}

export function capabilityNote(
  level: CapabilityReport[keyof CapabilityReport],
  label: string,
): string {
  if (level === "complete") return `${label} is available from this source.`;
  if (level === "partial") return `${label} is available for some records.`;
  return `${label} is not available from this source.`;
}

export function providerCapabilities(provider: ProviderId): CapabilityReport {
  const report = emptyCapabilities();
  report.metadata = "complete";
  report.models = provider === "claude" ? "partial" : "complete";
  if (provider === "opencode") report.metadata = "partial";
  return report;
}

export function canonicalProvider(
  bbProviderId: string | null | undefined,
): AnalyticsProviderId {
  if (!bbProviderId) return "other";
  const source = PROVIDER_SOURCES.find((candidate) =>
    candidate.bbProviderIds.includes(bbProviderId),
  );
  return source?.id ?? "other";
}
