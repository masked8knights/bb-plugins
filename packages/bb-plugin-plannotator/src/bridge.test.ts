import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildUpstreamInput,
  missingBinaryMessage,
  parseReadyMetadata,
  parseUpstreamDecision,
  resolvePlannotatorBinary,
} from "./bridge";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("upstream Plannotator bridge", () => {
  it("parses the ready-file record while ignoring diagnostics", () => {
    expect(
      parseReadyMetadata(
        `diagnostic\n${JSON.stringify({ url: "http://127.0.0.1:43123", isRemote: false, port: 43123 })}\n`,
      ),
    ).toEqual({
      url: "http://127.0.0.1:43123",
      isRemote: false,
      port: 43123,
    });
  });

  it("rejects malformed ready metadata", () => {
    expect(parseReadyMetadata(JSON.stringify({ url: "file:///tmp/nope", port: 12 }))).toBeNull();
    expect(parseReadyMetadata(JSON.stringify({ url: "http://127.0.0.1:12", port: 0 }))).toBeNull();
  });

  it("parses the upstream decision record and preserves feedback", () => {
    expect(
      parseUpstreamDecision(
        `informational line\n${JSON.stringify({ approved: false, feedback: "Split the risky migration step." })}\n`,
      ),
    ).toEqual({ approved: false, feedback: "Split the risky migration step." });
  });

  it("reports a useful error when upstream never returns a decision", () => {
    expect(() => parseUpstreamDecision("", "server failed to bind")).toThrow(
      /server failed to bind/u,
    );
  });

  it("builds the exact structured input expected by opencode-plan", () => {
    expect(JSON.parse(buildUpstreamInput("# Plan\n\n- Verify", 3600))).toEqual({
      plan: "# Plan\n\n- Verify",
      timeoutSeconds: 3600,
    });
  });

  it("resolves an explicit executable before PATH lookup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-plannotator-bridge-test-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "plannotator");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);

    expect(resolvePlannotatorBinary(executable, { PATH: "" })).toBe(executable);
  });

  it("explains how to install the upstream binary", () => {
    expect(missingBinaryMessage("plannotator")).toContain("github.com/backnotprop/plannotator");
  });
});
