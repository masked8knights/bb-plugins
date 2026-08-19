// bb-plugin-ds4 — admin a local DwarfStar (antirez/ds4) inference server from
// BB: run/stop/restart ds4-server, tail its logs, watch health, write agent
// provider configs (pi / opencode / Codex CLI), and expose the local model to
// BB agents through native tools and a `bb ds4` CLI.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  Ds4Process,
  type Ds4LogLine,
  type ProcessState,
} from "./src/ds4-process";
import {
  resolveConfig,
  agentCommand,
  shellQuote,
  type BackendChoice,
  type ResolvedRunConfig,
  type RunSettings,
} from "./src/run-config";
import {
  allStatuses,
  applyTargets,
  statusFor,
  type AgentTargetId,
} from "./src/agent-configs";
import {
  appendPersistentLog,
  persistentLogPath,
} from "./src/persistent-log";
import {
  matchesModelSelection,
  parseIdleTimeoutMs,
} from "./src/model-selection";

// ---------------------------------------------------------------------------
// Schemas / contract
// ---------------------------------------------------------------------------

const healthSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().optional(),
  status: z.number().optional(),
  error: z.string().optional(),
  models: z.array(z.string()),
  at: z.number(),
});
const configSchema = z.object({
  ds4Dir: z.string().nullable(),
  bin: z.string().nullable(),
  args: z.array(z.string()),
  modelPath: z.string().nullable(),
  host: z.string(),
  port: z.number(),
  ctx: z.number(),
  maxTokens: z.number(),
  backend: z.string(),
  dspark: z.boolean(),
  dsparkSupportPath: z.string().nullable(),
  dsparkConfidence: z.number(),
  fingerprint: z.string(),
});
const statusSchema = z.object({
  state: z.enum(["stopped", "starting", "running", "stopping", "exited", "crashed"]),
  displayState: z.string(),
  pid: z.number().nullable(),
  startedAt: z.number().nullable(),
  uptimeMs: z.number(),
  exitInfo: z
    .object({ code: z.number().nullable(), signal: z.string().nullable(), at: z.number() })
    .nullable(),
  health: healthSchema.nullable(),
  config: configSchema,
  settings: z.object({
    providerId: z.string(),
    modelSelector: z.string(),
    idleTimeoutSeconds: z.string(),
    restartOnCrash: z.boolean(),
    configurePi: z.boolean(),
    configureOpencode: z.boolean(),
    configureCodex: z.boolean(),
    maxTokens: z.string(),
  }),
  lastError: z.string().nullable(),
  log: z.object({ total: z.number(), limit: z.number(), file: z.string() }),
});
const logsSchema = z.object({
  lines: z.array(
    z.object({
      seq: z.number(),
      ts: z.number(),
      stream: z.enum(["stdout", "stderr"]),
      text: z.string(),
    }),
  ),
  nextOffset: z.number(),
  total: z.number(),
  firstSeq: z.number(),
});
const agentTargetStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  path: z.string(),
  exists: z.boolean(),
  configured: z.boolean(),
  detail: z.string(),
  error: z.string().optional(),
});
const applyResultSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  path: z.string().optional(),
  backup: z.string().optional(),
  message: z.string(),
});

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: statusSchema },
  start: { input: z.null(), output: statusSchema },
  stop: { input: z.null(), output: statusSchema },
  restart: { input: z.null(), output: statusSchema },
  logs: {
    input: z
      .object({
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(5000).optional(),
      })
      .strict(),
    output: logsSchema,
  },
  clearLogs: { input: z.null(), output: z.object({ total: z.number() }) },
  agentConfigs: {
    input: z.null(),
    output: z.object({ targets: z.array(agentTargetStatusSchema) }),
  },
  applyAgentConfigs: {
    input: z
      .object({ targets: z.array(z.enum(["pi", "opencode", "codex"])) })
      .strict(),
    output: z.object({ results: z.array(applyResultSchema) }),
  },
  launchAgent: {
    input: z.null(),
    output: z.object({ terminalId: z.string(), title: z.string() }),
  },
  complete: {
    input: z
      .object({
        prompt: z.string().min(1),
        system: z.string().optional(),
        maxTokens: z.number().int().min(1).max(16384).default(1024),
        temperature: z.number().min(0).max(2).optional(),
      })
      .strict(),
    output: z.object({ text: z.string() }),
  },
});

export type StatusDto = z.infer<typeof statusSchema>;

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

const LOG_RING_LIMIT = 5000;

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    ds4Dir: {
      type: "string",
      label: "DS4 checkout directory",
      description:
        "Directory containing ds4-server. Empty = auto-detect (DS4_DIR, ~/workingdir/ds4, ~/ds4, …).",
      default: "",
    },
    modelPath: {
      type: "string",
      label: "Model GGUF path",
      description: "Absolute path, or relative to the DS4 directory. Empty = ds4flash.gguf.",
      default: "",
    },
    modelSelector: {
      type: "string",
      label: "BB model selector",
      description:
        "Exact model id or namespace used in BB's model picker. The default `ds4/` matches `ds4/deepseek-v4-flash`.",
      default: "ds4/",
    },
    providerId: {
      type: "string",
      label: "BB provider filter (optional)",
      description:
        "Leave empty to match the model across providers; set this only when the same model id is used elsewhere.",
      default: "",
    },
    idleTimeoutSeconds: {
      type: "string",
      label: "Stop after idle (seconds)",
      description:
        "After the last DS4 turn finishes, keep the model warm for this long before stopping the local server. Default: 300.",
      default: "300",
    },
    backend: {
      type: "select",
      label: "Backend",
      description: "metal/cuda/cpu; auto lets ds4-server pick.",
      options: ["auto", "metal", "cuda", "cpu"],
      default: "auto",
    },
    host: { type: "string", label: "Bind host", default: "127.0.0.1" },
    port: { type: "string", label: "Port", default: "8000" },
    ctx: {
      type: "string",
      label: "Context tokens (-c)",
      description: "Server context window AND the client-side contextWindow written to agent configs. Restarts the server on change.",
      default: "100000",
    },
    maxTokens: {
      type: "string",
      label: "Default max output tokens (-n)",
      description: "Default output limit for the server and the maxTokens/output limit written to agent configs.",
      default: "384000",
    },
    kvDiskDir: {
      type: "string",
      label: "KV disk cache dir",
      description: "Empty disables disk KV caching.",
      default: "/tmp/ds4-kv",
    },
    kvDiskSpaceMb: {
      type: "string",
      label: "KV disk budget (MB)",
      default: "8192",
    },
    power: {
      type: "string",
      label: "GPU duty cycle (--power, 1-100)",
      description: "Empty = default (100).",
      default: "",
    },
    extraArgs: {
      type: "string",
      label: "Extra ds4-server args",
      description: "Free-form flags appended to the command line.",
      default: "",
    },
    dspark: {
      type: "boolean",
      label: "Enable DSpark speculative decoding",
      description:
        "On by default. Requires DeepSeek-V4-Flash-DSpark-support.gguf; disable only for a baseline or unsupported model.",
      default: true,
    },
    dsparkSupportPath: {
      type: "string",
      label: "DSpark support GGUF path",
      description:
        "Absolute or DS4-relative path. Empty auto-detects gguf/DeepSeek-V4-Flash-DSpark-support.gguf.",
      default: "",
    },
    dsparkConfidence: {
      type: "string",
      label: "DSpark confidence threshold",
      description: "0–1; the upstream default is 0.9.",
      default: "0.9",
    },
    restartOnCrash: {
      type: "boolean",
      label: "Restart automatically after a crash",
      default: true,
    },
    configurePi: {
      type: "boolean",
      label: "Manage Pi/BB provider config",
      description: "Included when applying agent configs (pi/bb agents).",
      default: true,
    },
    configureOpencode: {
      type: "boolean",
      label: "Manage opencode provider config",
      default: false,
    },
    configureCodex: {
      type: "boolean",
      label: "Manage Codex CLI provider config",
      default: false,
    },
  });

  const proc = new Ds4Process(LOG_RING_LIMIT);
  let lastHealth: z.infer<typeof healthSchema> | null = null;
  let lastError: string | null = null;
  type StoredSettings = Awaited<ReturnType<typeof settings.get>>;
  let latestSettings: StoredSettings = await settings.get();
  const demandThreads = new Map<string, number>();
  let lastDemandAt: number | null = null;
  let startPromise: Promise<void> | null = null;
  let stopRequested = false;

  const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });

  function toRunSettings(s: StoredSettings): RunSettings {
    latestSettings = s;
    return {
      ds4Dir: s.ds4Dir ?? "",
      modelPath: s.modelPath ?? "",
      backend: (s.backend ?? "auto") as BackendChoice,
      host: s.host ?? "127.0.0.1",
      port: s.port ?? "8000",
      ctx: s.ctx ?? "100000",
      maxTokens: s.maxTokens ?? "384000",
      kvDiskDir: s.kvDiskDir ?? "",
      kvDiskSpaceMb: s.kvDiskSpaceMb ?? "8192",
      power: s.power ?? "",
      extraArgs: s.extraArgs ?? "",
      dspark: s.dspark ?? true,
      dsparkSupportPath: s.dsparkSupportPath ?? "",
      dsparkConfidence: s.dsparkConfidence ?? "0.9",
      restartOnCrash: s.restartOnCrash ?? true,
      configurePi: s.configurePi ?? true,
      configureOpencode: s.configureOpencode ?? false,
      configureCodex: s.configureCodex ?? false,
    };
  }

  async function currentSettings(): Promise<RunSettings> {
    return toRunSettings(await settings.get());
  }

  function selectedModelIsDs4(providerId: string, model: string): boolean {
    return matchesModelSelection(
      { providerId, model },
      latestSettings.providerId ?? "",
      latestSettings.modelSelector ?? "ds4/",
    );
  }

  function idleTimeoutMs(): number {
    return parseIdleTimeoutMs(latestSettings.idleTimeoutSeconds ?? "300");
  }

  function acquireDemand(threadId: string): void {
    demandThreads.set(threadId, (demandThreads.get(threadId) ?? 0) + 1);
    lastDemandAt = Date.now();
  }

  function releaseDemand(threadId: string): void {
    const count = demandThreads.get(threadId);
    if (count === undefined) return;
    if (count > 1) demandThreads.set(threadId, count - 1);
    else demandThreads.delete(threadId);
    if (demandThreads.size === 0) lastDemandAt = Date.now();
  }

  function releaseAllDemandFor(threadId: string): void {
    if (!demandThreads.delete(threadId)) return;
    if (demandThreads.size === 0) lastDemandAt = Date.now();
  }

  function releaseAllDemand(): void {
    demandThreads.clear();
    lastDemandAt = proc.isRunning ? Date.now() : null;
  }

  async function currentConfig(): Promise<ResolvedRunConfig> {
    return resolveConfig(await currentSettings());
  }

  function dsparkSupportError(cfg: ResolvedRunConfig): string | null {
    if (!cfg.dspark) return null;
    if (!cfg.dsparkSupportPath) {
      return "DSpark is enabled but its support GGUF path could not be resolved. Set dsparkSupportPath or disable dspark.";
    }
    if (!existsSync(cfg.dsparkSupportPath)) {
      return `DSpark support GGUF not found: ${cfg.dsparkSupportPath}. Run ./download_model.sh dspark-support or set dsparkSupportPath; disable dspark only for a baseline.`;
    }
    return null;
  }

  function deriveDisplay(state: ProcessState, cfg: ResolvedRunConfig): string {
    switch (state) {
      case "stopped":
        return "stopped";
      case "starting":
        return "starting";
      case "stopping":
        return "stopping";
      case "exited":
        return "exited";
      case "crashed":
        return "crashed";
      case "running":
        return lastHealth?.ok ? "ready" : "loading model…";
    }
  }

  async function buildStatus(): Promise<StatusDto> {
    const cfg = await currentConfig();
    const s = await currentSettings();
    return {
      state: proc.state,
      displayState: deriveDisplay(proc.state, cfg),
      pid: proc.pid,
      startedAt: proc.startedAt,
      uptimeMs: proc.startedAt ? Date.now() - proc.startedAt : 0,
      exitInfo: proc.exitInfo,
      health: lastHealth,
      config: cfg,
      settings: {
        providerId: latestSettings.providerId ?? "",
        modelSelector: latestSettings.modelSelector ?? "ds4/",
        idleTimeoutSeconds: latestSettings.idleTimeoutSeconds ?? "300",
        restartOnCrash: s.restartOnCrash,
        configurePi: s.configurePi,
        configureOpencode: s.configureOpencode,
        configureCodex: s.configureCodex,
        maxTokens: s.maxTokens,
      },
      lastError,
      log: { total: proc.logs(0, 1).total, limit: LOG_RING_LIMIT, file: persistentLogPath(bb.pluginId) },
    };
  }

  async function publishState(): Promise<void> {
    try {
      bb.realtime.publish("state", await buildStatus());
    } catch {
      // best-effort
    }
  }

  async function pollHealth(cfg: ResolvedRunConfig): Promise<z.infer<typeof healthSchema> | null> {
    if (!proc.isRunning) return null;
    const url = `http://${cfg.host}:${cfg.port}/v1/models`;
    try {
      const t0 = Date.now();
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        const body = (await res.json()) as { data?: { id: string }[] };
        return {
          ok: true,
          latencyMs: Date.now() - t0,
          models: body.data?.map((m) => m.id) ?? [],
          at: Date.now(),
        };
      }
      return { ok: false, status: res.status, models: [], at: Date.now() };
    } catch (err) {
      return { ok: false, error: String(err), models: [], at: Date.now() };
    }
  }

  async function startProc(cfg: ResolvedRunConfig): Promise<void> {
    if (proc.isRunning) return;
    if (!cfg.bin || !existsSync(cfg.bin)) {
      lastError =
        "ds4-server binary not found. Set the DS4 checkout directory in Settings (or put ds4 on PATH).";
      bb.log.error(lastError);
      await publishState();
      return;
    }
    if (cfg.modelPath && !existsSync(cfg.modelPath)) {
      lastError = `Model not found: ${cfg.modelPath}. Download it first (./download_model.sh) or set modelPath.`;
      bb.log.error(lastError);
      await publishState();
      return;
    }
    const dsparkError = dsparkSupportError(cfg);
    if (dsparkError) {
      lastError = dsparkError;
      bb.log.error(lastError);
      await publishState();
      return;
    }
    lastError = null;
    lastHealth = null;
    bb.log.info(`starting ds4-server: ${cfg.bin} ${cfg.args.join(" ")}`);
    lastDemandAt ??= Date.now();
    proc.start({
      bin: cfg.bin,
      args: cfg.args,
      cwd: cfg.ds4Dir ?? homedir(),
      onLine: (line: Ds4LogLine) => {
        logFlushQueue.push(line);
        scheduleLogFlush();
      },
      onExit: (code, signal) => {
        const message = `ds4-server exited (code=${code} signal=${signal})`;
        if (stopRequested) bb.log.info(message);
        else {
          bb.log.warn(message);
          void publishState();
        }
      },
    });
    await publishState();
  }

  /** Start at most one local server process when a model call creates demand. */
  async function ensureStarted(cfg?: ResolvedRunConfig): Promise<void> {
    if (proc.isRunning) return;
    if (startPromise) return startPromise;

    startPromise = (async () => {
      if (proc.state === "stopping") await proc.stop();
      await startProc(cfg ?? (await currentConfig()));
    })().finally(() => {
      startPromise = null;
    });
    await startPromise;
  }

  /** Transition the process to stopping before broadcasting its new state. */
  async function stopProc(): Promise<void> {
    stopRequested = true;
    try {
      const stopping = proc.stop();
      await publishState();
      await stopping;
    } finally {
      stopRequested = false;
    }
  }

  // --- realtime log fan-out (batched + throttled) ---
  let logFlushQueue: Ds4LogLine[] = [];
  let logFlushTimer: NodeJS.Timeout | null = null;
  let persistedSeq = 0;

  function scheduleLogFlush(): void {
    if (logFlushTimer) return;
    logFlushTimer = setTimeout(() => {
      logFlushTimer = null;
      flushLogs();
    }, 150);
  }

  function flushLogs(): void {
    if (!logFlushQueue.length) return;
    const batch = logFlushQueue;
    logFlushQueue = [];
    try {
      bb.realtime.publish("logs", { lines: batch });
      const toPersist = batch.filter((l) => l.seq >= persistedSeq);
      if (toPersist.length) {
        persistedSeq = toPersist[toPersist.length - 1].seq + 1;
        appendPersistentLog(
          bb.pluginId,
          toPersist.map((l) => ({ ts: l.ts, stream: l.stream, text: l.text })),
        );
      }
    } catch {
      // best-effort
    }
  }

  // -------------------------------------------------------------------------
  // Supervisor service: demand-driven start, restart-on-crash, config-drift
  // restart, health polling, and idle shutdown. It always stops the server on
  // plugin reload/disable/shutdown.
  // -------------------------------------------------------------------------
  bb.background.service("supervisor", {
    start: async (signal) => {
      bb.log.info("supervisor started");
      let lastFingerprint: string | null = null;
      let crashBackoffMs = 2000;

      try {
        while (!signal.aborted) {
          const cfg = await currentConfig();
          const s = await currentSettings();
          const hasDemand = demandThreads.size > 0;

          // Config drift → restart so changes apply before the next request.
          let restartAfterDrift = false;
          if (
            proc.isRunning &&
            lastFingerprint !== null &&
            cfg.fingerprint !== lastFingerprint
          ) {
            bb.log.info("config changed — restarting ds4-server");
            restartAfterDrift = true;
            await stopProc();
            lastHealth = null;
          }
          lastFingerprint = cfg.fingerprint;

          if (
            cfg.bin &&
            hasDemand &&
            (restartAfterDrift || proc.state === "stopped" || proc.state === "exited")
          ) {
            await ensureStarted(cfg);
          }

          if (
            s.restartOnCrash &&
            hasDemand &&
            proc.state === "crashed" &&
            cfg.bin
          ) {
            const since = Date.now() - (proc.exitInfo?.at ?? 0);
            if (since >= crashBackoffMs) {
              bb.log.warn(`restarting after crash (backoff ${crashBackoffMs}ms)`);
              await ensureStarted(cfg);
            }
          }

          if (
            !hasDemand &&
            proc.isRunning &&
            lastDemandAt !== null &&
            Date.now() - lastDemandAt >= idleTimeoutMs()
          ) {
            bb.log.info("stopping ds4-server after the configured idle period");
            await stopProc();
            lastDemandAt = null;
            lastHealth = null;
            await publishState();
          }

          const health = await pollHealth(cfg);
          const previousHealth = lastHealth;
          lastHealth = health;
          const healthChanged =
            health !== null &&
            (previousHealth === null ||
              health.ok !== previousHealth.ok ||
              JSON.stringify(health.models) !== JSON.stringify(previousHealth.models));
          if (healthChanged) await publishState();
          if (health && health.ok && proc.isRunning) {
            crashBackoffMs = 2000; // healthy run resets the crash backoff
          } else if (proc.state === "crashed" && hasDemand) {
            crashBackoffMs = Math.min(30_000, crashBackoffMs * 2); // exponential
          }
          await sleep(2000, signal);
        }
      } catch (err) {
        bb.log.error(`supervisor error: ${String(err)}`);
      }

      flushLogs();
      if (proc.isRunning || proc.state === "stopping") {
        bb.log.info("stopping ds4-server (supervisor aborted)");
        await stopProc();
      }
      bb.log.info("supervisor stopped");
    },
  });

  // -------------------------------------------------------------------------
  // RPC
  // -------------------------------------------------------------------------
  bb.rpc.register(rpcContract, {
    async status() {
      return buildStatus();
    },
    async start() {
      await ensureStarted(await currentConfig());
      return buildStatus();
    },
    async stop() {
      releaseAllDemand();
      lastError = null;
      bb.log.info("manual stop requested");
      await stopProc();
      lastDemandAt = null;
      lastHealth = null;
      await publishState();
      return buildStatus();
    },
    async restart() {
      lastError = null;
      bb.log.info("manual restart requested");
      await stopProc();
      lastDemandAt = Date.now();
      await ensureStarted(await currentConfig());
      return buildStatus();
    },
    async logs({ offset, limit }) {
      return proc.logs(offset ?? 0, limit ?? 300);
    },
    async clearLogs() {
      proc.clearLogs();
      persistedSeq = 0;
      try {
        bb.realtime.publish("logs", { cleared: true, lines: [] });
      } catch {
        // ignore
      }
      return { total: 0 };
    },
    async agentConfigs() {
      return { targets: allStatuses() };
    },
    async applyAgentConfigs({ targets }) {
      const cfg = await currentConfig();
      const results = applyTargets(targets as AgentTargetId[], {
        port: cfg.port,
        ctx: cfg.ctx,
        maxTokens: cfg.maxTokens,
      });
      for (const r of results) {
        if (r.ok) bb.log.info(`agent config written: ${r.message}`);
        else bb.log.error(`agent config failed: ${r.message}`);
      }
      return { results };
    },
    async launchAgent() {
      const cfg = await currentConfig();
      return launchAgentTerminal(cfg);
    },
    async complete(params) {
      const cfg = await currentConfig();
      const text = await ds4Complete(cfg, params);
      return { text };
    },
  });

  async function launchAgentTerminal(cfg: ResolvedRunConfig): Promise<{
    terminalId: string;
    title: string;
  }> {
    const dsparkError = dsparkSupportError(cfg);
    if (dsparkError) throw new Error(dsparkError);
    const hosts = await bb.sdk.hosts.list();
    const host = hosts.find((h) => h.status === "connected") ?? hosts[0];
    if (!host) throw new Error("No connected host available for a terminal");
    const { bin, args } = agentCommand(cfg);
    const command = [bin, ...args].map(shellQuote).join(" ");
    const term = await bb.sdk.terminals.create({
      cols: 110,
      rows: 32,
      scope: { kind: "host_path", hostId: host.id, cwd: cfg.ds4Dir },
      start: { mode: "command", command },
      title: "ds4-agent",
    });
    bb.log.info(`launched interactive ds4-agent terminal ${term.id}`);
    return { terminalId: term.id, title: term.title ?? "ds4-agent" };
  }

  async function ds4Complete(
    cfg: ResolvedRunConfig,
    params: { prompt: string; system?: string; maxTokens: number; temperature?: number },
  ): Promise<string> {
    const url = `http://${cfg.host}:${cfg.port}/v1/chat/completions`;
    const messages: { role: string; content: string }[] = [];
    if (params.system) messages.push({ role: "system", content: params.system });
    messages.push({ role: "user", content: params.prompt });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer dsv4-local",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages,
        max_tokens: params.maxTokens,
        stream: false,
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ds4-server responded ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return (data.choices?.[0]?.message?.content ?? "").trim();
  }

  // -------------------------------------------------------------------------
  // CLI: `bb ds4 …`
  // -------------------------------------------------------------------------
  bb.cli.register({
    name: "ds4",
    summary: "Administer a local DwarfStar (ds4-server) inference engine",
    commands: [
      { name: "status", summary: "Show server status and health", usage: "bb ds4 status" },
      { name: "start", summary: "Start ds4-server", usage: "bb ds4 start" },
      { name: "stop", summary: "Stop ds4-server", usage: "bb ds4 stop" },
      { name: "restart", summary: "Restart ds4-server", usage: "bb ds4 restart" },
      { name: "logs", summary: "Show recent process output", usage: "bb ds4 logs [-n N]" },
      {
        name: "agents",
        summary: "Show or write agent provider configs",
        usage: "bb ds4 agents [status|apply [pi|opencode|codex ...]]",
      },
      {
        name: "agent",
        summary: "Launch the interactive ds4-agent in a BB terminal",
        usage: "bb ds4 agent",
      },
      {
        name: "complete",
        summary: "One-shot completion against the local server",
        usage: "bb ds4 complete <prompt>",
      },
    ],
    async run(argv) {
      const [cmd, ...rest] = argv;
      switch (cmd) {
        case "status":
          return { exitCode: 0, stdout: renderStatus(await buildStatus()) };
        case "start": {
          await ensureStarted(await currentConfig());
          return { exitCode: 0, stdout: renderStatus(await buildStatus()) };
        }
        case "stop": {
          releaseAllDemand();
          await stopProc();
          lastDemandAt = null;
          lastHealth = null;
          await publishState();
          return { exitCode: 0, stdout: renderStatus(await buildStatus()) };
        }
        case "restart": {
          await stopProc();
          lastDemandAt = Date.now();
          await ensureStarted(await currentConfig());
          return { exitCode: 0, stdout: renderStatus(await buildStatus()) };
        }
        case "logs": {
          let n = 100;
          for (let i = 0; i < rest.length; i++) {
            if (rest[i] === "-n" && rest[i + 1]) n = parseInt(rest[++i], 10) || 100;
          }
          const { lines } = proc.logs(0, Math.min(n, 2000));
          if (!lines.length) return { exitCode: 0, stdout: "(no log lines yet)" };
          const out = lines
            .map((l) => {
              const t = new Date(l.ts);
              const hh = String(t.getHours()).padStart(2, "0");
              const mm = String(t.getMinutes()).padStart(2, "0");
              const ss = String(t.getSeconds()).padStart(2, "0");
              return `${hh}:${mm}:${ss} [${l.stream}] ${l.text}`;
            })
            .join("\n");
          return { exitCode: 0, stdout: out };
        }
        case "agents": {
          const sub = rest[0] ?? "status";
          if (sub === "apply") {
            const cfg = await currentConfig();
            const runSettings = await currentSettings();
            const wanted = rest.slice(1);
            const targets: AgentTargetId[] =
              wanted.length === 0
                ? (["pi", "opencode", "codex"] as AgentTargetId[]).filter(
                    (t) =>
                      t === "pi"
                        ? runSettings.configurePi
                        : t === "opencode"
                          ? runSettings.configureOpencode
                          : runSettings.configureCodex,
                  )
                : (wanted as AgentTargetId[]);
            if (!targets.length) {
              return { exitCode: 1, stdout: "No targets selected. Pass ids or enable them in settings." };
            }
            const results = applyTargets(targets, {
              port: cfg.port,
              ctx: cfg.ctx,
              maxTokens: cfg.maxTokens,
            });
            const out = results
              .map((r) => `${r.ok ? "ok   " : "FAIL "} ${r.id}: ${r.message}${r.backup ? ` (backup: ${r.backup})` : ""}`)
              .join("\n");
            return { exitCode: results.every((r) => r.ok) ? 0 : 1, stdout: out };
          }
          const st = allStatuses()
            .map(
              (t) =>
                `${t.id.padEnd(8)} ${t.configured ? "configured" : "missing   "} ${t.path} — ${t.detail}`,
            )
            .join("\n");
          return { exitCode: 0, stdout: st };
        }
        case "agent": {
          try {
            const { terminalId, title } = await launchAgentTerminal(await currentConfig());
            return {
              exitCode: 0,
              stdout: `Opened terminal "${title}" (${terminalId}) in the BB terminal area.`,
            };
          } catch (err) {
            return { exitCode: 1, stdout: `Failed to launch ds4-agent: ${String(err)}` };
          }
        }
        case "complete": {
          const prompt = rest.join(" ");
          if (!prompt) {
            return {
              exitCode: 1,
              stdout: "Usage: bb ds4 complete <prompt>",
              stderr: "missing prompt",
            };
          }
          if (!(proc.state === "running" && lastHealth?.ok)) {
            return {
              exitCode: 1,
              stdout: `ds4-server is not ready (state=${proc.state}). Run \`bb ds4 start\` first.`,
            };
          }
          try {
            const text = await ds4Complete(await currentConfig(), {
              prompt,
              maxTokens: 2048,
            });
            return { exitCode: 0, stdout: text };
          } catch (err) {
            return { exitCode: 1, stdout: `ds4 complete failed: ${String(err)}` };
          }
        }
        default:
          return {
            exitCode: 1,
            stdout: "Usage: bb ds4 <status|start|stop|restart|logs|agents|agent|complete>",
          };
      }
    },
  });

  // -------------------------------------------------------------------------
  // Native agent tools — let BB agents use the local DS4 model directly
  // -------------------------------------------------------------------------
  bb.agents.registerTool({
    name: "ds4_status",
    description:
      "Check the local DS4 (DwarfStar) inference server: running state, health latency, and served model ids. Use before relying on the local model.",
    instructions:
      "When the user mentions DS4, DwarfStar, or a local DeepSeek server, check ds4_status before assuming it is running.",
    experimental_statusLabels: {
      pending: "Checking DS4 server",
      completed: "Checked DS4 server",
    },
    parameters: z.object({}).strict(),
    async execute() {
      const st = await buildStatus();
      return renderStatus(st);
    },
  });

  bb.agents.registerTool({
    name: "ds4_complete",
    description:
      "Run a one-shot text completion on the local DS4 (DwarfStar) DeepSeek V4 Flash server (OpenAI-compatible API). Fails if the server is not ready.",
    experimental_statusLabels: {
      pending: "Querying local DS4 model",
      completed: "Queried local DS4 model",
    },
    parameters: z
      .object({
        prompt: z.string().min(1).describe("The user prompt to send"),
        system: z.string().optional().describe("Optional system prompt"),
        maxTokens: z.number().int().min(1).max(16384).default(1024),
        temperature: z.number().min(0).max(2).optional(),
      })
      .strict(),
    async execute({ prompt, system, maxTokens, temperature }) {
      if (!(proc.state === "running" && lastHealth?.ok)) {
        return `DS4 server is not ready (state=${proc.state}). Start it with \`bb ds4 start\` first.`;
      }
      try {
        return await ds4Complete(await currentConfig(), {
          prompt,
          system,
          maxTokens,
          temperature,
        });
      } catch (err) {
        return `ds4_complete failed: ${String(err)}`;
      }
    },
  });

  // The model picker resolves this callback immediately before a thread turn
  // starts. That makes it the earliest plugin hook that knows which model the
  // user actually selected, so use it to acquire a short-lived DS4 demand
  // lease and kick the process supervisor without requiring a manual start.
  bb.agents.configure((context) => {
    if (selectedModelIsDs4(context.provider.id, context.provider.model)) {
      acquireDemand(context.thread.id);
      // Resolve from the cached settings so proc.start() is reached before
      // the synchronous model-resolution callback returns to BB.
      void ensureStarted(resolveConfig(toRunSettings(latestSettings))).catch((err) => {
        lastError = `automatic ds4-server start failed: ${String(err)}`;
        bb.log.error(lastError);
        void publishState();
      });
    }
    return {
      tools: ["ds4_status", "ds4_complete"],
      skills: [],
    };
  });

  // A demand lease ends when the selected model's turn settles. Keep the
  // process warm for the configured grace period so quick follow-up turns do
  // not pay the model-load cost again; the supervisor performs the eventual
  // stop. The archive/delete cases prevent a stale thread from holding the
  // server open forever if its normal terminal event is not delivered.
  bb.events.on("thread.idle", ({ thread }) => releaseDemand(thread.id));
  bb.events.on("thread.failed", ({ thread }) => releaseDemand(thread.id));
  bb.events.on("thread.archived", ({ thread }) => releaseAllDemandFor(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => releaseAllDemandFor(thread.id));

  // -------------------------------------------------------------------------
  // Settings change logging + dispose
  // -------------------------------------------------------------------------
  settings.onChange((next, prev) => {
    latestSettings = next;
    const n = next as Record<string, unknown>;
    const p = prev as Record<string, unknown>;
    const changed = Object.keys(n).filter(
      (k) => JSON.stringify(n[k]) !== JSON.stringify(p[k]),
    );
    if (changed.length) bb.log.info(`settings changed: ${changed.join(", ")}`);
  });

  bb.onDispose(() => {
    releaseAllDemand();
    if (logFlushTimer) {
      clearTimeout(logFlushTimer);
      logFlushTimer = null;
    }
    bb.log.info("disposed");
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderStatus(st: StatusDto): string {
  const lines: string[] = [];
  lines.push(`state:     ${st.displayState}`);
  if (st.pid) lines.push(`pid:       ${st.pid}`);
  if (st.startedAt) {
    const s = Math.floor(st.uptimeMs / 1000);
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    lines.push(`uptime:    ${mm}m ${String(ss).padStart(2, "0")}s`);
  }
  if (st.health) {
    if (st.health.ok) {
      lines.push(
        `health:    ok (${st.health.latencyMs} ms)${st.health.models.length ? ` — models: ${st.health.models.join(", ")}` : ""}`,
      );
    } else {
      lines.push(`health:    not ready (${st.health.error ?? st.health.status ?? "no response"})`);
    }
  } else {
    lines.push(`health:    —`);
  }
  lines.push(
    `endpoint:  http://${st.config.host}:${st.config.port}/v1`,
    `port:      ${st.config.port}`,
    `ctx:       ${st.config.ctx}`,
    `max out:   ${st.config.maxTokens}`,
    `dspark:    ${st.config.dspark ? `on (confidence ${st.config.dsparkConfidence})` : "off"}`,
    `model:     ${st.config.modelPath ?? "(none)"}`,
    `dir:       ${st.config.ds4Dir ?? "(not found)"}`,
    `dspark GGUF: ${st.config.dsparkSupportPath ?? "(not found)"}`,
    `backend:   ${st.config.backend}`,
    `log file:  ${st.log.file}`,
  );
  if (st.config.bin) lines.push(`bin:       ${st.config.bin}`);
  if (st.lastError) lines.push(`error:     ${st.lastError}`);
  lines.push(
    `agents:    pi=${st.settings.configurePi ? "on" : "off"} opencode=${st.settings.configureOpencode ? "on" : "off"} codex=${st.settings.configureCodex ? "on" : "off"}`,
  );
  lines.push(
    `settings:  selector=${st.settings.modelSelector || "(none)"} idle=${st.settings.idleTimeoutSeconds}s restartOnCrash=${st.settings.restartOnCrash ? "on" : "off"} maxTokens=${st.settings.maxTokens}`,
  );
  return lines.join("\n");
}
