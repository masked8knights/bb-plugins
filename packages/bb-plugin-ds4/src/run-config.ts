// Pure run-configuration logic for the DS4 plugin: resolving the DS4 checkout
// directory, building the ds4-server command line, and computing a fingerprint
// used to detect config drift (so the supervisor can restart on change).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";

export type BackendChoice = "auto" | "metal" | "cuda" | "cpu";

export interface RunSettings {
  ds4Dir: string;
  modelPath: string;
  backend: BackendChoice;
  host: string;
  port: string;
  ctx: string;
  maxTokens: string;
  kvDiskDir: string;
  kvDiskSpaceMb: string;
  power: string;
  extraArgs: string;
  autoStart: boolean;
  restartOnCrash: boolean;
  configurePi: boolean;
  configureOpencode: boolean;
  configureCodex: boolean;
}

export interface ResolvedRunConfig {
  ds4Dir: string | null;
  /** Absolute path to the ds4-server binary, or null when the dir is unknown. */
  bin: string | null;
  args: string[];
  modelPath: string | null;
  host: string;
  port: number;
  ctx: number;
  maxTokens: number;
  backend: BackendChoice;
  fingerprint: string;
}

/** Quote-aware whitespace splitter for the free-form extraArgs field. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Resolve the DS4 checkout directory. Explicit setting wins; otherwise the
 * DS4_DIR env var, then common locations, then `which ds4-server`.
 */
export function detectDs4Dir(explicit: string): string | null {
  if (explicit && existsSync(join(explicit, "ds4-server"))) return explicit;
  if (process.env.DS4_DIR && existsSync(join(process.env.DS4_DIR, "ds4-server"))) {
    return process.env.DS4_DIR;
  }
  const home = homedir();
  const candidates = [
    join(home, "workingdir", "ds4"),
    join(home, "ds4"),
    join(home, "src", "ds4"),
    join(home, "code", "ds4"),
    join(home, "dev", "ds4"),
    "/opt/ds4",
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "ds4-server"))) return c;
  }
  try {
    const out = execFileSync("which", ["ds4-server"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out && existsSync(out)) return dirname(out);
  } catch {
    // not on PATH
  }
  return null;
}

export function resolveConfig(s: RunSettings): ResolvedRunConfig {
  const ds4Dir = detectDs4Dir(s.ds4Dir);
  const port = parseInt(s.port, 10) || 8000;
  const ctx = parseInt(s.ctx, 10) || 100000;
  const maxTokens = parseInt(s.maxTokens, 10) || 0;
  const backend: BackendChoice =
    s.backend === "metal" || s.backend === "cuda" || s.backend === "cpu"
      ? s.backend
      : "auto";

  const modelPath = s.modelPath
    ? isAbsolute(s.modelPath)
      ? s.modelPath
      : join(ds4Dir ?? ".", s.modelPath)
    : ds4Dir
      ? join(ds4Dir, "ds4flash.gguf")
      : null;

  const bin = ds4Dir ? join(ds4Dir, "ds4-server") : null;

  const args: string[] = [];
  if (modelPath) args.push("-m", modelPath);
  if (backend !== "auto") args.push(`--${backend}`);
  args.push("--host", s.host || "127.0.0.1", "--port", String(port), "-c", String(ctx));
  if (maxTokens > 0) args.push("-n", String(maxTokens)); // default max output tokens
  if (s.kvDiskDir) {
    args.push("--kv-disk-dir", s.kvDiskDir);
    args.push("--kv-disk-space-mb", String(parseInt(s.kvDiskSpaceMb, 10) || 4096));
  }
  if (s.power) args.push("--power", s.power);
  if (s.extraArgs.trim()) args.push(...splitArgs(s.extraArgs));

  const fingerprint = JSON.stringify({
    ds4Dir,
    modelPath,
    backend,
    host: s.host || "127.0.0.1",
    port,
    ctx,
    maxTokens,
    kvDiskDir: s.kvDiskDir,
    kvDiskSpaceMb: s.kvDiskSpaceMb,
    power: s.power,
    extraArgs: s.extraArgs,
  });

  return {
    ds4Dir,
    bin,
    args,
    modelPath,
    host: s.host || "127.0.0.1",
    port,
    ctx,
    maxTokens,
    backend,
    fingerprint,
  };
}

/** Quote a single argument for inclusion in a shell command string. */
export function shellQuote(arg: string): string {
  return /[\s"']/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/** Build the command line for the interactive ds4-agent (no HTTP flags). */
export function agentCommand(cfg: ResolvedRunConfig): {
  bin: string;
  args: string[];
} {
  const bin = cfg.ds4Dir ? join(cfg.ds4Dir, "ds4-agent") : "ds4-agent";
  const args: string[] = [];
  if (cfg.modelPath) args.push("-m", cfg.modelPath);
  const backend = cfg.args.find((a) => a === "--metal" || a === "--cuda" || a === "--cpu");
  if (backend) args.push(backend);
  args.push("-c", String(cfg.ctx));
  return { bin, args };
}
