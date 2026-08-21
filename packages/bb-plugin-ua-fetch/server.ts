// bb-plugin-ua-fetch — UA-adaptive web fetch with per-domain learning.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  smartFetch,
  type AttemptLog,
  type CacheEntry,
  type Classification,
  type SmartFetchResult,
  type UaCache,
} from "./lib/fetcher.ts";
import { PRESETS } from "./lib/presets.ts";

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({ learnedHosts: z.number().int() }),
  },
});

const HOST_KEY_PREFIX = "host:";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    defaultUa: {
      type: "select",
      label: "Default user agent",
      description: "Preset tried first when a host has no learned winner.",
      options: ["chrome", "claude-user", "gptbot", "googlebot", "curl"],
      default: "chrome",
    },
    probing: {
      type: "boolean",
      label: "Probe on block",
      description:
        "When the first attempt looks blocked or paywalled, cycle through other UA presets and learn the winner.",
      default: true,
    },
  });
  const { defaultUa, probing } = await settings.get();

  const cache: UaCache = {
    async get(host) {
      return bb.storage.kv.get<CacheEntry>(HOST_KEY_PREFIX + host);
    },
    async set(host, entry) {
      await bb.storage.kv.set(HOST_KEY_PREFIX + host, entry);
    },
    async delete(host) {
      await bb.storage.kv.delete(HOST_KEY_PREFIX + host);
    },
    async list() {
      const keys = await bb.storage.kv.list(HOST_KEY_PREFIX);
      const out: Array<{ host: string; entry: CacheEntry }> = [];
      for (const key of keys) {
        const entry = await bb.storage.kv.get<CacheEntry>(key);
        if (entry) out.push({ host: key.slice(HOST_KEY_PREFIX.length), entry });
      }
      return out;
    },
  };

  function describeClassification(c: Classification): string {
    switch (c) {
      case "ok":
        return "real content";
      case "shell":
        return "JS shell / challenge page";
      case "blocked":
        return "blocked or paywalled";
      case "error":
        return "request failed";
    }
  }

  function formatResult(r: SmartFetchResult, maxBytes: number): {
    text: string;
    isError: boolean;
  } {
    const lines: string[] = [];
    lines.push(`GET ${r.requestedUrl}`);
    if (!r.outcome) {
      lines.push(`result: no response (${describeClassification(r.classification)})`);
      lines.push(
        `attempts: ${attemptsSummary(r.attempts) || "none"}`,
      );
      return { text: lines.join("\n"), isError: true };
    }
    const o = r.outcome;
    lines.push(`status: ${o.status} ${o.status === 0 ? "(transport error)" : ""}`.trimEnd());
    if (o.finalUrl && o.finalUrl !== r.requestedUrl) lines.push(`final-url: ${o.finalUrl}`);
    lines.push(`content-type: ${o.contentType || "unknown"}`);
    lines.push(`served-as: ${r.servedAs}`);
    lines.push(`strategy: ${strategyLabel(r.strategy)} on ${r.host}`);
    lines.push(`quality: ${describeClassification(r.classification)}`);
    if (r.attempts.length > 1) lines.push(`attempts: ${attemptsSummary(r.attempts)}`);
    if (o.truncated) lines.push(`note: body truncated to ${maxBytes} bytes`);
    lines.push("---");
    if (o.binary) {
      lines.push(`(binary content, ${o.bytes} bytes — not shown)`);
    } else {
      lines.push(o.body ?? "");
    }
    return { text: lines.join("\n").trimEnd(), isError: r.classification === "blocked" || r.classification === "error" };
  }

  function attemptsSummary(attempts: AttemptLog[]): string {
    return attempts
      .map((a) => `${a.label}${a.note ? ` (${a.note})` : ` → ${a.status === 0 ? "error" : a.status}`}`)
      .join("; ");
  }

  function strategyLabel(s: SmartFetchResult["strategy"]): string {
    switch (s) {
      case "forced":
        return "forced UA";
      case "cache-hit":
        return "cached winner";
      case "cache-stale":
        return "stale cache re-learned";
      case "default":
        return "default preset";
      case "learned":
        return "new winner learned";
      case "exhausted":
        return "no UA worked";
      case "probing-disabled":
        return "single attempt";
    }
  }

  bb.rpc.register(rpcContract, {
    status: async () => ({ learnedHosts: (await cache.list()).filter((e) => e.entry.winner).length }),
  });

  bb.agents.registerTool({
    name: "web_fetch",
    description:
      "Fetch a URL as markdown-ish text with adaptive User-Agent spoofing. Tries the cached winning UA for the domain, then a normal browser UA; if the result looks blocked, paywalled, or is a JS shell, it probes AI-crawler/search-bot/social unfurler UAs until one returns real content and remembers the winner per domain.",
    instructions:
      "Use web_fetch for reading web pages. It handles bot-blocked sites automatically; only pass user_agent to force a specific identity. If quality reports 'blocked or paywalled', the site defeated every known UA — don't retry blindly.",
    experimental_statusLabels: {
      pending: "Fetching page (UA-adaptive)",
      completed: "Fetched page",
    },
    parameters: z.object({
      url: z.string().min(1).describe("URL to fetch (https:// added automatically when missing)."),
      user_agent: z
        .string()
        .optional()
        .describe(
          `Force a specific identity: a preset id (${PRESETS.map((p) => p.id).join(", ")}) or any raw User-Agent string. Skips and does not touch the learned cache.`,
        ),
      max_bytes: z
        .number()
        .int()
        .min(1_000)
        .max(400_000)
        .optional()
        .describe("Body cap in bytes before truncation. Default 100000."),
      timeout_ms: z.number().int().min(1_000).max(60_000).optional().describe("Per-attempt timeout. Default 20000."),
      no_cache: z.boolean().optional().describe("Ignore and do not update the learned per-domain UA cache."),
    }),
    async execute(params, ctx) {
      try {
        const result = await smartFetch({
          url: params.url,
          cache,
          signal: ctx.signal,
          forcedUa: params.user_agent,
          defaultPreset: defaultUa,
          probingEnabled: probing,
          maxBytes: params.max_bytes,
          timeoutMs: params.timeout_ms,
        });
        if (params.no_cache) {
          // Result already used the cache; drop anything written for this host.
          await cache.delete(result.host);
        }
        const { text, isError } = formatResult(result, params.max_bytes ?? 100_000);
        return { content: [{ type: "text", text }], isError };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `web_fetch failed: ${message}` }], isError: true };
      }
    },
  });

  bb.cli.register({
    name: "ua-fetch",
    summary: "UA-adaptive web fetch: probe, learn, and manage the per-domain UA cache",
    commands: [
      {
        name: "probe",
        summary: "Fetch a URL using the same logic as the web_fetch tool (summary output)",
        usage: "bb ua-fetch probe <url> [--ua <preset|raw>]",
      },
      {
        name: "cache",
        summary: "List learned per-domain UA winners",
        usage: "bb ua-fetch cache",
      },
      {
        name: "forget",
        summary: "Delete learned entries",
        usage: "bb ua-fetch forget <host|--all>",
      },
    ],
    async run(argv) {
      const [sub, ...rest] = argv;
      if (sub === "probe" && rest[0]) {
        const uaFlag = rest.indexOf("--ua");
        let forcedUa: string | undefined;
        let target = rest[0];
        if (uaFlag !== -1 && rest[uaFlag + 1]) {
          forcedUa = rest[uaFlag + 1];
          if (target.startsWith("--")) target = rest[1] ?? "";
        }
        if (!target) return { exitCode: 2, stderr: "usage: bb ua-fetch probe <url> [--ua <preset|raw>]" };
        const current = await settings.get();
        const r = await smartFetch({
          url: target,
          cache,
          forcedUa,
          defaultPreset: current.defaultUa,
          probingEnabled: current.probing,
          maxBytes: 20_000,
        });
        const lines = [
          `url: ${r.requestedUrl}`,
          `host: ${r.host}`,
          `status: ${r.outcome?.status ?? 0}`,
          `content-type: ${r.outcome?.contentType ?? "-"}`,
          `served-as: ${r.servedAs}`,
          `quality: ${describeClassification(r.classification)}`,
          `strategy: ${strategyLabel(r.strategy)}`,
          `attempts: ${attemptsSummary(r.attempts)}`,
        ];
        return { exitCode: r.classification === "ok" ? 0 : 1, stdout: lines.join("\n") + "\n" };
      }
      if (sub === "cache") {
        const entries = await cache.list();
        if (entries.length === 0) return { exitCode: 0, stdout: "no learned hosts yet\n" };
        const lines = entries
          .sort((a, b) => a.host.localeCompare(b.host))
          .map(({ host, entry }) => {
            const when = new Date(entry.at).toISOString();
            return entry.winner
              ? `${host}\t${entry.label ?? "?"}\t${when}`
              : `${host}\t(nothing worked)\t${when}`;
          });
        return { exitCode: 0, stdout: lines.join("\n") + "\n" };
      }
      if (sub === "forget") {
        const target = rest[0];
        if (!target) return { exitCode: 2, stderr: "usage: bb ua-fetch forget <host|--all>" };
        if (target === "--all") {
          for (const { host } of await cache.list()) await cache.delete(host);
          return { exitCode: 0, stdout: "forgot all hosts\n" };
        }
        await cache.delete(target.toLowerCase());
        return { exitCode: 0, stdout: `forgot ${target.toLowerCase()}\n` };
      }
      return {
        exitCode: 2,
        stderr: "usage: bb ua-fetch <probe <url>|cache|forget <host|--all>>\n",
      };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
