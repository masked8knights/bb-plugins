import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unmaterializeSkill } from "./skills-impl.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const unreadable = path.join(root, "skills", "research", "private");
    await fsp.chmod(unreadable, 0o700).catch(() => {});
    await fsp.rm(root, { recursive: true, force: true });
  }
});

describe("skill cleanup", () => {
  it("keeps an owned tree when its contents cannot be hashed", async () => {
    if (process.getuid?.() === 0) return;

    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "bb-agent-plugins-"));
    roots.push(root);
    const dest = path.join(root, "skills", "research");
    const unreadable = path.join(dest, "private");
    await fsp.mkdir(unreadable, { recursive: true });
    await fsp.writeFile(path.join(dest, ".bb-agent-plugins.json"), JSON.stringify({ installId: "plugin-1" }));
    await fsp.writeFile(path.join(unreadable, "secret.txt"), "keep me");
    await fsp.chmod(unreadable, 0);

    await expect(unmaterializeSkill({ installId: "plugin-1", skillName: "research", dataDir: root })).resolves.toBe(false);
    await expect(fsp.stat(dest)).resolves.toBeTruthy();
  });
});
