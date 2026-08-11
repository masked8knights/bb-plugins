/** A successful source scan older than this is no longer presented as fresh. */
export const SOURCE_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

export interface SourceFreshness {
  enabled: boolean;
  detected: boolean;
  lastSuccessAt: number | null;
}

export function sourceIsStale(
  source: SourceFreshness,
  now = Date.now(),
): boolean {
  if (!source.enabled || !source.detected) return false;
  return source.lastSuccessAt === null || now - source.lastSuccessAt > SOURCE_STALE_AFTER_MS;
}
