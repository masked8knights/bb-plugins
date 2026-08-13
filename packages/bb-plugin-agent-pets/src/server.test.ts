import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin from "../server";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

function createHost() {
  const host = createFakePluginHost({ pluginId: "agent-pets", agentSkillIds: ["agent-pets"] });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

describe("Agent Pets server", () => {
  it("creates one pet through onboarding and exposes normal tools afterward", async () => {
    const host = createHost();
    await plugin(host.bb);

    const before = await host.harness.behavior.resolveAgentConfiguration({
      thread: { id: "thread-1", title: null, parentThreadId: null, sourceThreadId: null },
      project: { id: "project-1", kind: "standard", name: "Project", gitRemoteUrl: null },
      environment: {
        id: "environment-1",
        name: null,
        path: null,
        workspaceProvisionType: "unmanaged",
        branchName: null,
      },
      host: { id: "host-1", name: "Local" },
      provider: { id: "codex", model: "test" },
      sideChat: false,
      origin: { kind: null, pluginId: null },
    });
    expect(before.tools.map((tool) => tool.name)).toEqual(["agent_pet_create"]);

    const created = JSON.parse(
      String(
        await host.harness.behavior.callAgentTool(
          "agent_pet_create",
          { name: "Momo", species: "capybara" },
          { threadId: "thread-1", projectId: "project-1" },
        ),
      ),
    ) as { created: boolean; state: { pet: { name: string; species: string } } };
    expect(created.created).toBe(true);
    expect(created.state.pet).toMatchObject({ name: "Momo", species: "capybara" });

    const after = await host.harness.behavior.resolveAgentConfiguration({
      thread: { id: "thread-2", title: null, parentThreadId: null, sourceThreadId: null },
      project: { id: "project-1", kind: "standard", name: "Project", gitRemoteUrl: null },
      environment: {
        id: "environment-1",
        name: null,
        path: null,
        workspaceProvisionType: "unmanaged",
        branchName: null,
      },
      host: { id: "host-1", name: "Local" },
      provider: { id: "codex", model: "test" },
      sideChat: false,
      origin: { kind: null, pluginId: null },
    });
    expect(after.tools.map((tool) => tool.name)).toEqual([
      "agent_pet_status",
      "agent_pet_feed",
      "agent_pet_talk",
    ]);

    const duplicate = JSON.parse(
      String(
        await host.harness.behavior.callAgentTool(
          "agent_pet_create",
          { name: "Second Pet", species: "dog" },
          { threadId: "thread-2", projectId: "project-1" },
        ),
      ),
    ) as { created: boolean; message: string };
    expect(duplicate).toMatchObject({ created: false, message: "A shared pet already exists." });
  });

  it("records agent feeding and returns a species-appropriate reply", async () => {
    const host = createHost();
    await plugin(host.bb);
    await host.harness.behavior.callAgentTool(
      "agent_pet_create",
      { name: "Pip", species: "dog" },
      { threadId: "thread-create", projectId: "project-1" },
    );

    const result = JSON.parse(
      String(
        await host.harness.behavior.callAgentTool(
          "agent_pet_feed",
          {},
          { threadId: "thread-feed", projectId: "project-1" },
        ),
      ),
    ) as { state: { pet: { hunger: number } }; reply: string };
    expect(result.state.pet.hunger).toBeLessThan(18);
    expect(result.reply).toMatch(/woof|tail|snack|mmm/i);

    const events = (await host.harness.behavior.callRpc("getState", null)) as {
      events: Array<{ action: string; actor: string; threadId: string | null }>;
    };
    expect(events.events[0]).toMatchObject({ action: "feed", actor: "agent", threadId: "thread-feed" });
  });

  it("records user talk and preserves the reply in the event stream", async () => {
    const host = createHost();
    await plugin(host.bb);
    await host.harness.behavior.callAgentTool(
      "agent_pet_create",
      { name: "Mochi", species: "cat" },
      { threadId: "thread-create", projectId: "project-1" },
    );

    const result = (await host.harness.behavior.callRpc("userInteract", {
      action: "talk",
      message: "How are you?",
    })) as { event: { actor: string; message: string; reply: string } };
    expect(result.event).toMatchObject({ actor: "user", message: "How are you?" });
    expect(result.event.reply).toMatch(/mrrp|prr|supervise|considered/i);

    const agentResult = JSON.parse(
      String(
        await host.harness.behavior.callAgentTool(
          "agent_pet_talk",
          { message: "Hello, friend." },
          { threadId: "thread-talk", projectId: "project-1" },
        ),
      ),
    ) as { reply: string };
    expect(agentResult.reply).toMatch(/mrrp|prr|supervise|considered/i);
  });
});
