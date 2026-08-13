import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildUpstreamInput,
  BUNDLED_BINARY,
  bundledAssetFor,
  bundledTargetFor,
  ensureBundledPlannotatorBinary,
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

  it("selects only the official supported platform targets", () => {
    expect(bundledTargetFor("darwin", "arm64")).toBe("darwin-arm64");
    expect(bundledTargetFor("win32", "x64")).toBe("win32-x64");
    expect(bundledAssetFor("linux", "arm64")?.name).toBe("plannotator-linux-arm64");
    expect(bundledTargetFor("freebsd", "x64")).toBeNull();
  });

  it("downloads, verifies, caches, and reuses the bundled runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-plannotator-bundle-test-"));
    temporaryDirectories.push(directory);
    const body = Buffer.from("official test runtime");
    const asset = {
      target: "darwin-arm64" as const,
      name: "plannotator-test-runtime",
      sha256: createHash("sha256").update(body).digest("hex"),
      sizeBytes: body.byteLength,
    };
    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount += 1;
      return new Response(body);
    };

    const first = await ensureBundledPlannotatorBinary({
      runtimeDir: directory,
      asset,
      fetchImpl,
    });
    expect(await readFile(first)).toEqual(body);

    const second = await ensureBundledPlannotatorBinary({
      runtimeDir: directory,
      asset,
      fetchImpl: async () => {
        throw new Error("cache should avoid another download");
      },
    });
    expect(second).toBe(first);
    expect(fetchCount).toBe(1);
  });

  it("redownloads a same-size cache whose contents no longer match the pin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-plannotator-bundle-integrity-"));
    temporaryDirectories.push(directory);
    const body = Buffer.from("official test runtime");
    const asset = {
      target: "darwin-arm64" as const,
      name: "plannotator-integrity-runtime",
      sha256: createHash("sha256").update(body).digest("hex"),
      sizeBytes: body.byteLength,
    };
    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount += 1;
      return new Response(body);
    };

    const binary = await ensureBundledPlannotatorBinary({
      runtimeDir: directory,
      asset,
      fetchImpl,
    });
    await writeFile(binary, Buffer.alloc(body.byteLength, 0));

    await ensureBundledPlannotatorBinary({ runtimeDir: directory, asset, fetchImpl });
    expect(fetchCount).toBe(2);
    await expect(readFile(binary)).resolves.toEqual(body);
  });

  it("does not cache a downloaded runtime with the wrong digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-plannotator-bundle-checksum-"));
    temporaryDirectories.push(directory);
    const body = Buffer.from("unexpected runtime");
    const asset = {
      target: "darwin-arm64" as const,
      name: "plannotator-bad-runtime",
      sha256: createHash("sha256").update("different runtime").digest("hex"),
      sizeBytes: body.byteLength,
    };

    await expect(
      ensureBundledPlannotatorBinary({
        runtimeDir: directory,
        asset,
        fetchImpl: async () => new Response(body),
      }),
    ).rejects.toThrow(/checksum mismatch/u);
  });

  it("resolves an explicit executable before PATH lookup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-plannotator-bridge-test-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "plannotator");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);

    expect(resolvePlannotatorBinary(executable, { PATH: "" })).toBe(executable);
  });

  it("explains the bundled runtime and external override", () => {
    expect(missingBinaryMessage(BUNDLED_BINARY)).toContain("SHA-256");
    expect(missingBinaryMessage("plannotator")).toContain("bundled");
  });
});
