/**
 * Small host-side seams for embedding the official Plannotator runtime.
 *
 * Plannotator keeps its one-time UI announcements in cookies. BB's browser
 * page can share those cookies with the iframe only when both use the same
 * loopback hostname; ports are intentionally ignored by cookie scoping.
 */
export const UPSTREAM_LOOK_AND_FEEL_COOKIE =
  "plannotator-look-feel-announcement-seen";
export const UPSTREAM_LOOK_AND_FEEL_VERSION = "2";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOCAL_BIND_HOSTNAMES = new Set([
  ...LOOPBACK_HOSTNAMES,
  "0.0.0.0",
  "::",
  "[::]",
]);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.trim().toLowerCase());
}

/** Hostnames an upstream server may report for a listener local to BB. */
export function isLocalBindHostname(hostname: string): boolean {
  return LOCAL_BIND_HOSTNAMES.has(hostname.trim().toLowerCase());
}

/**
 * Make the child URL use the hostname visible to the BB browser page.
 *
 * The server-side loopback address is not necessarily the browser-facing
 * address: BB can serve its UI from localhost while its backend advertises
 * 127.0.0.1. Remote-mode Plannotator can also report a wildcard bind address
 * such as 0.0.0.0. Those values are server-local transport details, not
 * browser destinations, so rewrite them to the host visible to the browser.
 * Already-public upstream URLs are left alone.
 */
export function normalizeEmbeddedSessionUrl(
  url: string,
  browserHostname: string,
): string {
  const targetHostname = browserHostname.trim();
  if (!targetHostname) return url;

  try {
    const parsed = new URL(url);
    if (!isLocalBindHostname(parsed.hostname)) return url;
    parsed.hostname = targetHostname;
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return url;
  }
}

export function upstreamOnboardingCookie(): string {
  return `${UPSTREAM_LOOK_AND_FEEL_COOKIE}=${UPSTREAM_LOOK_AND_FEEL_VERSION}; path=/; max-age=31536000; SameSite=Lax`;
}
