import { spawn } from "node:child_process";
import type { CliSourceRecord } from "./types";

const PROCESS_TERM_GRACE_MS = 250;

export interface CliRunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  argv: string[];
}

const MAX_RAW_ARG_COUNT = 128;
const MAX_RAW_ARG_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeOutput(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8");
}

export async function runCliSource(
  source: CliSourceRecord,
  input: unknown,
  options: CliRunOptions,
): Promise<CliRunResult> {
  if (!isRecord(input) || !Array.isArray(input.argv)) {
    throw new Error('Raw CLI input must be an object with an "argv" array');
  }
  if (Object.keys(input).some((key) => key !== "argv")) {
    throw new Error('Raw CLI input only accepts the "argv" field');
  }
  if (input.argv.length > MAX_RAW_ARG_COUNT) {
    throw new Error(`Raw CLI argv cannot contain more than ${MAX_RAW_ARG_COUNT} arguments`);
  }
  const argv = input.argv.map((value, index) => {
    if (typeof value !== "string") throw new Error(`Raw CLI argv[${index}] must be a string`);
    if (value.includes("\u0000")) throw new Error(`Raw CLI argv[${index}] contains a null byte`);
    return value;
  });
  const argvBytes = Buffer.byteLength(JSON.stringify(argv), "utf8");
  if (argvBytes > MAX_RAW_ARG_BYTES) {
    throw new Error(`Raw CLI argv exceeds the ${MAX_RAW_ARG_BYTES}-byte limit`);
  }
  return runCliProcess(source.command, source.cwd, source.env, argv, options);
}

function runCliProcess(
  command: string,
  cwd: string | null,
  env: Record<string, string>,
  argv: string[],
  options: CliRunOptions,
): Promise<CliRunResult> {
  const outputChunks: Buffer[] = [];
  const errorChunks: Buffer[] = [];
  let outputBytes = 0;
  let settled = false;

  return new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd: cwd ?? undefined,
      env: { ...process.env, ...env },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
    };

    const signalProcess = (signal: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall through when the process group has already exited.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // The child may have exited between the timeout and cleanup.
      }
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      signalProcess("SIGTERM");
      terminationTimer = setTimeout(() => signalProcess("SIGKILL"), PROCESS_TERM_GRACE_MS);
      reject(error);
    };

    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        fail(new Error(`CLI output exceeded the ${options.maxOutputBytes}-byte limit`));
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => collect(outputChunks, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(errorChunks, chunk));
    child.once("error", (error) => fail(error));
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode: code ?? (signal ? 1 : 0),
        stdout: decodeOutput(outputChunks),
        stderr: decodeOutput(errorChunks),
        argv,
      });
    });

    timeout = setTimeout(() => fail(new Error(`CLI timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
    abortHandler = () => fail(new Error("CLI call was cancelled"));
    if (options.signal?.aborted) abortHandler();
    else options.signal?.addEventListener("abort", abortHandler, { once: true });
  });
}

export function cliResultText(result: CliRunResult): string {
  const sections = [`Exit code: ${result.exitCode}`];
  if (result.stdout) sections.push(`stdout:\n${result.stdout}`);
  if (result.stderr) sections.push(`stderr:\n${result.stderr}`);
  return sections.join("\n\n");
}
