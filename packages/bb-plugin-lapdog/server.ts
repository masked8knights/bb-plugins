import { spawn, type ChildProcess } from "node:child_process";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  agentUrl,
  codexWatcherArgs,
  defaultCodexCursorPath,
  dashboardUrl,
  lapdogEnvironment,
  lapdogStartArgs,
  lapdogStopArgs,
  readAgentHealth,
  resolveExecutable,
  resolveLapdogPython,
  runCommand,
  waitForAgent,
  type AgentHealth,
  type LapdogConfig,
} from "./src/process";

const stateSchema = z.enum(["running", "starting", "stopped", "not-installed", "error"]);
const captureStateSchema = z.enum([
  "running",
  "starting",
  "stopped",
  "disabled",
  "unavailable",
  "error",
]);
const statusSchema = z.object({
  state: stateSchema,
  agentUrl: z.string(),
  otlpHttpUrl: z.string(),
  otlpGrpcUrl: z.string(),
  dashboardUrl: z.string(),
  command: z.string(),
  autoStart: z.boolean(),
  forwardToDatadog: z.boolean(),
  capture: z.object({
    state: captureStateSchema,
    source: z.literal("Codex JSONL"),
    hookUrl: z.string(),
    pid: z.number().nullable(),
    cursorPath: z.string(),
    replayRecentSeconds: z.number(),
    error: z.string().nullable(),
  }),
  health: z.object({
    ok: z.boolean(),
    status: z.number().nullable(),
    latencyMs: z.number().nullable(),
    info: z.record(z.string(), z.unknown()).nullable(),
    error: z.string().nullable(),
  }),
  error: z.string().nullable(),
  checkedAt: z.number(),
});

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: statusSchema },
  start: { input: z.null(), output: statusSchema },
  stop: { input: z.null(), output: statusSchema },
  restart: { input: z.null(), output: statusSchema },
});

export type LapdogStatus = z.infer<typeof statusSchema>;

const DEFAULT_APM_PORT = 8126;
const DEFAULT_OTLP_HTTP_PORT = 4318;
const DEFAULT_OTLP_GRPC_PORT = 4317;

type Runtime = {
  phase: "stopped" | "starting" | "running" | "error";
  lastError: string | null;
  commandMissing: boolean;
  nextAutoStartAt: number;
  startedByPlugin: boolean;
  operation: Promise<unknown> | null;
  capture: {
    phase: "stopped" | "starting" | "running" | "stopping" | "unavailable" | "error";
    lastError: string | null;
    child: ChildProcess | null;
    configKey: string | null;
    nextRetryAt: number;
  };
};

function port(value: string, fallback: number): number {
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function seconds(value: string, fallback: number): number {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 365 * 24 * 60 * 60 ? parsed : fallback;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    command: {
      type: "string",
      label: "Lapdog executable",
      description: "The official lapdog command or an absolute path to it.",
      default: "lapdog",
    },
    autoStart: {
      type: "boolean",
      label: "Auto-start Lapdog when BB launches",
      default: true,
    },
    forwardToDatadog: {
      type: "boolean",
      label: "Forward LLM Observability data to Datadog",
      description: "Off by default. When enabled, Lapdog uses DD_API_KEY and DD_SITE from BB's server environment.",
      default: false,
    },
    captureCodexSessions: {
      type: "boolean",
      label: "Capture BB Codex sessions locally",
      description: "Run Datadog's official Codex JSONL watcher and post records to the local Lapdog agent.",
      default: true,
    },
    replayRecentSeconds: {
      type: "string",
      label: "Replay recent Codex sessions (seconds)",
      description: "How far back the official watcher replays existing JSONL files when it starts. 0 means new records only.",
      default: "3600",
    },
    apmPort: {
      type: "string",
      label: "Lapdog APM port",
      description: "The local agent port used by the official dashboard and DD_TRACE_AGENT_URL.",
      default: String(DEFAULT_APM_PORT),
    },
    otlpHttpPort: {
      type: "string",
      label: "Lapdog OTLP HTTP port",
      default: String(DEFAULT_OTLP_HTTP_PORT),
    },
    otlpGrpcPort: {
      type: "string",
      label: "Lapdog OTLP gRPC port",
      default: String(DEFAULT_OTLP_GRPC_PORT),
    },
  });

  const runtime: Runtime = {
    phase: "stopped",
    lastError: null,
    commandMissing: false,
    nextAutoStartAt: 0,
    startedByPlugin: false,
    operation: null,
    capture: {
      phase: "stopped",
      lastError: null,
      child: null,
      configKey: null,
      nextRetryAt: 0,
    },
  };

  async function config(): Promise<LapdogConfig> {
    const current = await settings.get();
    return {
      command: current.command.trim() || "lapdog",
      apmPort: port(current.apmPort, DEFAULT_APM_PORT),
      otlpHttpPort: port(current.otlpHttpPort, DEFAULT_OTLP_HTTP_PORT),
      otlpGrpcPort: port(current.otlpGrpcPort, DEFAULT_OTLP_GRPC_PORT),
      forwardToDatadog: current.forwardToDatadog,
      captureCodexSessions: current.captureCodexSessions,
      replayRecentSeconds: seconds(current.replayRecentSeconds, 3_600),
    };
  }

  async function health(current: LapdogConfig): Promise<AgentHealth> {
    return readAgentHealth(current.apmPort);
  }

  async function status(): Promise<LapdogStatus> {
    const current = await config();
    const stored = await settings.get();
    const currentHealth = await health(current);
    let state: LapdogStatus["state"];
    if (currentHealth.ok) state = "running";
    else if (runtime.phase === "starting") state = "starting";
    else if (runtime.commandMissing) state = "not-installed";
    else if (runtime.lastError) state = "error";
    else state = "stopped";

    return {
      state,
      agentUrl: agentUrl(current.apmPort),
      otlpHttpUrl: `http://127.0.0.1:${current.otlpHttpPort}`,
      otlpGrpcUrl: `http://127.0.0.1:${current.otlpGrpcPort}`,
      dashboardUrl: dashboardUrl(current.apmPort),
      command: current.command,
      autoStart: stored.autoStart,
      forwardToDatadog: current.forwardToDatadog,
      capture: {
        state: current.captureCodexSessions
          ? runtime.capture.phase === "stopping"
            ? "starting"
            : runtime.capture.phase
          : "disabled",
        source: "Codex JSONL",
        hookUrl: `${agentUrl(current.apmPort)}/codex/hooks`,
        pid: runtime.capture.child?.pid ?? null,
        cursorPath: defaultCodexCursorPath(),
        replayRecentSeconds: current.replayRecentSeconds,
        error: current.captureCodexSessions ? runtime.capture.lastError : null,
      },
      health: currentHealth,
      error: currentHealth.ok ? null : runtime.lastError ?? currentHealth.error,
      checkedAt: Date.now(),
    };
  }

  async function publish(): Promise<void> {
    try {
      bb.realtime.publish("lapdog", await status());
    } catch {
      // Realtime is best-effort; the panel can always call status directly.
    }
  }

  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (runtime.operation) return runtime.operation as Promise<T>;
    const current = operation();
    const tracked = current.finally(() => {
      runtime.operation = null;
    });
    // The caller owns the operation's result. Keep the bookkeeping promise
    // from becoming an unhandled rejection when the caller handles the error.
    tracked.catch(() => undefined);
    runtime.operation = tracked;
    return current;
  }

  function captureConfigKey(current: LapdogConfig): string {
    return [
      current.command,
      current.apmPort,
      current.replayRecentSeconds,
      defaultCodexCursorPath(),
    ].join("\u0000");
  }

  async function stopCodexCapture(): Promise<void> {
    const child = runtime.capture.child;
    if (!child) {
      runtime.capture.phase = "stopped";
      runtime.capture.configKey = null;
      return;
    }

    runtime.capture.phase = "stopping";
    await new Promise<void>((resolve) => {
      let settled = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (forceKillTimer) clearTimeout(forceKillTimer);
        resolve();
      };
      child.once("close", finish);
      child.once("error", finish);
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
      }
      forceKillTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch {
          // The process already exited.
        }
        finish();
      }, 3_000);
      if (child.exitCode !== null || child.signalCode !== null) finish();
    });

    runtime.capture.child = null;
    runtime.capture.phase = "stopped";
    runtime.capture.lastError = null;
    runtime.capture.configKey = null;
    runtime.capture.nextRetryAt = 0;
  }

  async function ensureCodexCapture(current: LapdogConfig, force = false): Promise<void> {
    if (!current.captureCodexSessions) {
      await stopCodexCapture();
      return;
    }

    const key = captureConfigKey(current);
    const child = runtime.capture.child;
    const childRunning = child !== null && child.exitCode === null && child.signalCode === null;
    if (!force && childRunning && runtime.capture.configKey === key) {
      runtime.capture.phase = "running";
      return;
    }
    if (!force && Date.now() < runtime.capture.nextRetryAt) return;
    if (child) await stopCodexCapture();

    runtime.capture.phase = "starting";
    runtime.capture.lastError = null;
    runtime.capture.configKey = key;
    await publish();

    const env = lapdogEnvironment(current);
    const python = await resolveLapdogPython(current.command, env);
    if (!python) {
      runtime.capture.phase = "unavailable";
      runtime.capture.configKey = null;
      runtime.capture.lastError =
        `Could not find the Python environment behind ${current.command}; install ddapm-test-agent or set Lapdog executable to its official path.`;
      runtime.capture.nextRetryAt = Date.now() + 30_000;
      return;
    }

    const args = codexWatcherArgs({
      apmPort: current.apmPort,
      cwd: process.cwd(),
      parentPid: process.pid,
      replayRecentSeconds: current.replayRecentSeconds,
      cursorPath: defaultCodexCursorPath(),
    });

    let watcher: ChildProcess;
    try {
      watcher = spawn(python, args, {
        cwd: process.cwd(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      runtime.capture.phase = "error";
      runtime.capture.configKey = null;
      runtime.capture.lastError = errorText(cause);
      runtime.capture.nextRetryAt = Date.now() + 30_000;
      return;
    }

    runtime.capture.child = watcher;
    runtime.capture.phase = "running";
    runtime.capture.nextRetryAt = 0;

    // Drain both pipes so a verbose official watcher can never block on a
    // full stdio buffer. Its ready/error lines remain available in plugin logs.
    watcher.stdout?.setEncoding("utf8");
    watcher.stderr?.setEncoding("utf8");
    watcher.stdout?.on("data", (chunk: string) => {
      const line = chunk.trim();
      if (line) bb.log.debug(`Codex capture: ${line}`);
    });
    watcher.stderr?.on("data", (chunk: string) => {
      const line = chunk.trim();
      if (!line) return;
      if (/error|failed|cannot|could not/i.test(line)) bb.log.warn(`Codex capture: ${line}`);
      else bb.log.debug(`Codex capture: ${line}`);
    });

    let childError: Error | null = null;
    watcher.once("error", (cause) => {
      childError = cause instanceof Error ? cause : new Error(String(cause));
      if (runtime.capture.child !== watcher) return;
      runtime.capture.phase = "error";
      runtime.capture.lastError = childError.message;
      runtime.capture.nextRetryAt = Date.now() + 30_000;
      void publish();
    });
    watcher.once("close", (exitCode, signal) => {
      if (runtime.capture.child !== watcher) return;
      runtime.capture.child = null;
      runtime.capture.configKey = null;
      if (runtime.capture.phase === "stopping" || signal === "SIGTERM" || signal === "SIGKILL") {
        runtime.capture.phase = "stopped";
        runtime.capture.lastError = null;
      } else if (exitCode === 0) {
        runtime.capture.phase = "stopped";
        runtime.capture.lastError = null;
      } else {
        runtime.capture.phase = "error";
        runtime.capture.lastError =
          childError?.message ?? `The official Codex watcher exited with code ${exitCode ?? "unknown"}.`;
        runtime.capture.nextRetryAt = Date.now() + 30_000;
      }
      void publish();
    });
  }

  async function start(): Promise<void> {
    await exclusive(async () => {
      const current = await config();
      const existing = await health(current);
      if (existing.ok) {
        runtime.phase = "running";
        runtime.lastError = null;
        runtime.commandMissing = false;
        runtime.nextAutoStartAt = 0;
        runtime.capture.nextRetryAt = 0;
        await ensureCodexCapture(current, true);
        return;
      }

      runtime.phase = "starting";
      runtime.lastError = null;
      runtime.commandMissing = false;
      runtime.nextAutoStartAt = 0;
      await publish();

      const environment = lapdogEnvironment(current);
      const executable = await resolveExecutable(current.command, environment);
      const result = await runCommand(
        executable ?? current.command,
        lapdogStartArgs(current.forwardToDatadog),
        environment,
      );
      if (result.error) {
        const code = (result.error as NodeJS.ErrnoException).code;
        runtime.commandMissing = code === "ENOENT" || code === "EACCES";
        if (runtime.commandMissing) runtime.nextAutoStartAt = Date.now() + 30_000;
        throw new Error(
          runtime.commandMissing
            ? `Lapdog CLI not found: ${current.command}. Install ddapm-test-agent or set the executable path in Lapdog settings.`
            : result.error.message,
        );
      }
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || `lapdog start exited with code ${result.exitCode}`);
      }

      const ready = await waitForAgent(current.apmPort);
      if (!ready.ok) throw new Error(ready.error ?? "Lapdog did not become healthy after starting.");
      runtime.phase = "running";
      runtime.startedByPlugin = true;
      runtime.lastError = null;
      runtime.nextAutoStartAt = 0;
      runtime.capture.nextRetryAt = 0;
      await ensureCodexCapture(current, true);
    }).catch((cause) => {
      runtime.phase = "error";
      runtime.lastError = errorText(cause);
      throw cause;
    });
    await publish();
  }

  async function stop(): Promise<void> {
    await exclusive(async () => {
      const current = await config();
      await stopCodexCapture();
      const existing = await health(current);
      if (!existing.ok) {
        runtime.phase = "stopped";
        runtime.lastError = null;
        runtime.commandMissing = false;
        runtime.nextAutoStartAt = 0;
        runtime.startedByPlugin = false;
        return;
      }

      const environment = lapdogEnvironment(current);
      const executable = await resolveExecutable(current.command, environment);
      const result = await runCommand(executable ?? current.command, lapdogStopArgs(), environment);
      if (result.error) throw result.error;
      if (result.exitCode !== 0) {
        const stillRunning = await health(current);
        if (stillRunning.ok) throw new Error(result.stderr.trim() || `lapdog stop exited with code ${result.exitCode}`);
      }
      runtime.phase = "stopped";
      runtime.lastError = null;
      runtime.commandMissing = false;
      runtime.nextAutoStartAt = 0;
      runtime.startedByPlugin = false;
    }).catch((cause) => {
      runtime.phase = "error";
      runtime.lastError = errorText(cause);
      throw cause;
    });
    await publish();
  }

  async function restart(): Promise<void> {
    await stop();
    await start();
  }

  bb.rpc.register(rpcContract, {
    status,
    start: async () => {
      await start();
      return status();
    },
    stop: async () => {
      await stop();
      return status();
    },
    restart: async () => {
      await restart();
      return status();
    },
  });

  settings.onChange(() => {
    runtime.commandMissing = false;
    runtime.nextAutoStartAt = 0;
    runtime.capture.nextRetryAt = 0;
    void publish();
  });

  bb.background.service("autostart", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          const current = await config();
          const currentHealth = await health(current);
          if (currentHealth.ok) {
            runtime.phase = "running";
            runtime.lastError = null;
            runtime.commandMissing = false;
            await ensureCodexCapture(current);
          } else if (
            (await settings.get()).autoStart &&
            runtime.phase !== "starting" &&
            Date.now() >= runtime.nextAutoStartAt
          ) {
            await start();
          } else if (runtime.phase !== "starting" && !runtime.lastError) {
            await stopCodexCapture();
            runtime.phase = "stopped";
          }
          await publish();
        } catch (cause) {
          bb.log.warn(`Lapdog is not ready: ${errorText(cause)}`);
          await publish();
        }
        await sleep(2_500, signal);
      }
      await stopCodexCapture();
    },
  });

  bb.onDispose(async () => {
    await stopCodexCapture();
    if (!runtime.startedByPlugin) return;
    try {
      await stop();
    } catch (cause) {
      bb.log.warn(`Could not stop Lapdog during plugin shutdown: ${errorText(cause)}`);
    }
  });

  bb.log.info("loaded; official Lapdog agent integration enabled");
}
