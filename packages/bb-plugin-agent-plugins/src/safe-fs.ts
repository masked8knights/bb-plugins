import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

export const LIMITS = {
  maxJsonBytes: 1_048_576, // 1MB for plugin.json/mcp.json
  maxSkillCount: 64,
  maxMcpServerCount: 32,
  maxFileCount: 1024,
  maxPathLength: 4096,
  maxStagingBytes: 50 * 1024 * 1024, // 50MB per plugin staging
  maxSkillMdBytes: 256 * 1024,
};

export function isWithinRoot(resolvedPath: string, root: string): boolean {
  const rel = path.relative(root, resolvedPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export async function realpathContained(targetPath: string, root: string): Promise<string> {
  const resolvedRoot = await fsp.realpath(root);
  let resolved: string;
  try {
    resolved = await fsp.realpath(targetPath);
  } catch {
    // If target doesn't exist, resolve normally and check parent containment
    resolved = path.resolve(targetPath);
  }
  if (!isWithinRoot(resolved, resolvedRoot)) {
    throw new Error(`path escapes plugin root: ${targetPath} -> ${resolved} not in ${resolvedRoot}`);
  }
  return resolved;
}

export function isSafeRelativePath(p: string): boolean {
  // For plugin-relative paths that must begin with ./
  return p.startsWith("./") && !p.includes("\0") && p.length <= LIMITS.maxPathLength;
}

export async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const data = await fsp.readFile(filePath);
  hash.update(data);
  return hash.digest("hex").slice(0, 16);
}

export async function hashDirectory(dir: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const walk = async (d: string) => {
    const entries = await fsp.readdir(d, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules" || e.name === ".pytest_cache" || e.name === "__pycache__") continue;
      const full = path.join(d, e.name);
      hash.update(e.name);
      hash.update(e.isDirectory() ? "d" : e.isFile() ? "f" : "o");
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const data = await fsp.readFile(full);
        hash.update(data);
      }
      // symlinks, etc are skipped in hash but rejected in copy
    }
  };
  await walk(dir);
  return hash.digest("hex").slice(0, 16);
}

export async function safeCopyDir(
  src: string,
  dst: string,
  opts: { maxBytes?: number; maxFiles?: number } = {},
): Promise<{ bytes: number; files: number }> {
  const maxBytes = opts.maxBytes ?? LIMITS.maxStagingBytes;
  const maxFiles = opts.maxFiles ?? LIMITS.maxFileCount;
  let totalBytes = 0;
  let totalFiles = 0;

  await fsp.mkdir(dst, { recursive: true });

  const walk = async (s: string, d: string) => {
    const entries = await fsp.readdir(s, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules" || e.name === ".pytest_cache" || e.name === "__pycache__") continue;
      if (totalFiles >= maxFiles) throw new Error(`file count limit exceeded (${maxFiles})`);
      const srcPath = path.join(s, e.name);
      const dstPath = path.join(d, e.name);

      // Reject special files, symlinks, hardlinks in v0 — or prove contained. Simplest: reject any symlink.
      const stat = await fsp.lstat(srcPath);
      if (stat.isSymbolicLink()) throw new Error(`symlink not allowed: ${srcPath}`);
      if (!stat.isDirectory() && !stat.isFile()) {
        // Allow known git sockets inside .git to be skipped, otherwise reject
        if (srcPath.includes("/.git/")) continue;
        throw new Error(`special file not allowed: ${srcPath}`);
      }

      if (e.isDirectory()) {
        await fsp.mkdir(dstPath, { recursive: true });
        await walk(srcPath, dstPath);
      } else if (e.isFile()) {
        const data = await fsp.readFile(srcPath);
        totalBytes += data.length;
        if (totalBytes > maxBytes) throw new Error(`staging byte limit exceeded (${maxBytes})`);
        totalFiles++;
        // Preserve exec mode where appropriate (copy mode)
        await fsp.writeFile(dstPath, data, { mode: stat.mode });
        // Ensure Containment: dest must stay within dst root (already, but check)
        if (!isWithinRoot(path.resolve(dstPath), path.resolve(dst))) {
          throw new Error(`copy escapes destination: ${dstPath}`);
        }
      }
    }
  };

  await walk(src, dst);
  return { bytes: totalBytes, files: totalFiles };
}

export async function atomicRename(src: string, dst: string): Promise<void> {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  // Atomic swap via backup: avoid destructive window where dst is deleted before rename
  let backup: string | null = null;
  try {
    await fsp.stat(dst);
    backup = `${dst}.old-${crypto.randomBytes(4).toString("hex")}`;
    await fsp.rename(dst, backup);
  } catch {
    // dst doesn't exist — nothing to backup
  }
  try {
    await fsp.rename(src, dst);
    if (backup) await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
  } catch (e) {
    // Restore backup on failure
    if (backup) await fsp.rename(backup, dst).catch(() => {});
    throw e;
  }
}

export async function auditTree(root: string): Promise<void> {
  // Post-acquisition audit for git/npm/path staging trees: reject symlinks, hardlinks, special files, absolute/.. members, and enforce limits
  let files = 0;
  let bytes = 0;
  const walk = async (dir: string) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules" || e.name === ".pytest_cache" || e.name === "__pycache__") continue;
      const full = path.join(dir, e.name);
      // Check path length
      if (full.length > LIMITS.maxPathLength) throw new Error(`path too long: ${full}`);
      // Reject absolute or .. in entry name (should not happen via readdir, but check tar-extracted members)
      if (path.isAbsolute(e.name) || e.name.includes("..")) throw new Error(`illegal path member: ${full}`);
      const lstat = await fsp.lstat(full);
      // Hardlink detection: nlink > 1 for regular files means hardlink (directories have nlink>1 normally)
      if (lstat.isFile() && lstat.nlink > 1) throw new Error(`hardlink not allowed: ${full}`);
      if (lstat.isSymbolicLink()) throw new Error(`symlink not allowed: ${full}`);
      if (!lstat.isDirectory() && !lstat.isFile()) {
        if (full.includes("/.git/")) continue;
        throw new Error(`special file not allowed: ${full}`);
      }
      if (lstat.isDirectory()) await walk(full);
      else if (lstat.isFile()) {
        files++;
        if (files > LIMITS.maxFileCount) throw new Error(`file count limit exceeded (${LIMITS.maxFileCount})`);
        bytes += lstat.size;
        if (bytes > LIMITS.maxStagingBytes) throw new Error(`staging byte limit exceeded (${LIMITS.maxStagingBytes})`);
        // Also ensure realpath containment (for any symlink that was not lstat-caught via intermediate)
        try {
          const real = await fsp.realpath(full);
          if (!isWithinRoot(real, root)) throw new Error(`path escapes root via symlink: ${full} -> ${real}`);
        } catch (err) {
          if ((err as Error).message.includes("escapes")) throw err;
          // realpath may fail if file not yet? ignore
        }
      }
    }
  };
  await walk(root);
}

export function stagingDir(base: string, prefix: string): string {
  const id = crypto.randomBytes(6).toString("hex");
  return path.join(base, `${prefix}-staging-${id}`);
}

export async function ensureDir(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
}

export async function rimraf(p: string): Promise<void> {
  await fsp.rm(p, { recursive: true, force: true });
}

export function tmpBase(): string {
  return os.tmpdir();
}
