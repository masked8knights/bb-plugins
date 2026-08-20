import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as yaml from "js-yaml";
import { ensureDir, safeCopyDir, atomicRename, stagingDir, rimraf } from "./safe-fs.js";
import { validateSkillFrontmatter } from "./loader.js";

export interface MaterializeArgs {
  installId: string;
  pluginName: string;
  skillName: string;
  srcDir: string; // absolute path to skills/<name> inside staging pluginRoot
  dataDir: string; // bb dataDir
  specVersion: string;
}

export interface MaterializeResult {
  skillName: string;
  status: "active" | "conflicted" | "skipped" | "error";
  materializedPath: string | null;
  error: string | null;
}

const MARKER = ".bb-agent-plugins.json";
interface Marker {
  installId: string;
  pluginName: string;
  skillName: string;
  specVersion: string;
  contentHash: string;
  createdAt: number;
}

async function readMarker(dir: string): Promise<Marker | null> {
  try {
    const text = await fsp.readFile(path.join(dir, MARKER), "utf8");
    const m = JSON.parse(text) as Marker;
    if (typeof m.installId === "string") return m;
    return null;
  } catch {
    return null;
  }
}

async function hashDirExcludingMarker(dir: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const walk = async (d: string) => {
    const entries = await fsp.readdir(d, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name === MARKER) continue;
      const full = path.join(d, e.name);
      hash.update(e.name);
      hash.update(e.isDirectory() ? "d" : e.isFile() ? "f" : "o");
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const data = await fsp.readFile(full);
        hash.update(data);
      }
    }
  };
  await walk(dir);
  return hash.digest("hex").slice(0, 16);
}

export async function materializeSkill(args: MaterializeArgs): Promise<MaterializeResult> {
  const { installId, pluginName, skillName, srcDir, dataDir, specVersion } = args;
  const skillsRoot = path.join(dataDir, "skills");
  await ensureDir(skillsRoot);
  const dest = path.join(skillsRoot, skillName);

  // Preflight: does dest exist and is it not owned by us? Also check if owned but modified (hash mismatch) → conflict to avoid data loss.
  try {
    const stat = await fsp.stat(dest);
    if (stat.isDirectory() || stat.isFile()) {
      const marker = await readMarker(dest);
      if (!marker || marker.installId !== installId) {
        return { skillName, status: "conflicted", materializedPath: null, error: `skill ${skillName} already exists and is not owned by ${installId} (owned by ${marker?.installId ?? "unknown"}). Skipping to avoid overwrite.` };
      }
      // Owned — check if user modified it since we last wrote (hash mismatch)
      try {
        const curHash = await hashDirExcludingMarker(dest);
        if (marker.contentHash && curHash !== marker.contentHash) {
          return { skillName, status: "conflicted", materializedPath: null, error: `skill ${skillName} owned by ${installId} but modified (hash ${curHash} != ${marker.contentHash}). Skipping to avoid overwriting user edits.` };
        }
      } catch {}
    }
  } catch {
    // Doesn't exist -> ok to create
  }

  // Verify srcDir is indeed a skill dir with SKILL.md (caller should have validated frontmatter, but double-check)
  let srcSkillMd: string;
  try {
    srcSkillMd = await fsp.readFile(path.join(srcDir, "SKILL.md"), "utf8");
  } catch (e) {
    return { skillName, status: "error", materializedPath: null, error: `SKILL.md missing or unreadable: ${(e as Error).message}` };
  }
  // Parse frontmatter to ensure name matches (defensive)
  let front: unknown = null;
  try {
    const fmMatch = srcSkillMd.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) front = yaml.load(fmMatch[1]);
  } catch {}
  if (front) {
    const v = validateSkillFrontmatter(front, skillName);
    if (!v.valid) return { skillName, status: "skipped", materializedPath: null, error: v.errors.join("; ") };
  }

  // Copy entire skill tree to staging then atomic rename
  const staging = stagingDir(path.join(skillsRoot), `skill-${skillName}`);
  try {
    await safeCopyDir(srcDir, staging);
    // Write marker with hash of payload (excluding marker itself)
    const hash = await hashDirExcludingMarker(staging);
    const marker: Marker = { installId, pluginName, skillName, specVersion, contentHash: hash, createdAt: Date.now() };
    await fsp.writeFile(path.join(staging, MARKER), JSON.stringify(marker, null, 2));

    // Also ensure SKILL.md frontmatter name matches dirname (we validated) but we keep full tree
    await atomicRename(staging, dest);
    return { skillName, status: "active", materializedPath: dest, error: null };
  } catch (e) {
    await rimraf(staging).catch(() => {});
    return { skillName, status: "error", materializedPath: null, error: (e as Error).message };
  }
}

export async function unmaterializeSkill(args: { installId: string; skillName: string; dataDir: string }): Promise<boolean> {
  const dest = path.join(args.dataDir, "skills", args.skillName);
  const marker = await readMarker(dest);
  if (!marker || marker.installId !== args.installId) return false;
  // Also verify hash to avoid deleting user-modified owned tree
  try {
    const curHash = await hashDirExcludingMarker(dest);
    if (marker.contentHash && curHash !== marker.contentHash) return false;
  } catch {
    // A tree we cannot verify is not safe to delete. Treat hash/read errors
    // like a user modification and leave the skill in place.
    return false;
  }
  await rimraf(dest);
  return true;
}
