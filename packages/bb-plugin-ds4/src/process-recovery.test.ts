import assert from "node:assert/strict";
import { test } from "node:test";
import { Ds4Process } from "./ds4-process.ts";
import { parseExistingDs4Pid } from "./process-recovery.ts";

test("extracts a conflicting ds4-server PID from process output", () => {
  assert.equal(
    parseExistingDs4Pid("ds4: another ds4 process is already running (pid 74058); refusing to start"),
    74058,
  );
  assert.equal(parseExistingDs4Pid("server is loading"), null);
});

test("does not terminate an externally-owned adopted server", async () => {
  const proc = new Ds4Process();
  proc.adopt(process.pid, { ownership: "external" });

  assert.equal(proc.state, "running");
  assert.equal(proc.isExternal, true);
  await proc.stop(1);
  assert.equal(proc.state, "running");

  proc.detachExternal();
  assert.equal(proc.state, "exited");
  assert.equal(proc.pid, null);
});

test("clears the PID after a managed process exits unexpectedly", async () => {
  const proc = new Ds4Process();
  const exited = new Promise<void>((resolve) => {
    proc.start({
      bin: process.execPath,
      args: ["-e", "process.exit(2)"],
      cwd: process.cwd(),
      onExit: () => resolve(),
    });
  });
  await exited;

  assert.equal(proc.state, "crashed");
  assert.equal(proc.pid, null);
  assert.equal(proc.startedAt, null);
});
