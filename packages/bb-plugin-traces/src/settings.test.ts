import { describe, expect, it } from "vitest";
import {
  addSessionRootEntry,
  configuredSessionRootEntries,
  removeSessionRootEntry,
  serializeSessionRootEntries,
  shouldScanAfterSettingsChange,
  type TraceSettingsSnapshot,
} from "./settings";

const base: TraceSettingsSnapshot = {
  autoIndex: false,
  scanIntervalSeconds: "5",
  additionalSessionRoots: "",
};

describe("trace settings scheduling", () => {
  it("scans a newly configured root even when auto-index is disabled", () => {
    expect(shouldScanAfterSettingsChange({ ...base, additionalSessionRoots: "/tmp/sessions" }, base)).toBe(true);
  });

  it("does not schedule a scan for unrelated changes while auto-index is disabled", () => {
    expect(shouldScanAfterSettingsChange({ ...base, scanIntervalSeconds: "10" }, base)).toBe(false);
  });

  it("keeps auto-index enabled changes scheduled", () => {
    expect(shouldScanAfterSettingsChange({ ...base, autoIndex: true }, base)).toBe(true);
  });
});

describe("configured session root entries", () => {
  it("normalizes blank lines and duplicate entries without changing the order", () => {
    expect(configuredSessionRootEntries(" /tmp/one\n\n/tmp/two\n/tmp/one \n")).toEqual([
      "/tmp/one",
      "/tmp/two",
    ]);
    expect(serializeSessionRootEntries([" /tmp/one ", "", "/tmp/two", "/tmp/one"])).toBe(
      "/tmp/one\n/tmp/two",
    );
  });

  it("adds and removes a custom root as an idempotent settings edit", () => {
    const withRoot = addSessionRootEntry("/tmp/one", "/tmp/two");
    expect(addSessionRootEntry(withRoot, "/tmp/two")).toBe("/tmp/one\n/tmp/two");
    expect(removeSessionRootEntry(withRoot, "/tmp/one")).toBe("/tmp/two");
    expect(removeSessionRootEntry(withRoot, "/tmp/missing")).toBe(withRoot);
  });
});
