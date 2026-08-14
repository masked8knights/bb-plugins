import { describe, expect, it } from "vitest";
import { renderCliArgs, runCliTool } from "./cli-runner";
import type { CliToolRecord } from "./types";

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
