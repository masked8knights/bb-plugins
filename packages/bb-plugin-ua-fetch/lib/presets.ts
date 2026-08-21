export interface UaPreset {
  id: string;
  label: string;
  /** Lower tiers are tried first when probing. */
  tier: number;
  headers: Record<string, string>;
}

const BOT_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/**
 * UA presets ordered in tiers. Tier 1 = AI crawlers that sites often serve
 * real content to for free (the Can Bölük matrix). Tier 2 = search engines,
 * tier 3 = link unfurlers, tier 4 = plain clients.
 */
export const PRESETS: UaPreset[] = [
  {
    id: "claude-user",
    label: "Claude-User (Anthropic)",
    tier: 1,
    headers: {
      "User-Agent":
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +https://support.anthropic.com/en/articles/9691231-claude-user-agent)",
      Accept: BOT_ACCEPT,
      "Accept-Language": "en-US,en;q=0.9",
    },
  },
  {
    id: "gptbot",
    label: "GPTBot (OpenAI)",
    tier: 1,
    headers: {
      "User-Agent":
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
      Accept: BOT_ACCEPT,
    },
  },
  {
    id: "openai-file-downloader",
    label: "OpenAI File Downloader",
    tier: 1,
    headers: { "User-Agent": "OpenAI File Downloader", Accept: "*/*" },
  },
  {
    id: "xai-image-api-fetch",
    label: "XaiImageApiFetch/1.0",
    tier: 1,
    headers: { "User-Agent": "XaiImageApiFetch/1.0", Accept: "*/*" },
  },
  {
    id: "perplexitybot",
    label: "PerplexityBot",
    tier: 1,
    headers: {
      "User-Agent":
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
      Accept: BOT_ACCEPT,
    },
  },
  {
    id: "google-extended",
    label: "Google-Extended",
    tier: 1,
    headers: {
      "User-Agent":
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Google-Extended/1.0)",
      Accept: BOT_ACCEPT,
    },
  },
  {
    id: "googlebot",
    label: "Googlebot",
    tier: 2,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.200 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      Accept: BOT_ACCEPT,
    },
  },
  {
    id: "bingbot",
    label: "Bingbot",
    tier: 2,
    headers: {
      "User-Agent":
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
      Accept: BOT_ACCEPT,
    },
  },
  {
    id: "duckduckbot",
    label: "DuckDuckBot",
    tier: 2,
    headers: {
      "User-Agent": "DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)",
      Accept: BOT_ACCEPT,
    },
  },
  {
    id: "applebot",
    label: "Applebot",
    tier: 2,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
      Accept: BOT_ACCEPT,
    },
  },
  {
    id: "facebookexternalhit",
    label: "Facebook External Hit",
    tier: 3,
    headers: {
      "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      Accept: BOT_ACCEPT,
    },
  },
  {
    id: "twitterbot",
    label: "Twitterbot",
    tier: 3,
    headers: {
      "User-Agent": "Twitterbot/1.0",
      Accept: BOT_ACCEPT,
    },
  },
  {
    id: "slackbot",
    label: "Slackbot",
    tier: 3,
    headers: {
      "User-Agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      Accept: BOT_ACCEPT,
    },
  },
  {
    id: "chrome",
    label: "Chrome (desktop)",
    tier: 4,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "Accept-Language": "en-US,en;q=0.9",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
    },
  },
  {
    id: "curl",
    label: "curl",
    tier: 4,
    headers: { "User-Agent": "curl/8.7.1", Accept: "*/*" },
  },
  {
    id: "bytespider",
    label: "Bytespider",
    tier: 5,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)",
      Accept: BOT_ACCEPT,
    },
  },
];

export const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

export function presetForUserAgent(ua: string): UaPreset | undefined {
  return PRESETS.find((p) => p.headers["User-Agent"] === ua);
}

/** Ordered candidate ids: tier order, shuffled within each tier. */
export function probeOrder(): string[] {
  const tiers = [...new Set(PRESETS.map((p) => p.tier))].sort((a, b) => a - b);
  const out: string[] = [];
  for (const tier of tiers) {
    const group = PRESETS.filter((p) => p.tier === tier);
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [group[i], group[j]] = [group[j], group[i]];
    }
    out.push(...group.map((p) => p.id));
  }
  return out;
}
