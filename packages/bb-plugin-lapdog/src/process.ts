import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export const DASHBOARD_ORIGIN = "https://lapdog.datadoghq.com";

export type LapdogConfig = {
  command: string;
  apmPort: number;
  otlpHttpPort: number;
  otlpGrpcPort: number;
  forwardToDatadog: boolean;
  captureCodexSessions: boolean;
  replayRecentSeconds: number;
};

export type CodexWatcherOptions = {
  apmPort: number;
  cwd: string;
  parentPid: number;
  replayRecentSeconds: number;
  cursorPath?: string;
  sessionDir?: string;
};

export type CommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: Error | null;
};

export type AgentHealth = {
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  info: Record<string, unknown> | null;
  error: string | null;
};

export function agentUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function dashboardUrl(port: number): string {
  const url = new URL(DASHBOARD_ORIGIN);
  if (port !== 8126) url.searchParams.set("portOverride", String(port));
  return url.toString();
}

export function lapdogEnvironment(
  config: LapdogConfig,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    PORT: String(config.apmPort),
    OTLP_HTTP_PORT: String(config.otlpHttpPort),
    OTLP_GRPC_PORT: String(config.otlpGrpcPort),
  };
}

export function lapdogStartArgs(forwardToDatadog: boolean): string[] {
  // The official CLI disables forwarding by default. Its --forward option
  // enables forwarding while preserving the local agent and dashboard.
  return forwardToDatadog ? ["--forward", "start"] : ["start"];
}

export function lapdogStopArgs(): string[] {
  return ["stop"];
}

export function codexWatcherArgs(options: CodexWatcherOptions): string[] {
  const args = [
    "-m",
    "lapdog.codex_watcher",
    "--lapdog-url",
    agentUrl(options.apmPort),
    "--cwd",
    options.cwd,
    "--parent-pid",
    String(options.parentPid),
    "--replay-recent-seconds",
    String(options.replayRecentSeconds),
    // BB can host workspaces from more than one project. The official
    // watcher normally scopes by cwd, but the local BB integration needs one
    // stream for all Codex sessions written by this user.
    "--include-all-cwds",
  ];
  if (options.sessionDir) args.push("--session-dir", options.sessionDir);
  if (options.cursorPath) args.push("--cursor-path", options.cursorPath);
  return args;
}

export function defaultCodexCursorPath(home = homedir()): string {
  // Keep BB's watcher cursor separate from a watcher started by `lapdog codex`
  // itself. Both are safe to run, and the local agent deduplicates records.
  return join(home, ".lapdog", "bb-codex-cursor.json");
}

export function shebangInterpreter(firstLine: string): string | null {
  const match = firstLine.trim().match(/^#!\s*(.*)$/);
  if (!match) return null;
  const command = match[1].trim();
  if (!command) return null;

  // Support both a direct shebang (`#!/path/to/python`) and env-style
  // shebangs (`#!/usr/bin/env python3`, including env -S).
  const envMatch = command.match(/^\/usr\/bin\/env\s+(?:-S\s+)?([^\s]+)/);
  return envMatch?.[1] ?? command.split(/\s+/)[0] ?? null;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const candidate = command.trim();
  if (!candidate) return null;

  if (isAbsolute(candidate) || candidate.includes("/")) {
    return (await isExecutable(candidate)) ? candidate : null;
  }

  const pathEntries = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .concat(
      // BB's packaged server can have a narrower PATH than the interactive
      // shell that installed pipx packages. These are only fallback lookup
      // locations; an explicit setting always wins above.
      join(homedir(), ".local", "bin"),
      join(homedir(), "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    );
  for (const directory of pathEntries) {
    const path = join(directory, candidate);
    if (await isExecutable(path)) return path;
  }
  return null;
}

export async function resolveLapdogPython(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const executable = await resolveExecutable(command, env);
  if (!executable) return null;

  try {
    const firstLine = (await readFile(executable, "utf8")).split(/\r?\n/, 1)[0] ?? "";
    const interpreter = shebangInterpreter(firstLine);
    if (interpreter) {
      if (isAbsolute(interpreter)) return (await isExecutable(interpreter)) ? interpreter : null;
      return resolveExecutable(interpreter, env);
    }
  } catch {
    // A compiled `lapdog` executable has no Python shebang. Fall through to a
    // normal Python lookup; if the package is not importable there, capture is
    // reported as unavailable rather than taking down the agent integration.
  }

  return (await resolveExecutable("python3", env)) ?? resolveExecutable("python", env);
}

export function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 20_000,
  cwd?: string,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let error: Error | null = null;
    let settled = false;
    let timedOut = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        env,
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        error: cause instanceof Error ? cause : new Error(String(cause)),
      });
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (cause) => {
      error = cause;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut && !error) error = new Error(`Command timed out after ${timeoutMs}ms`);
      resolve({ exitCode, signal, stdout, stderr, error });
    };

    child.once("close", (exitCode, signal) => finish(exitCode, signal));
  });
}

export async function readAgentHealth(port: number, timeoutMs = 1_500): Promise<AgentHealth> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${agentUrl(port)}/info`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    const body = await response.text();
    let info: Record<string, unknown> | null = null;
    if (body) {
      try {
        const parsed: unknown = JSON.parse(body);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          info = parsed as Record<string, unknown>;
        }
      } catch {
        // The status response is still useful even when /info is not JSON.
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      info,
      error: response.ok ? null : `Lapdog returned HTTP ${response.status}`,
    };
  } catch (cause) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      info: null,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForAgent(
  port: number,
  timeoutMs = 12_000,
): Promise<AgentHealth> {
  const deadline = Date.now() + timeoutMs;
  let health = await readAgentHealth(port);
  while (!health.ok && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    health = await readAgentHealth(port);
  }
  return health;
}
