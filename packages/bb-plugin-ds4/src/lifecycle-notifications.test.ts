import assert from "node:assert/strict";
import test from "node:test";
import {
  ds4LifecycleNotice,
  ds4LifecyclePhase,
} from "./lifecycle-notifications.ts";

test("maps process and health state to lifecycle phases", () => {
  assert.equal(
    ds4LifecyclePhase({ state: "starting" }),
    "starting",
  );
  assert.equal(
    ds4LifecyclePhase({ state: "running" }),
    "starting",
  );
  assert.equal(
    ds4LifecyclePhase({ state: "running", healthOk: true }),
    "ready",
  );
  assert.equal(
    ds4LifecyclePhase({ state: "running", hasError: true }),
    "error",
  );
  assert.equal(
    ds4LifecyclePhase({ state: "stopped" }),
    "stopped",
  );
  assert.equal(
    ds4LifecyclePhase({ state: "stopped", hasError: true }),
    "error",
  );
  assert.equal(
    ds4LifecyclePhase({ state: "stopping" }),
    "stopping",
  );
  assert.equal(
    ds4LifecyclePhase({ state: "crashed" }),
    "error",
  );
});

test("suppresses a ready or stopped toast for an initial status snapshot", () => {
  assert.equal(
    ds4LifecycleNotice("ready", null, { initial: true }),
    null,
  );
  assert.equal(
    ds4LifecycleNotice("stopped", null, { initial: true }),
    null,
  );
  assert.equal(
    ds4LifecycleNotice("starting", null, { initial: true })?.kind,
    "loading",
  );
  assert.equal(
    ds4LifecycleNotice("error", null, {
      initial: true,
      error: "binary missing",
    })?.kind,
    "error",
  );
});

test("creates notices only when the lifecycle phase changes", () => {
  assert.equal(ds4LifecycleNotice("starting", "starting"), null);
  assert.match(
    ds4LifecycleNotice("starting", null)?.description ?? "",
    /try again/i,
  );
  assert.equal(
    ds4LifecycleNotice("ready", "starting")?.title,
    "DwarfStar ready",
  );
  assert.equal(
    ds4LifecycleNotice("stopping", "ready")?.kind,
    "loading",
  );
  assert.match(
    ds4LifecycleNotice("error", "starting", { error: "binary missing" })
      ?.description ?? "",
    /binary missing.*try again/i,
  );
});
