import assert from "node:assert/strict";
import { test } from "node:test";
import {
  matchesModelSelection,
  parseIdleTimeoutMs,
} from "./model-selection.ts";

test("matches the default DS4 model namespace", () => {
  assert.equal(
    matchesModelSelection(
      { providerId: "pi", model: "ds4/deepseek-v4-flash" },
      "",
      "ds4/",
    ),
    true,
  );
});

test("supports exact model ids and an optional provider filter", () => {
  assert.equal(
    matchesModelSelection(
      { providerId: "pi", model: "deepseek-v4-flash" },
      "pi",
      "deepseek-v4-flash",
    ),
    true,
  );
  assert.equal(
    matchesModelSelection(
      { providerId: "codex", model: "ds4/deepseek-v4-flash" },
      "pi",
      "ds4/",
    ),
    false,
  );
});

test("does not match a sibling namespace", () => {
  assert.equal(
    matchesModelSelection(
      { providerId: "pi", model: "ds4-pro/deepseek-v4-flash" },
      "",
      "ds4",
    ),
    false,
  );
});

test("parses and bounds the idle timeout", () => {
  assert.equal(parseIdleTimeoutMs("30"), 30_000);
  assert.equal(parseIdleTimeoutMs("0"), 0);
  assert.equal(parseIdleTimeoutMs("not a number"), 300_000);
  assert.equal(parseIdleTimeoutMs("999999"), 24 * 60 * 60 * 1000);
});
