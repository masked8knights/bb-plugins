import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@bb/plugin-sdk/testing";
import plugin, { upstreamOriginForProvider } from "../server";

const hosts: FakePluginHost[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fakePlannotatorBinary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bb-plannotator-fake-"));
  temporaryDirectories.push(directory);
  const binary = join(directory, "plannotator");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const ready = process.env.PLANNOTATOR_READY_FILE;
fs.mkdirSync(path.dirname(ready), { recursive: true });
fs.appendFileSync(ready, JSON.stringify({ url: "http://127.0.0.1:43210", isRemote: false, port: 43210 }) + "\\n");
setTimeout(() => process.stdout.write(JSON.stringify({ approved: true }) + "\\n"), 150);
process.stdin.resume();
`,
    "utf8",
  );
  await chmod(binary, 0o755);
  return binary;
}

async function pendingInteraction(host: FakePluginHost) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pending = host.harness.inspection.pendingInteractions[0];
    if (pending) return pending;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected a pending Plannotator interaction");
}

function wireInteractionSdk(
  host: FakePluginHost,
  options: { conflictOnce?: boolean } = {},
): { seedReviewTab(): void } {
  let revision = 1;
  let tabs: Array<Record<string, unknown>> = [];
  let conflictPending = options.conflictOnce === true;

  const ensureReviewTab = () => {
    const pending = host.harness.inspection.pendingInteractions[0];
    if (pending && tabs.length === 0) {
      tabs = [
        {
          kind: "plugin-panel",
          id: "plugin-panel:plannotator-review",
          actionId: "plannotator-review",
          pluginId: "plannotator",
          title: pending.title,
          paramsJson: JSON.stringify(pending.payload),
        },
      ];
    }
  };

  host.harness.sdk.stub("threads.interactions.list", () =>
    (() => {
      ensureReviewTab();
      return host.harness.inspection.pendingInteractions.map((interaction) => ({
        id: interaction.id,
        threadId: interaction.threadId,
        status: "pending",
        origin: {
          kind: "plugin",
          pluginId: "plannotator",
          rendererId: interaction.rendererId,
        },
        payload: {
          kind: "plugin",
          title: interaction.title,
          data: interaction.payload,
        },
      }));
    })(),
  );
  host.harness.sdk.stub("threads.interactions.respond", (args) => {
    const input = args as unknown as { interactionId: string; value: unknown };
    host.harness.behavior.submitInteraction(input.interactionId, input.value as never);
    return { id: input.interactionId, status: "resolved" };
  });
  host.harness.sdk.stub("threads.tabs.get", () => {
    ensureReviewTab();
    return { revision, tabs };
  });
  host.harness.sdk.stub("threads.tabs.update", (args) => {
    const input = args as unknown as {
      expectedRevision: number;
      tabs: Array<Record<string, unknown>>;
    };
    if (input.expectedRevision !== revision) {
      throw new Error("tabs revision conflict");
    }
    if (conflictPending) {
      conflictPending = false;
      revision += 1;
      throw new Error("tabs revision conflict");
    }
    tabs = input.tabs;
    revision += 1;
    return { revision, tabs };
  });

  return { seedReviewTab: ensureReviewTab };
}

describe("BB upstream Plannotator bridge", () => {
  it("maps BB provider ids to upstream display identities", () => {
    expect(upstreamOriginForProvider("codex")).toBe("codex");
    expect(upstreamOriginForProvider("opencode")).toBe("opencode");
    expect(upstreamOriginForProvider("acp-claude-code")).toBe("claude-code");
    expect(upstreamOriginForProvider("omp")).toBe("pi");
    expect(upstreamOriginForProvider("unknown-provider")).toBe("codex");
  });

  it("registers only the thin control plane and selects its skill", async () => {
    const binary = await fakePlannotatorBinary();
    const host = createFakePluginHost({
      pluginId: "plannotator",
      settings: { binaryPath: binary },
      agentSkillIds: ["plan-review"],
    });
    hosts.push(host);
    await plugin(host.bb);

    expect(host.harness.inspection.registrations.rpcMethods).toEqual(["status"]);
    expect(host.harness.inspection.registrations.agentTools.map((tool) => tool.name)).toEqual([
      "plannotator_review_plan",
    ]);
    expect(host.harness.inspection.registrations.cli).toBeNull();

    const resolved = await host.harness.behavior.resolveAgentConfiguration({
      thread: {
        id: "thread-1",
        title: "Bridge test",
        parentThreadId: null,
        sourceThreadId: null,
      },
      project: {
        id: "project-1",
        kind: "standard" as const,
        name: "Test project",
        gitRemoteUrl: null,
      },
      environment: {
        id: "environment-1",
        name: "Local",
        path: "/workspace",
        workspaceProvisionType: "unmanaged" as const,
        branchName: null,
      },
      host: { id: "host-1", name: "Local host" },
      provider: { id: "codex", model: "test-model" },
      origin: { kind: null, pluginId: null },
    });
    expect(resolved.skills).toEqual(["plan-review"]);
  });

  it("embeds the upstream session payload and bridges its approval back to BB", async () => {
    const binary = await fakePlannotatorBinary();
    const host = createFakePluginHost({
      pluginId: "plannotator",
      settings: { binaryPath: binary },
    });
    hosts.push(host);
    await plugin(host.bb);
    wireInteractionSdk(host, { conflictOnce: true });

    const toolCall = host.harness.behavior.callAgentTool(
      "plannotator_review_plan",
      { title: "Upstream UI", planMarkdown: "# Plan\n\n- Use the real app" },
      { threadId: "thread-1", projectId: "project-1" },
    );
    const pending = await pendingInteraction(host);
    expect(pending.rendererId).toBe("plannotator-upstream-review");
    expect(pending.payload).toMatchObject({
      kind: "plannotator",
      sessionUrl: "http://127.0.0.1:43210",
      threadId: "thread-1",
    });

    const result = await toolCall;
    expect(result).toBe(JSON.stringify({ decision: "approved", source: "plannotator" }));
    expect(host.harness.inspection.pendingInteractions).toHaveLength(0);
    expect(host.harness.sdk.callsTo("threads.interactions.respond")).toHaveLength(1);
    expect(host.harness.sdk.callsTo("threads.tabs.update")).toHaveLength(2);
    const finalTabUpdateCall = [...host.harness.sdk.calls]
      .reverse()
      .find((call) => call.path === "threads.tabs.update");
    expect(finalTabUpdateCall?.args[0]).toMatchObject({
      threadId: "thread-1",
      expectedRevision: 2,
      tabs: [],
    });
  });

  it("cancels the upstream process when the BB pending interaction is cancelled", async () => {
    const binary = await fakePlannotatorBinary();
    const host = createFakePluginHost({
      pluginId: "plannotator",
      settings: { binaryPath: binary },
    });
    hosts.push(host);
    await plugin(host.bb);
    const sdk = wireInteractionSdk(host);

    const toolCall = host.harness.behavior.callAgentTool(
      "plannotator_review_plan",
      { planMarkdown: "# Plan\n\n- Cancel me" },
      { threadId: "thread-1", projectId: "project-1" },
    );
    const pending = await pendingInteraction(host);
    sdk.seedReviewTab();
    host.harness.behavior.cancelInteraction(pending.id);

    const result = await toolCall;
    expect(result).toMatchObject({ isError: true });
    expect(host.harness.sdk.callsTo("threads.tabs.update")).toHaveLength(1);
  });

  it("returns an actionable error when the official binary is missing", async () => {
    const host = createFakePluginHost({
      pluginId: "plannotator",
      settings: { binaryPath: "/definitely/missing/plannotator" },
    });
    hosts.push(host);
    await plugin(host.bb);

    const result = await host.harness.behavior.callAgentTool(
      "plannotator_review_plan",
      { planMarkdown: "# Plan" },
      { threadId: "thread-1", projectId: "project-1" },
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("bundled");
  });
});
