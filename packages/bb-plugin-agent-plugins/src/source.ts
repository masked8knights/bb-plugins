import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import { ensureDir, safeCopyDir, stagingDir, rimraf, LIMITS, auditTree } from "./safe-fs.js";

export type SourceType = "path" | "git" | "npm";

export interface ParsedSource {
  type: SourceType;
  intent: string;
  normalized: string;
  localPath?: string;
  gitUrl?: string;
  gitRef?: string | null;
  tagPrefix?: string | null;
  npmPackage?: string;
  npmSpec?: string | null;
}

const NPM_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export function parseSource(input: string, tagPrefix?: string): ParsedSource {
  const intent = input.trim();
  if (!intent) throw new Error("source is required");
  if (intent.startsWith("path:")) {
    const p = intent.slice(5);
    if (!p) throw new Error("path: requires a path");
    return { type: "path", intent, normalized: `path:${p}`, localPath: p };
  }
  if (intent.startsWith("git:")) {
    const rest = intent.slice(4);
    let url = rest;
    let ref: string | null = null;
    if (rest.includes("://")) {
      const lastSlash = rest.lastIndexOf("/");
      const atAfterSlash = rest.indexOf("@", lastSlash);
      if (atAfterSlash !== -1) {
        url = rest.slice(0, atAfterSlash);
        ref = rest.slice(atAfterSlash + 1) || null;
      }
    }
    if (url.includes("\0") || url.includes("\r") || url.includes("\n")) throw new Error("invalid git url: control chars");
    const isHttps = url.startsWith("https://");
    const isSsh = url.startsWith("git@") || url.startsWith("ssh://");
    if (!isHttps && !isSsh) throw new Error("git url must be https:// or git@ / ssh:// (got: " + url + ")");
    try {
      if (isHttps) {
        const u = new URL(url);
        if (u.username || u.password) throw new Error("git https url must not contain userinfo");
        if (u.hash) throw new Error("git url must not contain fragment");
      } else if (url.startsWith("ssh://")) {
        const u = new URL(url);
        if (u.username && u.password) throw new Error("ssh url must not contain user:pass");
        if (u.password) throw new Error("ssh url must not contain password");
        if (u.hash) throw new Error("git url must not contain fragment");
      } else if (url.startsWith("git@")) {
        if (url.slice(4).includes("@")) throw new Error("git@ url must not contain additional @ (userinfo)");
        if (url.includes("#")) throw new Error("git url must not contain fragment");
      }
    } catch (e) {
      if ((e as Error).message.includes("userinfo") || (e as Error).message.includes("fragment") || (e as Error).message.includes("password")) throw e;
      throw new Error(`invalid git url: ${url}: ${(e as Error).message}`);
    }
    return { type: "git", intent, normalized: `git:${url}${ref ? "@" + ref : ""}`, gitUrl: url, gitRef: ref, tagPrefix: tagPrefix ?? null };
  }
  if (intent.startsWith("npm:")) {
    const rest = intent.slice(4);
    if (!rest) throw new Error("npm: requires package name");
    if (rest.startsWith("file:") || rest.includes("://") || rest.includes("..") || rest.includes("\0")) throw new Error("npm source must be registry package, not file/tarball/alias");
    if (rest.includes(":") && !rest.startsWith("@")) throw new Error("npm alias not allowed");
    let pkg = rest;
    let spec: string | null = null;
    if (rest.startsWith("@")) {
      const slash = rest.indexOf("/");
      if (slash !== -1) {
        const afterSlashAt = rest.indexOf("@", slash);
        if (afterSlashAt !== -1) { pkg = rest.slice(0, afterSlashAt); spec = rest.slice(afterSlashAt + 1) || null; }
      }
    } else {
      const atIdx = rest.lastIndexOf("@");
      if (atIdx > 0) { pkg = rest.slice(0, atIdx); spec = rest.slice(atIdx + 1) || null; }
    }
    if (!NPM_NAME_RE.test(pkg)) throw new Error(`invalid npm package name: ${pkg}`);
    if (spec && spec.length > 100) throw new Error("npm spec too long");
    if (spec && !/^[a-z0-9-._~^><= *|]+$/i.test(spec)) throw new Error(`invalid npm spec: ${spec}`);
    return { type: "npm", intent, normalized: `npm:${pkg}${spec ? "@" + spec : ""}`, npmPackage: pkg, npmSpec: spec };
  }
  if (intent.startsWith("https://") || intent.startsWith("git@") || intent.startsWith("ssh://")) return parseSource(`git:${intent}`, tagPrefix);
  if (intent.startsWith("./") || intent.startsWith("/") || intent.startsWith("../")) return parseSource(`path:${intent}`, tagPrefix);
  if (/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@.*)?$/.test(intent)) {
    if (!intent.includes("/") || intent.startsWith("@")) return parseSource(`npm:${intent}`, tagPrefix);
  }
  return parseSource(`path:${intent}`, tagPrefix);
}

export interface FetchResult { stagingPath: string; resolved: string; contentHash: string; }

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; maxBytes?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = ""; let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); reject(new Error(`${cmd} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    const cap = (chunk: Buffer, holder: { v: string }) => { holder.v += chunk.toString(); if (holder.v.length > maxBytes) holder.v = holder.v.slice(0, maxBytes); };
    const outH = { v: "" }; const errH = { v: "" };
    child.stdout?.on("data", (d) => cap(d, outH));
    child.stderr?.on("data", (d) => cap(d, errH));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); if (killed) return; resolve({ stdout: outH.v, stderr: errH.v, exitCode: code ?? 0 }); });
  });
}

export async function fetchSource(parsed: ParsedSource, stagingBase: string): Promise<FetchResult> {
  await ensureDir(stagingBase);
  const stagingPath = stagingDir(stagingBase, `src-${parsed.type}`);
  await ensureDir(stagingPath);

  if (parsed.type === "path") {
    const src = path.resolve(parsed.localPath!);
    let stat: fs.Stats;
    try { stat = await fsp.stat(src); } catch (e) { throw new Error(`path not found: ${src}: ${(e as Error).message}`); }
    if (!stat.isDirectory()) throw new Error(`path must be directory: ${src}`);
    const { bytes } = await safeCopyDir(src, stagingPath, { maxBytes: LIMITS.maxStagingBytes });
    await auditTree(stagingPath);
    const h = crypto.createHash("sha256").update(src).update(String(stat.mtimeMs)).update(String(bytes)).digest("hex").slice(0, 16);
    return { stagingPath, resolved: `path:${src}#${h}`, contentHash: h };
  }

  if (parsed.type === "git") {
    const url = parsed.gitUrl!;
    const ref = parsed.gitRef;
    const cloneArgs = ["clone", "--depth", "1", "--no-tags"];
    if (ref) cloneArgs.push("--branch", ref);
    cloneArgs.push(url, stagingPath);
    await rimraf(stagingPath);
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
    const result = await run("git", cloneArgs, { env, timeoutMs: 30_000, maxBytes: 5 * 1024 * 1024 });
    if (result.exitCode !== 0) {
      const raw = result.stderr || result.stdout;
      const isAuth = raw.includes("could not read Username") || raw.includes("Authentication failed") || raw.includes("Invalid username") || raw.includes("Repository not found");
      if (isAuth) {
        throw new Error(`Git repository not found or not accessible: ${url} — check the URL is a public git repository containing plugin.json at its root (tried ${url}). ${raw.slice(0, 300)}`);
      }
      throw new Error(`git clone failed: ${raw.slice(0, 500)}`);
    }
    if (parsed.tagPrefix !== null && parsed.tagPrefix !== undefined) {
      try {
        const tagRes = await run("git", ["tag", "--list", `${parsed.tagPrefix}v*`], { cwd: stagingPath });
        if (tagRes.exitCode === 0) {
          const tags = tagRes.stdout.split("\n").map(s => s.trim()).filter(Boolean);
          if (tags.length > 0) {
            const semver = tags.map(t => ({ t, v: t.slice(parsed.tagPrefix!.length) })).sort((a,b) => {
              const ap = a.v.replace(/^v/, "").split(".").map(n => parseInt(n,10)||0);
              const bp = b.v.replace(/^v/, "").split(".").map(n => parseInt(n,10)||0);
              for (let i=0;i<3;i++) if ((bp[i]||0)!==(ap[i]||0)) return (bp[i]||0)-(ap[i]||0);
              return 0;
            });
            const best = semver[0].t;
            const co = await run("git", ["checkout", best], { cwd: stagingPath });
            if (co.exitCode !== 0) throw new Error(`checkout tag ${best} failed: ${co.stderr}`);
          }
        }
      } catch {}
    }
    await rimraf(path.join(stagingPath, ".git")).catch(() => {});
    await auditTree(stagingPath);
    const rev = await run("git", ["rev-parse", "HEAD"], { cwd: stagingPath }).catch(() => ({ stdout: "unknown", stderr: "", exitCode: 0 }));
    const commit = rev.stdout.trim() || "unknown";
    const contentHash = crypto.createHash("sha256").update(commit).digest("hex").slice(0, 16);
    return { stagingPath, resolved: `git:${url}@${commit}`, contentHash };
  }

  if (parsed.type === "npm") {
    const pkg = parsed.npmPackage!;
    const spec = parsed.npmSpec;
    const specStr = spec ? `${pkg}@${spec}` : pkg;
    const packTmp = stagingDir(stagingBase, "npm-pack");
    await ensureDir(packTmp);
    const packArgs = ["pack", specStr, "--json", "--ignore-scripts"];
    const packRes = await run("npm", packArgs, { cwd: packTmp, timeoutMs: 120_000 });
    if (packRes.exitCode !== 0) { await rimraf(packTmp); throw new Error(`npm pack failed for ${specStr}: ${packRes.stderr || packRes.stdout}`); }
    let filename: string | null = null;
    try {
      const pj: unknown = JSON.parse(packRes.stdout);
      if (Array.isArray(pj) && pj.length>0 && typeof pj[0]==="object" && pj[0]!==null) filename = (pj[0] as { filename?: string }).filename ?? null;
    } catch {}
    if (!filename) {
      const entries = await fsp.readdir(packTmp).catch(() => [] as string[]);
      filename = entries.find(e => e.endsWith(".tgz")) ?? null;
    }
    if (!filename) throw new Error(`npm pack did not produce tarball for ${specStr}`);
    const tgzPath = path.isAbsolute(filename) ? filename : path.join(packTmp, filename);
    const listRes = await run("tar", ["-tzf", tgzPath]);
    if (listRes.exitCode !== 0) throw new Error(`tar list failed: ${listRes.stderr}`);
    const members = listRes.stdout.split("\n").map(s => s.trim()).filter(Boolean);
    for (const m of members) {
      if (path.isAbsolute(m)) throw new Error(`tar member absolute path: ${m}`);
      if (m.split("/").includes("..")) throw new Error(`tar member contains ..: ${m}`);
      if (m.length > LIMITS.maxPathLength) throw new Error(`tar member path too long: ${m}`);
    }
    const extractRes = await run("tar", ["-xzf", tgzPath, "--strip-components=1", "-C", stagingPath]);
    if (extractRes.exitCode !== 0) throw new Error(`tar extract failed: ${extractRes.stderr}`);
    await rimraf(packTmp);
    await auditTree(stagingPath);
    let version = spec ?? "unknown";
    try {
      const pkgJson = JSON.parse(await fsp.readFile(path.join(stagingPath, "package.json"), "utf8")) as { version?: string };
      if (pkgJson.version) version = pkgJson.version;
    } catch {}
    const contentHash = crypto.createHash("sha256").update(`${pkg}@${version}`).digest("hex").slice(0, 16);
    return { stagingPath, resolved: `npm:${pkg}@${version}`, contentHash };
  }

  throw new Error(`unsupported source type: ${(parsed as { type: string }).type}`);
}
