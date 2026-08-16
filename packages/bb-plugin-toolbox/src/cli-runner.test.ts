import { describe, expect, it } from "vitest";
import { renderCliArgs, runCliSource, runCliTool } from "./cli-runner";
import type { CliSourceRecord, CliToolRecord } from "./types";

const baseTool: CliToolRecord = {
  id: "cli_test",
  name: "echo_json",
  description: "Echo JSON",
  command: process.execPath,
  argsTemplate: ["-e", "process.stdout.write(process.argv[1] ?? '')", "{{value}}"],
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  cwd: null,
  env: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

describe("CLI tool runner", () => {
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

  it("renders exact and expanded placeholders without a shell", () => {
    expect(renderCliArgs(["--name", "{{name}}", "{{args:tags}}"], { name: "Ada", tags: ["one", "two"] })).toEqual([
      "--name",
      "Ada",
      "one",
      "two",
    ]);
  });

  it("validates input and captures stdout and exit code", async () => {
    const result = await runCliTool(baseTool, { value: "hello" }, { timeoutMs: 5_000, maxOutputBytes: 10_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.argv.at(-1)).toBe("hello");
  });

  it("rejects invalid input before starting the process", async () => {
    await expect(runCliTool(baseTool, {}, { timeoutMs: 5_000, maxOutputBytes: 10_000 })).rejects.toThrow("does not match its schema");
  });

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
    const hangingTool: CliToolRecord = {
      ...baseTool,
      argsTemplate: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      inputSchema: { type: "object" },
    };

    await expect(runCliTool(hangingTool, {}, { timeoutMs: 50, maxOutputBytes: 10_000 })).rejects.toThrow("timed out");
  });
});
