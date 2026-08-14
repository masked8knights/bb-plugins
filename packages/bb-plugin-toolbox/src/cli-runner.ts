import Ajv from "ajv";
import { spawn } from "node:child_process";
import type { CliToolRecord, JsonRecord } from "./types";

const PLACEHOLDER = /^\{\{(?:(json|args):)?([A-Za-z_][A-Za-z0-9_-]*)\}\}$/u;
const INLINE_PLACEHOLDER = /\{\{(?:(json|args):)?([A-Za-z_][A-Za-z0-9_-]*)\}\}/gu;
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

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function valueForArgs(value: unknown, mode: string | undefined, key: string): string[] {
  if (mode === "args") {
    if (!Array.isArray(value)) throw new Error(`CLI argument "${key}" must be an array`);
    return value.map((item) => stringifyValue(item));
  }
  if (mode === "json") return [JSON.stringify(value)];
  return [stringifyValue(value)];
}

export function renderCliArgs(template: string[], input: unknown): string[] {
  if (!isRecord(input)) throw new Error("CLI input must be a JSON object");
  const rendered: string[] = [];
  for (const item of template) {
    const exact = item.match(PLACEHOLDER);
    if (exact) {
      const [, mode, key] = exact;
      if (!(key in input)) throw new Error(`CLI input is missing "${key}"`);
      rendered.push(...valueForArgs(input[key], mode, key));
      continue;
    }
    rendered.push(
      item.replace(INLINE_PLACEHOLDER, (_match, mode: string | undefined, key: string) => {
        if (!(key in input)) throw new Error(`CLI input is missing "${key}"`);
        return valueForArgs(input[key], mode, key)[0]!;
      }),
    );
  }
  return rendered;
}

function validateInput(schema: JsonRecord, input: unknown): void {
  const validator = ajv.compile(schema);
  if (validator(input)) return;
  const details = (validator.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
  throw new Error(`CLI input does not match its schema${details ? `: ${details}` : ""}`);
}

function decodeOutput(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8");
}

export async function runCliTool(
  tool: CliToolRecord,
  input: unknown,
  options: CliRunOptions,
): Promise<CliRunResult> {
  validateInput(tool.inputSchema, input);
  const argv = renderCliArgs(tool.argsTemplate, input);
  const outputChunks: Buffer[] = [];
  const errorChunks: Buffer[] = [];
  let outputBytes = 0;
  let settled = false;

  return new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(tool.command, argv, {
      cwd: tool.cwd ?? undefined,
      env: { ...process.env, ...tool.env },
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
