import { describe, expect, it } from "vitest";
import { runCliSource } from "./cli-runner";
import type { CliSourceRecord } from "./types";

const rawSource: CliSourceRecord = {
  id: "cli_source_test",
  name: "raw_echo",
  description: "Raw echo CLI",
  command: process.execPath,
  cwd: null,
  env: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

describe("CLI source runner", () => {
  it("runs a raw CLI source with direct argv and no template", async () => {
    const result = await runCliSource(
      rawSource,
      { argv: ["-e", "process.stdout.write(process.argv[1] ?? '')", "hello from raw cli"] },
      { timeoutMs: 5_000, maxOutputBytes: 10_000 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello from raw cli");
    expect(result.argv).toEqual(["-e", "process.stdout.write(process.argv[1] ?? '')", "hello from raw cli"]);
  });

  it("passes shell-shaped text as a literal argument and rejects invalid raw argv", async () => {
    const literal = await runCliSource(rawSource, { argv: ["-e", "process.stdout.write(process.argv[1] ?? '')", "echo hi | cat"] }, { timeoutMs: 5_000, maxOutputBytes: 10_000 });
    expect(literal.stdout).toBe("echo hi | cat");
    await expect(runCliSource(rawSource, { argv: [], extra: true }, { timeoutMs: 5_000, maxOutputBytes: 10_000 })).rejects.toThrow("only accepts");
    await expect(runCliSource(rawSource, { argv: ["-e", "x", "\u0000"] }, { timeoutMs: 5_000, maxOutputBytes: 10_000 })).rejects.toThrow("null byte");
    await expect(runCliSource(rawSource, { argv: Array.from({ length: 129 }, () => "x") }, { timeoutMs: 5_000, maxOutputBytes: 10_000 })).rejects.toThrow("more than 128");
  });

  it("force-kills a process that ignores SIGTERM after a timeout", async () => {
    if (process.platform === "win32") return;
    const hangingSource: CliSourceRecord = {
      ...rawSource,
      name: "hanging_echo",
    };

    await expect(runCliSource(
      hangingSource,
      { argv: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"] },
      { timeoutMs: 50, maxOutputBytes: 10_000 },
    )).rejects.toThrow("timed out");
  });
});
