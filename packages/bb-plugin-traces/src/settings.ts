export type TraceSettingsSnapshot = {
  autoIndex: boolean;
  scanIntervalSeconds: string;
  additionalSessionRoots: string;
};

export function configuredSessionRootEntries(value: string): string[] {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  return entries;
}

export function serializeSessionRootEntries(entries: readonly string[]): string {
  return configuredSessionRootEntries(entries.join("\n")).join("\n");
}

export function addSessionRootEntry(value: string, entry: string): string {
  return serializeSessionRootEntries([...configuredSessionRootEntries(value), entry]);
}

export function removeSessionRootEntry(value: string, entry: string): string {
  const target = entry.trim();
  return serializeSessionRootEntries(
    configuredSessionRootEntries(value).filter((candidate) => candidate !== target),
  );
}

export function shouldScanAfterSettingsChange(next: TraceSettingsSnapshot, previous: TraceSettingsSnapshot): boolean {
  return next.autoIndex ||
    next.additionalSessionRoots !== previous.additionalSessionRoots;
}
