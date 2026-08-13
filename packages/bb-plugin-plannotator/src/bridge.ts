import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";

export const UPSTREAM_REPOSITORY = "https://github.com/backnotprop/plannotator";
export const DEFAULT_BINARY = "plannotator";
export const READY_TIMEOUT_MS = 15_000;
export const INTERACTION_SETTLE_TIMEOUT_MS = 10_000;

export type UpstreamReadyMetadata = {
  url: string;
  isRemote: boolean;
  port: number;
};

export type UpstreamDecision = {
  approved: boolean;
  feedback?: string;
  savedPath?: string;
  agentSwitch?: string;
};

type BridgeOptions = {
  binaryPath: string;
  planMarkdown: string;
  timeoutSeconds: number | null;
  signal: AbortSignal;
  cwd?: string;
  readyTimeoutMs?: number;
};

export type RunningUpstreamReview = {
  url: string;
  result: Promise<UpstreamDecision>;
  stop(): Promise<void>;
};

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the standalone binary without invoking a shell. The official
 * installer puts it in ~/.local/bin, while a package manager may put it on
 * PATH. An explicit setting or PLANNOTATOR_BIN wins.
 */
export function resolvePlannotatorBinary(
  configuredPath = DEFAULT_BINARY,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = (env.PLANNOTATOR_BIN?.trim() || configuredPath.trim() || DEFAULT_BINARY);
  const candidates: string[] = [];

  if (isAbsolute(configured)) {
    candidates.push(configured);
  } else if (configured.includes("/")) {
    candidates.push(resolve(configured));
  } else {
    for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
      candidates.push(join(directory, configured));
    }
    candidates.push(join(homedir(), ".local", "bin", configured));
  }

  return candidates.find(isExecutable) ?? null;
}

function parseJsonLines(value: string): unknown[] {
  const parsed: unknown[] = [];
  for (const line of value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)) {
    try {
      parsed.push(JSON.parse(line) as unknown);
    } catch {
      // Upstream writes diagnostics to stderr. Ignore non-JSON stdout lines so
      // a future informational line does not hide the final decision record.
    }
  }
  return parsed;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseReadyMetadata(value: string): UpstreamReadyMetadata | null {
  const records = parseJsonLines(value).reverse();
  for (const record of records) {
    if (typeof record !== "object" || record === null || Array.isArray(record)) continue;
    const candidate = record as Record<string, unknown>;
    if (!isHttpUrl(candidate.url)) continue;
    if (typeof candidate.port !== "number" || !Number.isInteger(candidate.port)) continue;
    if (candidate.port < 1 || candidate.port > 65_535) continue;
    return {
      url: candidate.url,
      port: candidate.port,
      isRemote: candidate.isRemote === true,
    };
  }
  return null;
}

export function parseUpstreamDecision(stdout: string, stderr = ""): UpstreamDecision {
  const records = parseJsonLines(stdout).reverse();
  for (const record of records) {
    if (typeof record !== "object" || record === null || Array.isArray(record)) continue;
    const candidate = record as Record<string, unknown>;
    if (typeof candidate.approved !== "boolean") continue;
    const decision: UpstreamDecision = { approved: candidate.approved };
    if (typeof candidate.feedback === "string" && candidate.feedback.trim()) {
      decision.feedback = candidate.feedback;
    }
    if (typeof candidate.savedPath === "string" && candidate.savedPath.trim()) {
      decision.savedPath = candidate.savedPath;
    }
    if (typeof candidate.agentSwitch === "string" && candidate.agentSwitch.trim()) {
      decision.agentSwitch = candidate.agentSwitch;
    }
    return decision;
  }

  const diagnostic = stderr.trim().split(/\r?\n/u).filter(Boolean).slice(-4).join(" ");
  throw new Error(
    diagnostic
      ? `Plannotator exited without a decision: ${diagnostic}`
      : "Plannotator exited without a decision",
  );
}

export function buildUpstreamInput(
  planMarkdown: string,
  timeoutSeconds: number | null,
): string {
  return JSON.stringify({
    plan: planMarkdown,
    timeoutSeconds,
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function readReadyFile(path: string): Promise<UpstreamReadyMetadata | null> {
  try {
    return parseReadyMetadata(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminateChild(
  child: ChildProcess,
  exited: Promise<void>,
): Promise<void> {
  if (!childExited(child)) {
    child.kill("SIGTERM");
    await Promise.race([exited, wait(750)]);
  }
  if (!childExited(child)) child.kill("SIGKILL");
  await exited.catch(() => undefined);
}

async function waitForReady(
  readyFile: string,
  child: ChildProcess,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<UpstreamReadyMetadata> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("Plannotator review was cancelled");
    const metadata = await readReadyFile(readyFile);
    if (metadata) return metadata;
    if (childExited(child)) throw new Error("Plannotator exited before its review UI was ready");
    await wait(25);
  }
  throw new Error(`Plannotator did not start its review UI within ${timeoutMs}ms`);
}

/** Start the upstream plan-review process and expose its real browser session. */
export async function startUpstreamPlanReview(
  options: BridgeOptions,
): Promise<RunningUpstreamReview> {
  if (options.signal.aborted) throw new Error("Plannotator review was cancelled");

  const tempDir = await mkdtemp(join(tmpdir(), "bb-plannotator-"));
  const readyFile = join(tempDir, "ready.jsonl");
  let stdout = "";
  let stderr = "";
  let spawnError: Error | null = null;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolvePromise) => {
    resolveExit = resolvePromise;
  });

  let child: ChildProcess;
  try {
    child = spawn(options.binaryPath, ["opencode-plan"], {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        PLANNOTATOR_REMOTE: "0",
        PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
        PLANNOTATOR_READY_FILE: readyFile,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = `${stdout}${chunk}`.slice(-256 * 1024);
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-256 * 1024);
  });
  child.once("error", (error) => {
    spawnError = error instanceof Error ? error : new Error(String(error));
    resolveExit();
  });
  child.once("exit", () => resolveExit());
  child.stdin?.once("error", (error) => {
    spawnError ??= error instanceof Error ? error : new Error(String(error));
  });

  const onAbort = () => {
    if (!childExited(child)) child.kill("SIGTERM");
  };
  options.signal.addEventListener("abort", onAbort, { once: true });

  try {
    child.stdin?.end(buildUpstreamInput(options.planMarkdown, options.timeoutSeconds));
    const ready = await waitForReady(
      readyFile,
      child,
      options.readyTimeoutMs ?? READY_TIMEOUT_MS,
      options.signal,
    );

    const result = exited.then(() => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== 0) {
        throw new Error(
          `Plannotator exited with code ${child.exitCode ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        );
      }
      return parseUpstreamDecision(stdout, stderr);
    });

    return {
      url: ready.url,
      result,
      async stop() {
        options.signal.removeEventListener("abort", onAbort);
        await terminateChild(child, exited);
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    options.signal.removeEventListener("abort", onAbort);
    await terminateChild(child, exited);
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export function missingBinaryMessage(configuredPath: string): string {
  return [
    `Could not find the Plannotator binary (${configuredPath || DEFAULT_BINARY}).`,
    `Install the official standalone binary, then retry: ${UPSTREAM_REPOSITORY}#install`,
    "You can also set the Plannotator binary path in BB → Extensions → Plannotator.",
  ].join(" ");
}
