/** Matching and parsing helpers for demand-driven DS4 lifecycle settings. */

export interface ModelSelection {
  providerId: string;
  model: string;
}

/**
 * Return true when a model-picker selection belongs to this DS4 installation.
 *
 * BB commonly exposes the local model as `ds4/deepseek-v4-flash`, while some
 * provider integrations expose only the model tail. Treat a configured value
 * as either an exact model id or a namespace/prefix, so both forms can be
 * configured without coupling this plugin to one provider.
 */
export function matchesModelSelection(
  selection: ModelSelection,
  configuredProviderId: string,
  configuredModelSelector: string,
): boolean {
  const providerId = configuredProviderId.trim();
  if (providerId && selection.providerId.trim() !== providerId) return false;

  const model = selection.model.trim();
  const selector = configuredModelSelector.trim();
  if (!model || !selector) return false;

  return (
    model === selector ||
    model.startsWith(selector.endsWith("/") ? selector : `${selector}/`)
  );
}

/** Parse a user-facing idle timeout in seconds, with a safe bounded default. */
export function parseIdleTimeoutMs(
  raw: string,
  defaultMs = 5 * 60 * 1000,
): number {
  const seconds = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(seconds) || seconds < 0) return defaultMs;
  return Math.min(seconds * 1000, 24 * 60 * 60 * 1000);
}
