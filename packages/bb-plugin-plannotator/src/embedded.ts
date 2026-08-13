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

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Make the child URL use the hostname visible to the BB browser page.
 *
 * The server-side loopback address is not necessarily the browser-facing
 * address: BB can serve its UI from localhost while its backend advertises
 * 127.0.0.1. Restrict the rewrite to loopback addresses so remote/tunneled
 * sessions keep the URL supplied by the upstream runtime.
 */
export function normalizeEmbeddedSessionUrl(
  url: string,
  browserHostname: string,
): string {
  if (!isLoopbackHostname(browserHostname)) return url;

  try {
    const parsed = new URL(url);
    if (!isLoopbackHostname(parsed.hostname)) return url;
    parsed.hostname = browserHostname;
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return url;
  }
}

export function upstreamOnboardingCookie(): string {
  return `${UPSTREAM_LOOK_AND_FEEL_COOKIE}=${UPSTREAM_LOOK_AND_FEEL_VERSION}; path=/; max-age=31536000; SameSite=Lax`;
}
