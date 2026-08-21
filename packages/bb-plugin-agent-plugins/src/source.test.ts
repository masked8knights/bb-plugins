import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { fetchSource, probeSource, type ParsedSource } from "./source.js";
import { rimraf } from "./safe-fs.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-c", "user.name=Agent Plugins Test", "-c", "user.email=test@example.invalid", ...args], { cwd });
  return result.stdout;
}

afterEach(async () => {
  while (tempDirs.length > 0) await rimraf(tempDirs.pop()!);
});

describe("fetchSource", () => {
  it("selects the highest release tag and records the actual commit", async () => {
    const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-repo-"));
    const staging = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-staging-"));
    tempDirs.push(repo, staging);

    await git(repo, "init", "--quiet");
    await fsp.writeFile(path.join(repo, "plugin.json"), "v1");
    await git(repo, "add", "plugin.json");
    await git(repo, "commit", "--quiet", "-m", "v1");
    await git(repo, "tag", "agent/v1.0.0");

    await fsp.writeFile(path.join(repo, "plugin.json"), "v2");
    await git(repo, "commit", "--quiet", "-am", "v2");
    await git(repo, "tag", "agent/v2.0.0");

    await fsp.writeFile(path.join(repo, "plugin.json"), "unreleased");
    await git(repo, "commit", "--quiet", "-am", "unreleased");

    const parsed: ParsedSource = {
      type: "git",
      intent: `git:${repo}`,
      normalized: `git:${repo}`,
      gitUrl: repo,
      gitRef: null,
      tagPrefix: "agent/",
    };
    const result = await fetchSource(parsed, staging);
    expect(result.resolved).toMatch(/^git:.*@[0-9a-f]{40}$/);
    expect(await fsp.readFile(path.join(result.stagingPath, "plugin.json"), "utf8")).toBe("v2");
    expect(await fsp.stat(path.join(result.stagingPath, ".git")).catch(() => null)).toBeNull();
  });

  it("removes staging content when acquisition fails", async () => {
    const source = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-invalid-"));
    const staging = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-staging-"));
    tempDirs.push(source, staging);
    await fsp.symlink(path.join(source, "missing-target"), path.join(source, "bad-link"));

    await expect(fetchSource({
      type: "path",
      intent: `path:${source}`,
      normalized: `path:${source}`,
      localPath: source,
    }, staging)).rejects.toThrow("symlink not allowed");
    expect((await fsp.readdir(staging)).filter((name) => name.startsWith("src-path-staging-")).length).toBe(0);
  });
});

describe("probeSource", () => {
  it("detects a changed local plugin without staging it", async () => {
    const source = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-probe-path-"));
    tempDirs.push(source);
    await fsp.writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "Example", version: "1.0.0" }));
    const parsed = parseLocalSource(source);

    const before = await probeSource(parsed);
    expect(before.version).toBe("1.0.0");
    await fsp.writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "Example", version: "1.1.0" }));
    const after = await probeSource(parsed);

    expect(after.resolved).not.toBe(before.resolved);
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.version).toBe("1.1.0");
  });

  it("checks the current commit for a tracked Git source", async () => {
    const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-probe-git-"));
    tempDirs.push(repo);
    await git(repo, "init", "--quiet");
    await fsp.writeFile(path.join(repo, "plugin.json"), "v1");
    await git(repo, "add", "plugin.json");
    await git(repo, "commit", "--quiet", "-m", "v1");
    const before = await probeSource({
      type: "git",
      intent: `git:${repo}`,
      normalized: `git:${repo}`,
      gitUrl: repo,
      gitRef: null,
      tagPrefix: null,
    });

    await fsp.writeFile(path.join(repo, "plugin.json"), "v2");
    await git(repo, "commit", "--quiet", "-am", "v2");
    const after = await probeSource({
      type: "git",
      intent: `git:${repo}`,
      normalized: `git:${repo}`,
      gitUrl: repo,
      gitRef: null,
      tagPrefix: null,
    });

    expect(after.resolved).not.toBe(before.resolved);
    expect(after.resolved).toMatch(/^git:.*@[0-9a-f]{40}$/);
  });
});

function parseLocalSource(source: string): ParsedSource {
  return {
    type: "path",
    intent: `path:${source}`,
    normalized: `path:${source}`,
    localPath: source,
  };
}
