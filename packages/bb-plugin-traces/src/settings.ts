export type TraceSettingsSnapshot = {
  autoIndex: boolean;
  scanIntervalSeconds: string;
  additionalSessionRoots: string;
  workspaceRoots: string;
};

export function shouldScanAfterSettingsChange(next: TraceSettingsSnapshot, previous: TraceSettingsSnapshot): boolean {
  return next.autoIndex ||
    next.additionalSessionRoots !== previous.additionalSessionRoots ||
    next.workspaceRoots !== previous.workspaceRoots;
}
