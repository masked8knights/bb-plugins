# bb-plugin-ua-fetch

UA-adaptive web fetch for bb agents. Inspired by Can Bölük's UA-spoofing matrix
([@_can1357 on X](https://x.com/_can1357/status/2090837707069014224)): many
sites serve real content free to AI-crawler user agents while blocking browsers
and curl — and some do the reverse.

## Staged preview

![Live BB screenshot of UA Fetch settings](assets/staged-preview.png)

Captured from the running BB application with live fetch settings.

## The `web_fetch` agent tool

Fetch strategy per call:

1. **Cached winner** — if this domain was learned before (fresh within 30 days),
   start with the UA that worked last time.
2. **Default preset** (`chrome` by default, configurable in plugin settings).
3. **Probe** — if the response is blocked/paywalled (4xx, 402, 429, 202) or a JS
   shell / challenge page, cycle up to 6 more presets in randomized tier order:
   AI crawlers first (Claude-User, GPTBot, OpenAI File Downloader, xAI,
   PerplexityBot…), then search bots, then social unfurlers, then plain clients.
   The first UA yielding real content is cached as the domain's winner.

Nothing worked? The failure is cached for 3 days so later calls don't re-probe.

Output reports `status`, `served-as` (which identity won), `strategy`
(cache-hit / learned / exhausted / forced), a per-attempt trail, then the body
(truncated to `max_bytes`, default 100 KB).

Tool parameters: `url`, `user_agent` (force a preset id or raw UA string —
bypasses cache), `max_bytes`, `timeout_ms`, `no_cache`.

## CLI

```
bb ua-fetch probe <url> [--ua <preset|raw>]   # run the same logic, summary output
bb ua-fetch cache                             # list learned per-domain winners
bb ua-fetch forget <host|--all>               # clear learned entries
```

## Settings

- **Default user agent** — first-attempt preset when nothing is learned.
- **Probe on block** — enable/disable the fallback probing entirely.

## Notes

- Shell detection: challenge markers ("Just a moment", "verify you are human",
  paywall CTAs…) judged on visible text only, plus low-visible-text-vs-markup
  heuristics. Strings buried in `<script>` don't false-positive.
- UA spoofing gets you past UA-based gates only; IP-reputation blocks
  (Bloomberg et al.) still win.
- Cache lives in bb kv under `host:<hostname>` keys.
