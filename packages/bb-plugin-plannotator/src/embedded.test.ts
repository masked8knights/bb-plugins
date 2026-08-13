import { describe, expect, it } from "vitest";
import {
  normalizeEmbeddedSessionUrl,
  upstreamOnboardingCookie,
} from "./embedded";

describe("embedded Plannotator host seams", () => {
  it("aligns local upstream URLs with the browser-facing loopback host", () => {
    expect(
      normalizeEmbeddedSessionUrl("http://127.0.0.1:43210", "localhost"),
    ).toBe("http://localhost:43210");
    expect(
      normalizeEmbeddedSessionUrl("http://localhost:43210", "127.0.0.1"),
    ).toBe("http://127.0.0.1:43210");
  });

  it("does not rewrite remote sessions", () => {
    expect(
      normalizeEmbeddedSessionUrl("https://review.example.test:43210", "localhost"),
    ).toBe("https://review.example.test:43210");
    expect(
      normalizeEmbeddedSessionUrl("http://127.0.0.1:43210", "review.example.test"),
    ).toBe("http://127.0.0.1:43210");
  });

  it("pins the current upstream look-and-feel announcement as seen", () => {
    expect(upstreamOnboardingCookie()).toBe(
      "plannotator-look-feel-announcement-seen=2; path=/; max-age=31536000; SameSite=Lax",
    );
  });
});
