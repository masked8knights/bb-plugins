import type {
  AnalyticsProviderId,
  CostEstimate,
  PriceOverrides,
  ProviderId,
  ProviderSessionRecord,
} from "./types";

/**
 * Model pricing in USD per 1,000,000 tokens.
 *
 * Prices are public list prices at the time of writing and are inherently
 * approximate: they change over time and providers offer volume discounts.
 * Sessions priced through the table are treated as exact; sessions priced
 * through a per-provider fallback (unknown or missing model) are marked
 * `estimated`. Correct drift or add models with the `priceTable` plugin
 * setting (see `parsePriceOverrides`).
 */
export interface ModelPrice {
  inputPerM: number;
  cachedInputPerM: number;
  outputPerM: number;
}

const price = (inputPerM: number, cachedInputPerM: number, outputPerM: number): ModelPrice =>
  ({ inputPerM, cachedInputPerM, outputPerM });

/**
 * Bundled snapshot keyed by normalized model id. Used only while offline or
 * before the first models.dev refresh succeeds; the runtime refresh replaces
 * this table entirely (see `setRuntimePriceTable`).
 */
const DEFAULT_PRICE_TABLE: Record<string, ModelPrice> = {
  // OpenAI / Codex
  "gpt-5": price(1.25, 0.125, 10),
  "gpt-5-codex": price(1.25, 0.125, 10),
  "gpt-5.1": price(1.25, 0.125, 10),
  "gpt-5.1-codex": price(1.25, 0.125, 10),
  "gpt-5-mini": price(0.25, 0.025, 2),
  "gpt-5.1-mini": price(0.25, 0.025, 2),
  "gpt-5-nano": price(0.05, 0.005, 0.4),
  "gpt-5.1-nano": price(0.05, 0.005, 0.4),
  "o3": price(2, 0.5, 8),
  "o3-mini": price(1.1, 0.275, 4.4),
  "o4-mini": price(1.1, 0.275, 4.4),
  "gpt-4.1": price(2, 0.5, 8),
  "gpt-4.1-mini": price(0.4, 0.1, 1.6),
  "gpt-4.1-nano": price(0.1, 0.025, 0.4),
  "gpt-4o": price(2.5, 1.25, 10),
  "gpt-4o-mini": price(0.15, 0.075, 0.6),
  "gpt-4-turbo": price(10, 10, 30),

  // Anthropic
  "claude-opus-4-5": price(5, 0.5, 25),
  "claude-opus-4-1": price(15, 1.5, 75),
  "claude-opus-4": price(15, 1.5, 75),
  "claude-sonnet-4-5": price(3, 0.3, 15),
  "claude-sonnet-4": price(3, 0.3, 15),
  "claude-3-7-sonnet": price(3, 0.3, 15),
  "claude-3-5-sonnet": price(3, 0.3, 15),
  "claude-3-5-haiku": price(0.8, 0.08, 4),
  "claude-3-opus": price(15, 1.5, 75),
  "claude-3-haiku": price(0.25, 0.025, 1.25),

  // Google
  "gemini-2.5-pro": price(1.25, 0.3125, 10),
  "gemini-2.5-flash": price(0.3, 0.075, 2.5),
  "gemini-2.5-flash-lite": price(0.1, 0.025, 0.4),
  "gemini-2.0-flash": price(0.1, 0.025, 0.4),
  "gemini-2.0-flash-lite": price(0.075, 0.01875, 0.3),
  "gemini-2.0-pro": price(1.25, 0.3125, 10),

  // DeepSeek
  "deepseek-chat": price(0.27, 0.07, 1.1),
  "deepseek-reasoner": price(0.55, 0.14, 2.19),
  "deepseek-v3": price(0.27, 0.07, 1.1),
  "deepseek-r1": price(0.55, 0.14, 2.19),
};

/**
 * Fallback pricing per provider, used when the model id is unknown or absent.
 * These are deliberately mid-range so unknown-model sessions are not wildly
 * over- or under-billed; such estimates are always marked `estimated`.
 */
const PROVIDER_FALLBACKS: Record<ProviderId, ModelPrice> = {
  codex: price(1.25, 0.125, 10),
  claude: price(3, 0.3, 15),
  pi: price(3, 0.3, 15),
  prime: price(3, 0.3, 15),
  opencode: price(1.25, 0.125, 10),
  omp: price(3, 0.3, 15),
};

/** Used for sessions whose provider is not one of the five indexed harnesses. */
const DEFAULT_FALLBACK = price(3, 0.3, 15);

/**
 * The active price table, replaced at runtime by models.dev data when a
 * refresh succeeds (see `setRuntimePriceTable`). Falls back to the bundled
 * snapshot while offline or before the first refresh.
 */
let runtimeTable: Record<string, ModelPrice> | null = null;

export const PRICES_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

export function setRuntimePriceTable(table: Record<string, ModelPrice> | null): void {
  runtimeTable = table;
}

export function currentPriceTable(): Record<string, ModelPrice> {
  return runtimeTable ?? DEFAULT_PRICE_TABLE;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

/**
 * Providers whose list prices are canonical for the harnesses telemetry
 * indexes. Their entries win outright over resellers and inference proxies
 * (azure, openrouter, vercel, …) that list the same model id at different
 * prices.
 */
const CANONICAL_PROVIDERS = new Set(["openai", "anthropic", "google", "deepseek", "xai"]);

/**
 * First-party providers ship dedicated AI SDK packages (`@ai-sdk/openai`,
 * `@ai-sdk/anthropic`, …) while resellers use `@ai-sdk/openai-compatible`.
 * Note deepseek (canonical) is itself openai-compatible, so the canonical
 * set is checked before npm.
 */
function providerPriority(provider: Record<string, unknown>): number {
  const id = typeof provider.id === "string" ? provider.id : "";
  if (CANONICAL_PROVIDERS.has(id)) return 0;
  const npm = typeof provider.npm === "string" ? provider.npm : "";
  return npm && npm !== "@ai-sdk/openai-compatible" ? 1 : 2;
}

/**
 * Convert a models.dev `api.json` payload into the normalized price table.
 *
 * Resellers (cortecs, github-copilot, anyapi, …) and inference proxies
 * (azure, openrouter, …) list the same model ids as the model's home
 * provider, sometimes with bare ids and markup or discount prices, so a
 * simple first-or-last-wins scan is wrong. Instead: candidates from the
 * canonical home provider (openai, anthropic, google, deepseek, xai) win
 * outright, then dedicated AI SDK packages beat openai-compatible
 * resellers, and among equal-priority candidates the most common price wins
 * (ties go to the earlier entry). Models without a cost entry, or without
 * input/output prices, are skipped. Cache-read pricing is optional; when a
 * provider does not report it, cached input is billed at the input rate.
 */
export function modelsDevToTable(payload: unknown): Record<string, ModelPrice> {
  interface Candidate {
    priority: number;
    order: number;
    price: ModelPrice;
  }
  const candidates = new Map<string, Candidate[]>();
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return {};
  let order = 0;
  for (const providerEntry of Object.values(payload as Record<string, unknown>)) {
    if (!providerEntry || typeof providerEntry !== "object") continue;
    const provider = providerEntry as Record<string, unknown>;
    const models = provider.models;
    if (!models || typeof models !== "object" || Array.isArray(models)) continue;
    const priority = providerPriority(provider);
    for (const [rawId, model] of Object.entries(models as Record<string, unknown>)) {
      if (!model || typeof model !== "object") continue;
      const cost = (model as Record<string, unknown>).cost;
      if (!cost || typeof cost !== "object" || Array.isArray(cost)) continue;
      const { input, output, cache_read: cacheRead } = cost as Record<string, unknown>;
      const inputPerM = finiteNumber(input);
      const outputPerM = finiteNumber(output);
      if (inputPerM === null || outputPerM === null) continue;
      if (inputPerM <= 0 && outputPerM <= 0) continue;
      const normalized = normalizeModel(rawId.includes("/") ? rawId.slice(rawId.indexOf("/") + 1) : rawId);
      if (!normalized) continue;
      const list = candidates.get(normalized) ?? [];
      list.push({
        priority,
        order: order++,
        price: {
          inputPerM,
          cachedInputPerM: finiteNumber(cacheRead) ?? inputPerM,
          outputPerM,
        },
      });
      candidates.set(normalized, list);
    }
  }
  const table: Record<string, ModelPrice> = {};
  for (const [normalized, list] of candidates) {
    const bestPriority = Math.min(...list.map((candidate) => candidate.priority));
    const pool = list.filter((candidate) => candidate.priority === bestPriority);
    const votes = new Map<string, Candidate[]>();
    for (const candidate of pool) {
      const key = `${candidate.price.inputPerM}:${candidate.price.cachedInputPerM}:${candidate.price.outputPerM}`;
      const group = votes.get(key) ?? [];
      group.push(candidate);
      votes.set(key, group);
    }
    const winner = [...votes.values()]
      .sort((a, b) => b.length - a.length || a[0].order - b[0].order)[0];
    table[normalized] = winner[0].price;
  }
  return table;
}

/** Per-provider fallback pricing (used when the model id is unknown). */
export function providerFallbackPrices(): Record<ProviderId, ModelPrice> {
  return { ...PROVIDER_FALLBACKS };
}

/**
 * Look up one model in overrides, then the active table. Returns null when
 * no price exists anywhere (fallback pricing would apply).
 */
export function lookupModelPrice(
  model: string,
  overrides: PriceOverrides = {},
): { model: string; price: ModelPrice; origin: "override" | "models-dev" | "bundled" } | null {
  const normalized = normalizeModel(model);
  for (const provider of Object.keys(PROVIDER_FALLBACKS) as ProviderId[]) {
    const override = overrides[provider]?.[normalized];
    if (override) return { model: normalized, price: override, origin: "override" };
  }
  const table = currentPriceTable();
  const price = table[normalized];
  if (price) return { model: normalized, price, origin: runtimeTable ? "models-dev" : "bundled" };
  return null;
}

/** Lowercase, strip whitespace, and drop `-latest` / `-YYYYMMDD` suffixes. */
export function normalizeModel(model: string): string {
  const cleaned = model.trim().toLowerCase().replace(/\s+/g, "");
  return cleaned
    .replace(/-(?:latest)$/, "")
    .replace(/-\d{8}$/, "");
}

export function resolvePrice(
  provider: AnalyticsProviderId,
  model: string | null,
  overrides: PriceOverrides = {},
): { price: ModelPrice; source: "model" | "provider-fallback" } {
  if (model) {
    const normalized = normalizeModel(model);
    const override = overrides[provider as ProviderId]?.[normalized];
    if (override) return { price: override, source: "model" };
    const known = currentPriceTable()[normalized];
    if (known) return { price: known, source: "model" };
  }
  return { price: PROVIDER_FALLBACKS[provider as ProviderId] ?? DEFAULT_FALLBACK, source: "provider-fallback" };
}

/**
 * Estimate the USD cost of one token bucket (a session or a turn).
 *
 * Providers disagree about whether `inputTokens` includes cached tokens:
 * OpenAI-style records report the total prompt including the cached subset,
 * Anthropic-style records report cache reads separately. When the cached
 * count is not larger than the input count we assume the input includes it
 * and bill only the non-cached remainder at the full input rate; otherwise
 * we treat them as additive.
 */
export function costForTokens(
  provider: AnalyticsProviderId,
  model: string | null,
  inputTokens: number | null,
  cachedInputTokens: number | null,
  outputTokens: number | null,
  overrides: PriceOverrides = {},
): CostEstimate | null {
  const input = inputTokens ?? 0;
  const cached = cachedInputTokens ?? 0;
  const output = outputTokens ?? 0;
  if (input <= 0 && cached <= 0 && output <= 0) return null;

  // When the input count already includes the cached subset, bill only the
  // non-cached remainder at the full input rate.
  const billedInput = input >= cached ? Math.max(0, input - cached) : input;
  const billedCached = cached;

  const { price, source } = resolvePrice(provider, model, overrides);
  const perToken = (perM: number): number => perM / 1_000_000;
  const totalUsd =
    billedInput * perToken(price.inputPerM) +
    billedCached * perToken(price.cachedInputPerM) +
    output * perToken(price.outputPerM);

  return {
    totalUsd,
    estimated: source === "provider-fallback",
    priceSource: source,
    model,
    pricedTokens: billedInput + billedCached + output,
  };
}

export function sessionCost(
  session: ProviderSessionRecord,
  overrides: PriceOverrides = {},
): CostEstimate | null {
  // Harnesses that report their own cost (Pi/omp per-message usage cost,
  // hermes actual/estimated cost, opencode per-message cost) win over the
  // price table: the number is what the provider actually billed.
  if (session.costUsd !== null) {
    return {
      totalUsd: session.costUsd,
      estimated: session.costEstimated,
      priceSource: "provider",
      model: session.model,
      pricedTokens: session.totalTokens ?? 0,
    };
  }
  return costForTokens(
    session.provider,
    session.model,
    session.inputTokens,
    session.cachedInputTokens,
    session.outputTokens,
    overrides,
  );
}

/** Return a copy of the session with cost fields attached. */
export function withSessionCost(
  session: ProviderSessionRecord,
  overrides: PriceOverrides = {},
): ProviderSessionRecord {
  const cost = sessionCost(session, overrides);
  return {
    ...session,
    costUsd: cost?.totalUsd ?? null,
    costEstimated: cost?.estimated ?? false,
  };
}

/** Validate the `priceTable` JSON setting into provider/model overrides. */
export function parsePriceOverrides(value: unknown): PriceOverrides {
  if (typeof value !== "string" || !value.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`priceTable must be a JSON object, got: ${value.slice(0, 80)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("priceTable must be a JSON object keyed by provider");
  }
  const overrides: PriceOverrides = {};
  for (const [provider, models] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(provider in PROVIDER_FALLBACKS)) {
      throw new Error(`priceTable: unknown provider "${provider}" (expected codex, claude, pi, prime, opencode, or omp)`);
    }
    if (models === null || typeof models !== "object" || Array.isArray(models)) {
      throw new Error(`priceTable: "${provider}" must map model names to price objects`);
    }
    const providerPrices: Record<string, ModelPrice> = {};
    for (const [model, modelPrice] of Object.entries(models as Record<string, unknown>)) {
      const record = modelPrice as Record<string, unknown> | null;
      const inputPerM = Number(record?.inputPerM);
      const cachedInputPerM = Number(record?.cachedInputPerM);
      const outputPerM = Number(record?.outputPerM);
      if (![inputPerM, cachedInputPerM, outputPerM].every((value) => Number.isFinite(value) && value >= 0)) {
        throw new Error(`priceTable: "${provider}.${model}" needs non-negative inputPerM, cachedInputPerM, outputPerM numbers`);
      }
      providerPrices[normalizeModel(model)] = { inputPerM, cachedInputPerM, outputPerM };
    }
    overrides[provider as ProviderId] = providerPrices;
  }
  return overrides;
}
