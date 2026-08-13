import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@bb/plugin-sdk/testing";
import plugin from "../server";
import type { Checklist } from "./types";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

function createHost(settings?: Record<string, string>) {
  const host = createFakePluginHost({
    pluginId: "agent-checklists",
    settings,
    sdk: {
      threads: {
        send: async () => ({ ok: true }),
        get: async ({ threadId }) => makeThreadResponse({ id: threadId, status: "active" }),
      },
    },
  });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

describe("Agent Checklists server", () => {
  it("attaches a template, exposes agent tools, and updates a step", async () => {
    const host = createHost();
    await plugin(host.bb);

    const templates = (await host.harness.callRpc("listTemplates", null)) as {
      templates: Array<{ id: string }>;
    };
    const template = templates.templates.find((entry) => entry.id === "software-delivery");
    expect(template).toBeDefined();

    const checklist = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: "software-delivery",
    })) as Checklist;
    expect(checklist).toMatchObject({ threadId: "thread-1", continuationMode: "automatic" });

    const toolResult = await host.harness.callAgentTool("agent_checklist_get", {}, {
      threadId: "thread-1",
      projectId: "project-1",
    });
    expect(JSON.stringify(toolResult)).toContain("Software delivery");

    const step = checklist.steps[0]!;
    const updated = await host.harness.callAgentTool(
      "agent_checklist_update",
      { stepId: step.id, checked: true, note: "Confirmed." },
      { threadId: "thread-1", projectId: "project-1" },
    );
    expect(updated).toContain('"checked":true');
  });

  it("persists custom templates through the authoring RPCs", async () => {
    const host = createHost();
    await plugin(host.bb);

    const created = (await host.harness.callRpc("saveTemplate", {
      name: "Release workflow",
      description: "Ship safely.",
      defaultMode: "approval",
      steps: [{ title: "Run checks", description: "Run the test suite." }],
    })) as {
      id: string;
      name: string;
      isBuiltIn: boolean;
      steps: Array<{ title: string }>;
    };
    expect(created).toMatchObject({ name: "Release workflow", isBuiltIn: false });
    expect(created.steps[0]?.title).toBe("Run checks");

    const edited = (await host.harness.callRpc("saveTemplate", {
      templateId: created.id,
      name: "Release todo",
      description: "A short release reminder.",
      defaultMode: "tracking",
      steps: [
        { title: "Run checks", description: "Run the test suite." },
        { title: "Share the result", description: "Write the handoff." },
      ],
    })) as { name: string; steps: Array<unknown> };
    expect(edited).toMatchObject({ name: "Release todo" });
    expect(edited.steps).toHaveLength(2);

    await host.harness.callRpc("deleteTemplate", { templateId: created.id });
    const templates = (await host.harness.callRpc("listTemplates", null)) as {
      templates: Array<{ id: string }>;
    };
    expect(templates.templates.some((template) => template.id === created.id)).toBe(false);
  });

  it("continues an automatic checklist after thread idle", async () => {
    const host = createHost();
    await plugin(host.bb);
    await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: "software-delivery",
      continuationMode: "automatic",
    });

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    });

    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(host.harness.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({
      threadId: "thread-1",
      mode: "auto",
      input: [expect.objectContaining({ type: "text", visibility: "agent-only" })],
    });
  });

  it("does not send a reminder after the continuation cap is reached", async () => {
    const host = createHost({ maxContinuations: "1" });
    await plugin(host.bb);
    await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: "software-delivery",
      continuationMode: "automatic",
    });

    const idle = {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    };
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1));
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);

    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1);
    const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
      checklist: Checklist | null;
    };
    expect(current.checklist).toMatchObject({ status: "limit_reached", continuationCount: 1 });
  });

  it("serializes overlapping idle continuations for one checklist", async () => {
    let resolveSend: ((value: { ok: true }) => void) | undefined;
    const sendPromise = new Promise<{ ok: true }>((resolve) => {
      resolveSend = resolve;
    });
    const host = createHost();
    host.harness.sdk.stub("threads.send", () => sendPromise);
    await plugin(host.bb);
    await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: "software-delivery",
      continuationMode: "automatic",
    });

    const idle = {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    };
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1));
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);

    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1);
    resolveSend?.({ ok: true });
  });

  it("resumes a capped checklist through the explicit resume RPC", async () => {
    const host = createHost({ maxContinuations: "1" });
    await plugin(host.bb);
    await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: "software-delivery",
      continuationMode: "automatic",
    });

    const idle = {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    };
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1));
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);

    const resumed = (await host.harness.callRpc("resume", {
      checklistId: ((await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
        checklist: Checklist;
      }).checklist.id,
    })) as Checklist;
    expect(resumed).toMatchObject({ status: "active", continuationCount: 0 });
  });

  it("marks approval mode as waiting without sending", async () => {
    const host = createHost();
    await plugin(host.bb);
    await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: "research-to-technical-document",
      continuationMode: "approval",
    });

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "Ready for review.",
    });

    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(0);
    const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
      checklist: Checklist | null;
    };
    expect(current.checklist?.status).toBe("awaiting_approval");
  });

  it("does not manually continue after switching away from approval mode", async () => {
    const host = createHost();
    await plugin(host.bb);
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: "research-to-technical-document",
      continuationMode: "approval",
    })) as Checklist;

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "Ready for review.",
    });
    const changed = (await host.harness.callRpc("updateSettings", {
      checklistId: attached.id,
      continuationMode: "tracking",
    })) as Checklist;
    expect(changed).toMatchObject({ status: "active", continuationMode: "tracking" });

    const continued = (await host.harness.callRpc("continue", { checklistId: attached.id })) as {
      sent: boolean;
      checklist: Checklist | null;
    };
    expect(continued).toEqual({ sent: false, checklist: null });
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("retries a failed reminder without consuming the continuation cap", async () => {
    const host = createHost({ maxContinuations: "1" });
    let sendCount = 0;
    host.harness.sdk.stub("threads.send", async () => {
      sendCount += 1;
      if (sendCount === 1) throw new Error("send unavailable");
      return { ok: true };
    });
    await plugin(host.bb);
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: "software-delivery",
      continuationMode: "automatic",
    })) as Checklist;

    const idle = {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    };
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);
    await vi.waitFor(async () => {
      expect(sendCount).toBe(1);
      const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
        checklist: Checklist | null;
      };
      expect(current.checklist).toMatchObject({ status: "paused", continuationCount: 0 });
    });

    await host.harness.callRpc("updateSettings", {
      checklistId: attached.id,
      status: "active",
    });
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);
    await vi.waitFor(async () => {
      expect(sendCount).toBe(2);
      const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
        checklist: Checklist | null;
      };
      expect(current.checklist).toMatchObject({ status: "active", continuationCount: 1 });
    });
  });

  it("continues immediately when automatic mode is enabled on an idle thread", async () => {
    const host = createHost();
    host.harness.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    await plugin(host.bb);
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: "software-delivery",
      continuationMode: "tracking",
    })) as Checklist;

    const updated = (await host.harness.callRpc("updateSettings", {
      checklistId: attached.id,
      continuationMode: "automatic",
    })) as Checklist;
    expect(updated).toMatchObject({ continuationMode: "automatic", continuationCount: 1 });
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("rejects attaching a checklist to an archived thread", async () => {
    const host = createHost();
    host.harness.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, archivedAt: 1 }),
    );
    await plugin(host.bb);

    await expect(
      host.harness.callRpc("attach", {
        threadId: "thread-archived",
        templateId: "software-delivery",
      }),
    ).rejects.toThrow("archived or deleted");
  });

  it("rejects an attachment if the thread is archived during the final lookup", async () => {
    let resolveThread: ((thread: ReturnType<typeof makeThreadResponse>) => void) | undefined;
    const threadPromise = new Promise<ReturnType<typeof makeThreadResponse>>((resolve) => {
      resolveThread = resolve;
    });
    const host = createHost();
    host.harness.sdk.stub("threads.get", () => threadPromise);
    await plugin(host.bb);

    const attaching = host.harness.callRpc("attach", {
      threadId: "thread-racing-archive",
      templateId: "software-delivery",
    });
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.get")).toHaveLength(1));
    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "thread-racing-archive", archivedAt: 1 }),
    });
    resolveThread?.(makeThreadResponse({ id: "thread-racing-archive", status: "active" }));

    await expect(attaching).rejects.toThrow("archived or deleted");
    const current = (await host.harness.callRpc("getForThread", {
      threadId: "thread-racing-archive",
    })) as { checklist: Checklist | null };
    expect(current.checklist).toBeNull();
  });

  it("keeps an in-flight continuation unavailable after the thread is archived", async () => {
    let resolveSend: ((value: { ok: true }) => void) | undefined;
    const sendPromise = new Promise<{ ok: true }>((resolve) => {
      resolveSend = resolve;
    });
    const host = createHost();
    host.harness.sdk.stub("threads.send", () => sendPromise);
    await plugin(host.bb);
    await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: "software-delivery",
      continuationMode: "automatic",
    });

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    });
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1));
    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "thread-1", archivedAt: 1 }),
    });
    resolveSend?.({ ok: true });

    await vi.waitFor(async () => {
      const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
        checklist: Checklist | null;
      };
      expect(current.checklist).toMatchObject({ status: "orphaned" });
    });
  });

  it("does not partially commit a conflicting compound agent update", async () => {
    const host = createHost();
    await plugin(host.bb);
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: "software-delivery",
    })) as Checklist;
    for (const step of attached.steps.slice(0, -1)) {
      await host.harness.callAgentTool(
        "agent_checklist_update",
        { stepId: step.id, checked: true },
        { threadId: "thread-1", projectId: "project-1" },
      );
    }
    const before = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
      checklist: Checklist;
    };
    const lastStep = before.checklist.steps.at(-1)!;

    await expect(
      host.harness.callAgentTool(
        "agent_checklist_update",
        { stepId: lastStep.id, checked: true, status: "active" },
        { threadId: "thread-1", projectId: "project-1" },
      ),
    ).rejects.toThrow("completed checklist");

    const after = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
      checklist: Checklist;
    };
    expect(after.checklist.status).toBe("active");
    expect(after.checklist.steps.at(-1)?.checked).toBe(false);
  });

  it("rejects derived checklist statuses from the public settings RPC", async () => {
    const host = createHost();
    await plugin(host.bb);
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: "software-delivery",
    })) as Checklist;

    await expect(
      host.harness.callRpc("updateSettings", {
        checklistId: attached.id,
        status: "completed",
      }),
    ).rejects.toThrow();
  });
});
