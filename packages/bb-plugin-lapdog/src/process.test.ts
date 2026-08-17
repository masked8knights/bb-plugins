import { describe, expect, it } from "vitest";
import {
  agentUrl,
  dashboardUrl,
  codexWatcherArgs,
  defaultCodexCursorPath,
  lapdogEnvironment,
  lapdogStartArgs,
  lapdogStopArgs,
  resolveLapdogPython,
  runCommand,
  shebangInterpreter,
  type LapdogConfig,
} from "./process";

const config: LapdogConfig = {
  command: "lapdog",
  apmPort: 8126,
  otlpHttpPort: 4318,
  otlpGrpcPort: 4317,
  forwardToDatadog: false,
  captureCodexSessions: true,
  replayRecentSeconds: 3_600,
};

describe("Lapdog process configuration", () => {
  it("uses the official local agent and dashboard endpoints", () => {
    expect(agentUrl(8126)).toBe("http://127.0.0.1:8126");
    expect(dashboardUrl(8126)).toBe("https://lapdog.datadoghq.com/");
    expect(dashboardUrl(9000)).toBe("https://lapdog.datadoghq.com/?portOverride=9000");
  });

  it("preserves the host environment while configuring Lapdog ports", () => {
    const env = lapdogEnvironment(config, { PATH: "/bin", DD_SITE: "datadoghq.com" });
    expect(env).toMatchObject({
      PATH: "/bin",
      DD_SITE: "datadoghq.com",
      PORT: "8126",
      OTLP_HTTP_PORT: "4318",
      OTLP_GRPC_PORT: "4317",
    });
  });

  it("uses the official CLI subcommands", () => {
    expect(lapdogStartArgs(false)).toEqual(["start"]);
    expect(lapdogStartArgs(true)).toEqual(["--forward", "start"]);
    expect(lapdogStopArgs()).toEqual(["stop"]);
  });

  it("starts the official Codex JSONL watcher in all-cwd mode", () => {
    expect(
      codexWatcherArgs({
        apmPort: 8126,
        cwd: "/workspace",
        parentPid: 123,
        replayRecentSeconds: 3_600,
        cursorPath: "/tmp/bb-codex-cursor.json",
      }),
    ).toEqual([
      "-m",
      "lapdog.codex_watcher",
      "--lapdog-url",
      "http://127.0.0.1:8126",
      "--cwd",
      "/workspace",
      "--parent-pid",
      "123",
      "--replay-recent-seconds",
      "3600",
      "--include-all-cwds",
      "--cursor-path",
      "/tmp/bb-codex-cursor.json",
    ]);
    expect(defaultCodexCursorPath("/Users/tester")).toBe(
      "/Users/tester/.lapdog/bb-codex-cursor.json",
    );
  });

  it("understands the official pipx launcher shebang", () => {
    expect(shebangInterpreter("#!/Users/tester/.local/pipx/bin/python")).toBe(
      "/Users/tester/.local/pipx/bin/python",
    );
    expect(shebangInterpreter("#!/usr/bin/env -S python3 -u")).toBe("python3");
    expect(shebangInterpreter("not a shebang")).toBeNull();
  });

  it("returns null when the configured Lapdog executable is missing", async () => {
    await expect(resolveLapdogPython("/definitely/missing/lapdog")).resolves.toBeNull();
  });

  it("returns a missing-command error without throwing", async () => {
    const result = await runCommand("/definitely/missing/lapdog", [], process.env, 250);
    expect(result.exitCode).not.toBe(0);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as NodeJS.ErrnoException).code).toBe("ENOENT");
  });
});
