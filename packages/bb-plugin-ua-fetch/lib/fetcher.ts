import { PRESET_BY_ID, presetForUserAgent, probeOrder, type UaPreset } from "./presets.ts";

export type Classification = "ok" | "shell" | "blocked" | "error";

export interface FetchOutcome {
  status: number;
  finalUrl: string;
  contentType: string;
  bytes: number;
  truncated: boolean;
  binary: boolean;
  /** Body capped at the caller's max_bytes — this is what gets returned. */
  body: string | null;
  /** Larger decode prefix (≥256KB when available) used for shell detection,
   * so truncated SPA pages aren't misjudged by their script-heavy heads. */
  detectText: string | null;
  error?: string;
}

export interface AttemptLog {
  source: string;
  label: string;
  classification: Classification;
  status: number;
  note?: string;
}

export interface CacheEntry {
  /** The exact User-Agent string that worked, or null when nothing did. */
  winner: string | null;
  label: string | null;
  at: number;
}

export interface UaCache {
  get(host: string): Promise<CacheEntry | undefined>;
  set(host: string, entry: CacheEntry): Promise<void>;
  delete(host: string): Promise<void>;
  list(): Promise<Array<{ host: string; entry: CacheEntry }>>;
}

export interface SmartFetchOptions {
  url: string;
  cache: UaCache;
  signal?: AbortSignal;
  /** Preset id or raw User-Agent string; bypasses and does not touch the cache. */
  forcedUa?: string;
  /** Preset id used for the first (default) attempt. */
  defaultPreset?: string;
  probingEnabled?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  winnerTtlDays?: number;
  maxProbes?: number;
}

export interface SmartFetchResult {
  requestedUrl: string;
  outcome: FetchOutcome | null;
  classification: Classification;
  servedAs: string;
  userAgent: string;
  strategy:
    | "forced"
    | "cache-hit"
    | "cache-stale"
    | "default"
    | "learned"
    | "exhausted"
    | "probing-disabled";
  attempts: AttemptLog[];
  host: string;
}

const TEXTUAL = /text\/|json|xml|javascript|ecmascript|xhtml/i;

// Distinctive anti-bot interstitial phrases — always a shell.
const HARD_SHELL_MARKERS = [
  "just a moment",
  "verify you are human",
  "verifying you are human",
  "checking your browser",
  "attention required",
  "are you a robot",
  "unusual traffic",
  "we've detected unusual activity",
];

// Paywall / login gating calls-to-action. Legit pages embed these too
// (footers, banners), so they only count on text-poor responses.
const GATE_MARKERS = [
  "enable javascript",
  "access denied",
  "request has been blocked",
  "sign up to continue",
  "subscribe to continue",
  "create an account to read",
  "log in to continue",
  "sign in to continue",
];

const GATE_MAX_VISIBLE_CHARS = 1_200;

export function normalizeUrl(raw: string): URL {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  return url;
}

function isTextual(contentType: string): boolean {
  return TEXTUAL.test(contentType);
}

export function extractVisibleText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectShell(outcome: FetchOutcome): boolean {
  if (!outcome.body || !/html/i.test(outcome.contentType)) return false;
  const visibleText = extractVisibleText(outcome.detectText ?? outcome.body);
  // Markers are judged on visible text so strings buried in scripts (e.g.
  // login-widget captcha code) don't false-positive.
  const lower = visibleText.toLowerCase();
  if (HARD_SHELL_MARKERS.some((m) => lower.includes(m))) return true;
  const visible = visibleText.length;
  // Gate CTAs only indicate a shell when there's little else on the page —
  // "protected by reCAPTCHA" footers and subscribe banners ride along with
  // perfectly readable articles.
  if (visible < GATE_MAX_VISIBLE_CHARS && GATE_MARKERS.some((m) => lower.includes(m))) return true;
  // Effectively zero visible text is always a JS shell / redirect stub.
  if (visible < 40 && outcome.bytes > 500) return true;
  // Lots of markup but almost no readable text → challenge / SPA shell.
  if (outcome.bytes > 5_000 && visible < 300) return true;
  return false;
}

export function classify(outcome: FetchOutcome): Classification {
  if (outcome.error) return "error";
  if (outcome.status >= 400 || outcome.status === 202 || outcome.status === 429) return "blocked";
  if (detectShell(outcome)) return "shell";
  return "ok";
}

async function readBodyCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), truncated };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) {
        truncated = true;
        void reader.cancel().catch(() => {});
        break;
      }
    }
  }
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, merged.length - offset);
    merged.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= merged.length) break;
  }
  return { bytes: merged, truncated };
}

const CLASSIFY_PREFIX_BYTES = 262_144;

export async function fetchWithHeaders(
  url: string,
  headers: Record<string, string>,
  opts: { timeoutMs: number; maxBytes: number; signal?: AbortSignal },
): Promise<FetchOutcome> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    const res = await fetch(url, { headers, redirect: "follow", signal });
    const contentType = res.headers.get("content-type") ?? "";
    const binary = !isTextual(contentType);
    // Read past maxBytes when needed so classification sees real content,
    // not just a script-heavy document head.
    const readCap = Math.max(opts.maxBytes, CLASSIFY_PREFIX_BYTES);
    const { bytes, truncated } = await readBodyCapped(res, readCap);
    const decoded = binary ? null : new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return {
      status: res.status,
      finalUrl: res.url || url,
      contentType,
      bytes: Number(res.headers.get("content-length") ?? bytes.byteLength) || bytes.byteLength,
      truncated,
      binary,
      body: decoded === null ? null : decoded.slice(0, opts.maxBytes),
      detectText: decoded,
    };
  } catch (err) {
    return {
      status: 0,
      finalUrl: url,
      contentType: "",
      bytes: 0,
      truncated: false,
      binary: false,
      body: null,
      detectText: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface Candidate {
  source: string;
  label: string;
  headers: Record<string, string>;
  ua: string;
}

function candidateFromPreset(presetIdOrRaw: string, source: string): Candidate {
  const preset = PRESET_BY_ID.get(presetIdOrRaw);
  if (preset) {
    return { source, label: preset.label, headers: preset.headers, ua: preset.headers["User-Agent"] };
  }
  return {
    source,
    label: "custom UA",
    headers: { "User-Agent": presetIdOrRaw, Accept: "*/*" },
    ua: presetIdOrRaw,
  };
}

function fresh(entry: CacheEntry, ttlDays: number): boolean {
  const ageDays = (Date.now() - entry.at) / 86_400_000;
  return ageDays < ttlDays;
}

const FAILURE_TTL_DAYS = 3;

/**
 * Fetch a URL with per-domain UA learning:
 * 1. cached winning UA for the host (when fresh),
 * 2. the default preset,
 * 3. a bounded probe through UA presets in randomized tier order.
 * Winners are written back to the cache keyed by host.
 */
interface BestEntry {
  outcome: FetchOutcome;
  candidate: Candidate;
  classification: Classification;
}

export async function smartFetch(opts: SmartFetchOptions): Promise<SmartFetchResult> {
  const url = normalizeUrl(opts.url);
  const host = url.hostname.toLowerCase();
  const maxBytes = opts.maxBytes ?? 100_000;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const winnerTtlDays = opts.winnerTtlDays ?? 30;
  const maxProbes = opts.maxProbes ?? 6;
  const attempts: AttemptLog[] = [];
  const tried = new Set<string>();
  let best: BestEntry | null = null;
  // Reads go through this helper: TS narrows `best` to never inside the
  // closures below otherwise.
  const currentBest = (): BestEntry | null => best;

  const attempt = async (
    candidate: Candidate,
    source: string,
  ): Promise<boolean> => {
    tried.add(candidate.ua);
    const outcome = await fetchWithHeaders(url.toString(), candidate.headers, {
      timeoutMs,
      maxBytes,
      signal: opts.signal,
    });
    const classification = classify(outcome);
    attempts.push({
      source,
      label: candidate.label,
      classification,
      status: outcome.status,
      note: outcome.error,
    });
    if (classification === "ok") {
      best = { outcome, candidate, classification };
      return true;
    }
    if (!best && outcome.status >= 200 && outcome.status < 400 && outcome.body !== null) {
      best = { outcome, candidate, classification };
    }
    return false;
  };

  // Forced UA: single shot, cache untouched.
  if (opts.forcedUa) {
    const candidate = candidateFromPreset(opts.forcedUa, "forced");
    await attempt(candidate, "forced");
    const hit = currentBest();
    return {
      requestedUrl: url.toString(),
      outcome: hit?.outcome ?? null,
      classification: hit?.classification ?? "error",
      servedAs: candidate.label,
      userAgent: candidate.ua,
      strategy: "forced",
      attempts,
      host,
    };
  }

  const cached = await opts.cache.get(host);

  // 1. Fresh learned winner for this host.
  if (cached?.winner && fresh(cached, winnerTtlDays)) {
    const preset = presetForUserAgent(cached.winner);
    const candidate: Candidate = {
      source: "cache",
      label: preset?.label ?? cached.label ?? "learned UA",
      headers: { "User-Agent": cached.winner, Accept: "*/*" },
      ua: cached.winner,
    };
    if (await attempt(candidate, "cache")) {
      return finish("cache-hit");
    }
  }

  // Stale-wrong cache: drop it so probes can relearn.
  if (cached?.winner && !fresh(cached, winnerTtlDays)) {
    await opts.cache.delete(host);
  }

  // 2. Default preset.
  const defaultId = opts.defaultPreset ?? "chrome";
  if (opts.probingEnabled === false) {
    const candidate = candidateFromPreset(defaultId, "default");
    await attempt(candidate, "default");
    const hit = currentBest();
    return {
      requestedUrl: url.toString(),
      outcome: hit?.outcome ?? null,
      classification: hit?.classification ?? "error",
      servedAs: candidate.label,
      userAgent: candidate.ua,
      strategy: "probing-disabled",
      attempts,
      host,
    };
  }

  const defaultCandidate = candidateFromPreset(defaultId, "default");
  if (await attempt(defaultCandidate, "default")) {
    await opts.cache.set(host, { winner: defaultCandidate.ua, label: defaultCandidate.label, at: Date.now() });
    return finish("default");
  }

  // 3. Probe presets in randomized tier order until one yields real content.
  // A recent "nothing worked" learning skips the probe loop — one default
  // attempt already happened above; re-probing would just burn requests.
  const knownDead = cached !== undefined && cached.winner === null && fresh(cached, FAILURE_TTL_DAYS);
  if (!knownDead) {
    let probed = 0;
    for (const id of probeOrder()) {
      if (probed >= maxProbes) break;
      const preset = PRESET_BY_ID.get(id);
      if (!preset || tried.has(preset.headers["User-Agent"])) continue;
      probed++;
      const candidate = candidateFromPreset(id, "probe");
      if (await attempt(candidate, "probe")) {
        await opts.cache.set(host, { winner: candidate.ua, label: candidate.label, at: Date.now() });
        return finish("learned");
      }
    }
  }

  // Nothing produced real content — remember the failure briefly.
  if (!(cached && cached.winner === null && fresh(cached, FAILURE_TTL_DAYS))) {
    await opts.cache.set(host, { winner: null, label: null, at: Date.now() });
  }
  return finish("exhausted");

  function finish(strategy: SmartFetchResult["strategy"]): SmartFetchResult {
    const hit = currentBest();
    return {
      requestedUrl: url.toString(),
      outcome: hit?.outcome ?? null,
      classification: hit?.classification ?? "error",
      servedAs: hit?.candidate.label ?? "none",
      userAgent: hit?.candidate.ua ?? "",
      strategy,
      attempts,
      host,
    };
  }
}
