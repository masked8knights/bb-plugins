import { describe, expect, it } from "vitest";
import { formatReviewCountdown, remainingReviewMs } from "./countdown";

describe("Plannotator review countdown", () => {
  it("returns null when the host does not provide an expiry", () => {
    expect(remainingReviewMs(null, 1_000)).toBeNull();
  });

  it("clamps expired reviews to zero", () => {
    expect(remainingReviewMs(900, 1_000)).toBe(0);
    expect(formatReviewCountdown(0)).toBe("0s");
  });

  it("formats seconds, minutes, and hours for a compact card", () => {
    expect(formatReviewCountdown(59_001)).toBe("1m 00s");
    expect(formatReviewCountdown(65_000)).toBe("1m 05s");
    expect(formatReviewCountdown(3_905_000)).toBe("1h 05m");
  });
});
