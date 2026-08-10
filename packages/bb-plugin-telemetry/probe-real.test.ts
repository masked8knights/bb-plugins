import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseProviderJsonl } from "./src/providers";
import { scanProviderSource, type HostContext } from "./src/source-reader";
import { defaultSettings } from "./src/source-registry";

function walk(dir: string, out: string[]): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith(".jsonl")) out.push(p);
  }
}

function aggregate(provider: "codex" | "claude" | "prime" | "omp", files: string[]): string {
  let sessions = 0;
  let withTokens = 0;
  let withModel = 0;
  let withTools = 0;
  let withCost = 0;
  let turns = 0;
  let tools = 0;
  let messages = 0;
  let completed = 0;
  let active = 0;
  let failed = 0;
  let statuses: string[] = [];
  for (const f of files) {
    const parsed = parseProviderJsonl(provider, "primary", f, readFileSync(f, "utf8"), "probe");
    if (!parsed) continue;
    const s = parsed.session;
    sessions += 1;
    if (s.inputTokens !== null || s.totalTokens !== null) withTokens += 1;
    if (s.model) withModel += 1;
    if (s.toolCalls > 0) withTools += 1;
    if (s.costUsd !== null) withCost += 1;
    turns += s.turnCount;
    tools += s.toolCalls;
    messages += s.messageCount;
    if (s.status === "completed") completed += 1;
    else if (s.status === "active") active += 1;
    else if (s.status === "failed") failed += 1;
    if (s.status !== "completed" && s.status !== "active" && s.status !== "failed") statuses.push(s.status);
  }
  const expensive = files
    .map((f) => parseProviderJsonl(provider, "primary", f, readFileSync(f, "utf8"), "probe"))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .sort((a, b) => (b.session.totalTokens ?? 0) - (a.session.totalTokens ?? 0))[0];
  const top = expensive?.session;
  return [
    `  [${provider}] ${sessions} files: msgs=${messages} turns=${turns} tools=${tools}`,
    `    sessions with: tokens=${withTokens} model=${withModel} tools>0=${withTools} cost=${withCost}`,
    `    status: completed=${completed} active=${active} failed=${failed} other=${JSON.stringify(statuses)}`,
    `    richest: model=${top?.model} status=${top?.status} tools=${top?.toolCalls} in=${top?.inputTokens} cached=${top?.cachedInputTokens} out=${top?.outputTokens} total=${top?.totalTokens} cost=${top?.costUsd}${top?.costEstimated ? " (est)" : ""}`,
  ].join("\n");
}

describe("REAL DATA probe (informational)", () => {
  it("codex", () => {
    const files: string[] = [];
    walk(join(homedir(), ".codex/sessions"), files);
    console.log("\n=== CODEX ===\n" + aggregate("codex", files));
    expect(true).toBe(true);
  });

  it("claude", () => {
    const files: string[] = [];
    walk(join(homedir(), ".claude/projects"), files);
    console.log("\n=== CLAUDE ===\n" + aggregate("claude", files.filter((p) => !p.includes("CodexBar"))));
    console.log("(CodexBar claude sessions excluded by default; separate count: " + files.filter((p) => p.includes("CodexBar")).length + ")");
    expect(true).toBe(true);
  });

  it("prime jsonl", () => {
    const files = readdirSync(join(homedir(), ".prime/agent/sessions")).filter((n) => n.endsWith(".jsonl"))
      .map((n) => join(homedir(), ".prime/agent/sessions", n));
    console.log("\n=== PRIME JSONL ===\n" + aggregate("prime", files));
    expect(true).toBe(true);
  });

  it("omp jsonl", () => {
    const files: string[] = [];
    walk(join(homedir(), ".omp/agent/sessions"), files);
    console.log("\n=== OMP JSONL ===\n" + aggregate("omp", files));
    expect(true).toBe(true);
  });

  it("prime + opencode sqlite via scanProviderSource", async () => {
    const bb = {
      sdk: {
        hosts: { list: async () => [] },
        files: { listPaths: async () => ({ paths: [], truncated: false }) },
      },
    } as never;
    const host: HostContext = { id: "primary", name: "Primary host", homePath: homedir(), connected: true };
    for (const provider of ["pi", "opencode"] as const) {
      const settings = defaultSettings();
      const result = await scanProviderSource(bb, settings, provider, host);
      const withTokens = result.records.filter((r) => (r.session.inputTokens ?? 0) > 0 || (r.session.totalTokens ?? 0) > 0);
      const withModel = result.records.filter((r) => r.session.model);
      const withCost = result.records.filter((r) => r.session.costUsd !== null);
      const withTools = result.records.filter((r) => r.session.toolCalls > 0);
      const failed = result.records.filter((r) => r.session.status === "failed").length;
      console.log(`\n=== ${provider} sqlite: ${result.count} sessions (error=${result.error})`);
      console.log(`  with tokens>0: ${withTokens.length} | with model: ${withModel.length} | with cost: ${withCost.length} | with tools>0: ${withTools.length} | failed: ${failed}`);
      const costSample = result.records.filter((r) => r.session.costUsd !== null).sort((a, b) => (b.session.costUsd ?? 0) - (a.session.costUsd ?? 0))[0];
      if (costSample) {
        const s = costSample.session;
        console.log(`  costliest: ${s.title.slice(0, 40)} model=${s.model} cost=${s.costUsd}${s.costEstimated ? " (est)" : ""} in=${s.inputTokens} out=${s.outputTokens}`);
      }
      const toolSample = result.records.find((r) => r.session.toolCalls > 0);
      if (toolSample) console.log(`  tool sample: ${toolSample.session.title.slice(0, 40)} tools=${toolSample.session.toolCalls}`);
    }
    expect(true).toBe(true);
  });
});
