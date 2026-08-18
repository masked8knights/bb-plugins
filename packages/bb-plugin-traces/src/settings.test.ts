import { describe, expect, it } from "vitest";
import { shouldScanAfterSettingsChange, type TraceSettingsSnapshot } from "./settings";

const base: TraceSettingsSnapshot = {
  autoIndex: false,
  scanIntervalSeconds: "5",
  additionalSessionRoots: "",
  workspaceRoots: "",
};

describe("trace settings scheduling", () => {
  it("scans a newly configured root even when auto-index is disabled", () => {
    expect(shouldScanAfterSettingsChange({ ...base, workspaceRoots: "/tmp/workspace" }, base)).toBe(true);
    expect(shouldScanAfterSettingsChange({ ...base, additionalSessionRoots: "/tmp/sessions" }, base)).toBe(true);
  });

  it("does not schedule a scan for unrelated changes while auto-index is disabled", () => {
    expect(shouldScanAfterSettingsChange({ ...base, scanIntervalSeconds: "10" }, base)).toBe(false);
  });

  it("keeps auto-index enabled changes scheduled", () => {
    expect(shouldScanAfterSettingsChange({ ...base, autoIndex: true }, base)).toBe(true);
  });
});
