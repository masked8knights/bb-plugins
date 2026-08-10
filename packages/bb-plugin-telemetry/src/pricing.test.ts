import { afterEach, describe, expect, it } from "vitest";
import {
  costForTokens,
  currentPriceTable,
  lookupModelPrice,
  modelsDevToTable,
  normalizeModel,
  parsePriceOverrides,
  resolvePrice,
  sessionCost,
  setRuntimePriceTable,
  withSessionCost,
} from "./pricing";
import { emptyCapabilities, type ProviderSessionRecord } from "./types";

const session: ProviderSessionRecord = {  id: "codex:session-1",
  source: "provider",
  provider: "codex",
  hostId: "local",
  providerSessionId: "session-1",
  bbThreadId: null,
  title: "Pricing fixture",
  cwd: null,
  projectId: null,
  model: "gpt-5",
  origin: null,
  status: "completed",
  startedAt: 1_000,
  updatedAt: 2_000,
  durationMs: 1_000,
  messageCount: 1,
  turnCount: 1,
  toolCalls: 0,
  toolErrors: 0,
  inputTokens: 1_000_000,
  cachedInputTokens: 0,
  cachedWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 1_000_000,
  contextPeak: null,
  compactionCount: 0,
  failureCount: 0,
  delegatedCount: 0,
  archived: false,
  costUsd: null,
  costEstimated: false,
  coverage: emptyCapabilities("complete"),
  storeLabel: "fixture",
  sourcePath: null,
  fingerprint: "fixture",
  linkState: "none",
  findingCount: 0,
};

describe("normalizeModel", () => {
  it("lowercases and strips whitespace", () => {
    expect(normalizeModel("  GPT-5-Codex  ")).toBe("gpt-5-codex");
  });

  it("drops -latest and dated suffixes", () => {
    expect(normalizeModel("claude-sonnet-4-5-latest")).toBe("claude-sonnet-4-5");
    expect(normalizeModel("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet");
  });
});

describe("resolvePrice", () => {
  it("finds known models in the built-in table", () => {
    const resolved = resolvePrice("codex", "gpt-5-codex");
    expect(resolved.source).toBe("model");
    expect(resolved.price.inputPerM).toBe(1.25);
    expect(resolved.price.outputPerM).toBe(10);
  });

  it("falls back to provider pricing for unknown or absent models", () => {
    expect(resolvePrice("codex", "gpt-999").source).toBe("provider-fallback");
    expect(resolvePrice("claude", null).source).toBe("provider-fallback");
    expect(resolvePrice("claude", null).price.inputPerM).toBe(3);
  });

  it("prefers provider-scoped overrides", () => {
    const overrides = { claude: { "claude-sonnet-4-5": { inputPerM: 9, cachedInputPerM: 0.9, outputPerM: 27 } } };
    const resolved = resolvePrice("claude", "claude-sonnet-4-5", overrides);
    expect(resolved.source).toBe("model");
    expect(resolved.price.inputPerM).toBe(9);
  });
});

describe("costForTokens", () => {
  it("returns null when there are no billable tokens", () => {
    expect(costForTokens("codex", "gpt-5", null, null, null)).toBeNull();
    expect(costForTokens("codex", "gpt-5", 0, 0, 0)).toBeNull();
  });

  it("bills input, cached input, and output with gpt-5 prices", () => {
    const cost = costForTokens("codex", "gpt-5", 800_000, 200_000, 50_000);
    // 600k non-cached input @ $1.25/M + 200k cached @ $0.125/M + 50k output @ $10/M.
    expect(cost?.totalUsd).toBeCloseTo(0.75 + 0.025 + 0.5, 10);
    expect(cost?.estimated).toBe(false);
    expect(cost?.priceSource).toBe("model");
    expect(cost?.pricedTokens).toBe(850_000);
  });

  it("treats additive cache reads (input smaller than cached) as separate", () => {
    // Anthropic-style: input excludes cache reads.
    const cost = costForTokens("claude", "claude-sonnet-4-5", 100_000, 900_000, 20_000);
    // 100k @ $3/M + 900k @ $0.3/M + 20k @ $15/M.
    expect(cost?.totalUsd).toBeCloseTo(0.3 + 0.27 + 0.3, 10);
    expect(cost?.pricedTokens).toBe(1_020_000);
  });

  it("marks unknown models as estimated with fallback pricing", () => {
    const cost = costForTokens("omp", "my-custom-model", 1_000_000, 0, 100_000);
    expect(cost?.estimated).toBe(true);
    expect(cost?.priceSource).toBe("provider-fallback");
    expect(cost?.totalUsd).toBeCloseTo(3 + 1.5, 10);
  });

  it("applies overrides to unknown models", () => {
    const overrides = { omp: { "my-custom-model": { inputPerM: 1, cachedInputPerM: 0.1, outputPerM: 2 } } };
    const cost = costForTokens("omp", "My-Custom-Model", 1_000_000, 0, 100_000, overrides);
    expect(cost?.estimated).toBe(false);
    expect(cost?.totalUsd).toBeCloseTo(1 + 0.2, 10);
  });
});

describe("sessionCost / withSessionCost", () => {
  it("computes cost from session tokens", () => {
    const cost = sessionCost(session);
    expect(cost?.totalUsd).toBeCloseTo(1.25, 10);
    expect(cost?.estimated).toBe(false);
  });

  it("attaches cost fields to a session copy", () => {
    const enriched = withSessionCost({ ...session, model: "unknown-model" });
    expect(enriched.costUsd).toBeCloseTo(1.25, 10);
    expect(enriched.costEstimated).toBe(true);
  });

  it("prefers provider-reported cost over the price table", () => {
    const reported = sessionCost({ ...session, costUsd: 0.42, costEstimated: false });
    expect(reported?.totalUsd).toBeCloseTo(0.42, 10);
    expect(reported?.estimated).toBe(false);
    expect(reported?.priceSource).toBe("provider");

    const estimated = sessionCost({ ...session, costUsd: 0.42, costEstimated: true });
    expect(estimated?.estimated).toBe(true);
  });
});

describe("modelsDevToTable", () => {
  const payload = {
    cortecs: {
      id: "cortecs",
      npm: "@ai-sdk/openai-compatible",
      models: {
        "gpt-5.6-luna": { cost: { input: 1.1, output: 6.599, cache_read: 0.11 } },
        "gpt-5": { cost: { input: 1.3, output: 10.5, cache_read: 0.13 } },
      },
    },
    azure: {
      id: "azure",
      npm: "@ai-sdk/azure",
      models: {
        // Dedicated SDK but not canonical: must lose to openai's own price.
        "gpt-5.6-luna": { cost: { input: 1, output: 6, cache_read: 0.1 } },
      },
    },
    "github-copilot": {
      id: "github-copilot",
      npm: "@ai-sdk/openai-compatible",
      models: {
        // Bare reseller id before the first-party entry: must lose on priority.
        "claude-sonnet-4-5": { cost: { input: 2.7, output: 13.5, cache_read: 0.27 } },
        "gpt-5.6-luna": { cost: { input: 0.2, output: 1.2, cache_read: 0.02 } },
      },
    },
    impossibl: {
      id: "impossibl",
      npm: "@ai-sdk/openai-compatible",
      models: {
        "gpt-5.6-luna": { cost: { input: 0.2, output: 1.2, cache_read: 0.02 } },
      },
    },
    llmgateway: {
      id: "llmgateway",
      npm: "@ai-sdk/openai-compatible",
      models: {
        "gpt-5.6-luna": { cost: { input: 0.2, output: 1.2, cache_read: 0.02 } },
      },
    },
    openai: {
      id: "openai",
      npm: "@ai-sdk/openai",
      models: {
        "gpt-5": { cost: { input: 1.25, output: 10, cache_read: 0.125 } },
        "gpt-5-codex": { cost: { input: 1.25, output: 10 } },
        // Canonical provider's own entry wins over azure's marked-up copy.
        "gpt-5.6-luna": { cost: { input: 0.2, output: 1.2, cache_read: 0.02 } },
        "gpt-free": { cost: null },
        "gpt-no-cost": {},
      },
    },
    anthropic: {
      id: "anthropic",
      npm: "@ai-sdk/anthropic",
      models: {
        "claude-sonnet-4-5": { cost: { input: 3, output: 15, cache_read: 0.3 } },
      },
    },
    deepseek: {
      // Canonical despite being openai-compatible.
      id: "deepseek",
      npm: "@ai-sdk/openai-compatible",
      models: {
        "deepseek-chat": { cost: { input: 0.27, output: 1.1, cache_read: 0.07 } },
      },
    },
    groq: {
      id: "groq",
      npm: "@ai-sdk/groq",
      models: {
        "deepseek-chat": { cost: { input: 0.6, output: 2.4, cache_read: 0.15 } },
      },
    },
    anyapi: {
      id: "anyapi",
      npm: "@ai-sdk/openai-compatible",
      models: {
        "google/gemini-2.5-pro": { cost: { input: 1.25, output: 10, cache_read: 0.3125 } },
        "deepseek/deepseek-r1-20250905": { cost: { input: 0.55, output: 2.19, cache_read: 0.14 } },
      },
    },
    malformed: { id: "malformed", models: { weird: "not-an-object" } },
  };

  afterEach(() => {
    setRuntimePriceTable(null);
  });

  it("converts models.dev cost entries into the normalized table", () => {
    const table = modelsDevToTable(payload);
    expect(table["gpt-5"]).toEqual({ inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10 });
    expect(table["gpt-5-codex"]).toEqual({ inputPerM: 1.25, cachedInputPerM: 1.25, outputPerM: 10 });
    expect(table["gemini-2.5-pro"]).toEqual({ inputPerM: 1.25, cachedInputPerM: 0.3125, outputPerM: 10 });
    expect(table["deepseek-r1"]).toEqual({ inputPerM: 0.55, cachedInputPerM: 0.14, outputPerM: 2.19 });
  });

  it("prefers canonical providers over dedicated-SDK resellers and proxies", () => {
    const table = modelsDevToTable(payload);
    // Cortecs listed gpt-5 first at a markup; openai (canonical) must win.
    expect(table["gpt-5"]).toEqual({ inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10 });
    // Copilot's discounted claude-sonnet-4-5 must lose to Anthropic's list price.
    expect(table["claude-sonnet-4-5"]).toEqual({ inputPerM: 3, cachedInputPerM: 0.3, outputPerM: 15 });
    // Azure (dedicated SDK, marked up) must lose to openai's own luna price.
    expect(table["gpt-5.6-luna"]).toEqual({ inputPerM: 0.2, cachedInputPerM: 0.02, outputPerM: 1.2 });
    // deepseek is canonical even though its npm is openai-compatible.
    expect(table["deepseek-chat"]).toEqual({ inputPerM: 0.27, cachedInputPerM: 0.07, outputPerM: 1.1 });
  });

  it("uses the majority price among equal-priority candidates", () => {
    // Without a canonical entry, four resellers at 0.2/1.2 beat cortecs' 1.1/6.599 markup.
    const withoutCanonical = {
      ...payload,
      openai: { ...payload.openai, models: { ...(payload.openai.models as Record<string, unknown>), "gpt-5.6-luna": undefined } },
      azure: { ...payload.azure, models: {} },
    };
    const table = modelsDevToTable(withoutCanonical);
    expect(table["gpt-5.6-luna"]).toEqual({ inputPerM: 0.2, cachedInputPerM: 0.02, outputPerM: 1.2 });
  });

  it("skips models without cost and treats non-object payloads as empty", () => {
    const table = modelsDevToTable(payload);
    expect(table["gpt-free"]).toBeUndefined();
    expect(table["gpt-no-cost"]).toBeUndefined();
    expect(table["weird"]).toBeUndefined();
    expect(modelsDevToTable(null)).toEqual({});
    expect(modelsDevToTable("nope")).toEqual({});
    expect(modelsDevToTable([])).toEqual({});
  });
});

describe("runtime price table", () => {
  afterEach(() => {
    setRuntimePriceTable(null);
  });

  it("falls back to the bundled snapshot before a refresh", () => {
    expect(currentPriceTable()["gpt-5"]).toEqual({ inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10 });
    expect(resolvePrice("codex", "gpt-5").source).toBe("model");
  });

  it("replaces the table after a models.dev refresh", () => {
    setRuntimePriceTable({ "gpt-5": { inputPerM: 2, cachedInputPerM: 0.2, outputPerM: 12 } });
    expect(resolvePrice("codex", "gpt-5").price.inputPerM).toBe(2);
    expect(costForTokens("codex", "gpt-5", 1_000_000, 0, 0)?.totalUsd).toBeCloseTo(2, 10);
  });

  it("looks up overrides, then the active table", () => {
    const overrides = { codex: { "gpt-5": { inputPerM: 7, cachedInputPerM: 1, outputPerM: 20 } } };
    expect(lookupModelPrice("gpt-5", overrides)).toMatchObject({ origin: "override", price: { inputPerM: 7 } });
    setRuntimePriceTable({ "gpt-5": { inputPerM: 2, cachedInputPerM: 0.2, outputPerM: 12 } });
    expect(lookupModelPrice("gpt-5")).toMatchObject({ origin: "models-dev", price: { inputPerM: 2 } });
    expect(lookupModelPrice("gpt-5")).toMatchObject({ model: "gpt-5" });
    expect(lookupModelPrice("gpt-6")).toBeNull();
  });
});

describe("parsePriceOverrides", () => {
  it("parses a valid JSON price table", () => {
    const overrides = parsePriceOverrides('{"codex": {"gpt-5": {"inputPerM": 2, "cachedInputPerM": 0.2, "outputPerM": 12}}}');
    expect(overrides.codex?.["gpt-5"]?.outputPerM).toBe(12);
  });

  it("normalizes override model ids", () => {
    const overrides = parsePriceOverrides('{"claude": {"Claude-Sonnet-4-5-20250929": {"inputPerM": 1, "cachedInputPerM": 0.1, "outputPerM": 5}}}');
    expect(overrides.claude?.["claude-sonnet-4-5"]?.inputPerM).toBe(1);
  });

  it("rejects unknown providers and malformed prices", () => {
    expect(() => parsePriceOverrides('{"nope": {}}')).toThrow(/unknown provider/);
    expect(() => parsePriceOverrides('{"codex": {"gpt-5": {"inputPerM": -1, "cachedInputPerM": 1, "outputPerM": 1}}}')).toThrow(/non-negative/);
    expect(() => parsePriceOverrides("not json")).toThrow(/JSON/);
    expect(parsePriceOverrides("")).toEqual({});
    expect(parsePriceOverrides(undefined)).toEqual({});
  });
});
