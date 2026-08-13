// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("../app"));

const attachedChecklist = {
  id: "checklist-1",
  templateId: "software-delivery",
  threadId: "thread-1",
  name: "Attached release checklist",
  description: "Keep the release moving.",
  status: "active" as const,
  continuationMode: "automatic" as const,
  continuationCount: 0,
  maxContinuations: 8,
  lastReminderAt: null,
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
  steps: [
    {
      id: "checklist-step-1",
      templateStepId: "template-step-1",
      position: 0,
      title: "Understand the request",
      description: "Confirm the acceptance criteria.",
      checked: false,
      note: null,
      evidence: null,
      checkedAt: null,
      updatedAt: 1,
    },
  ],
  notes: [],
};

const builtInTemplate = {
  id: "software-delivery",
  name: "Software delivery",
  description: "Carry a coding task through handoff.",
  defaultMode: "automatic" as const,
  isBuiltIn: true,
  createdAt: 1,
  updatedAt: 1,
  steps: [
    {
      id: "template-step-1",
      position: 0,
      title: "Understand the request",
      description: "Confirm the acceptance criteria.",
    },
  ],
};

afterEach(cleanup);

describe("Agent Checklists app", () => {
  it("registers the template catalog and thread panel", () => {
    expect(app.navPanels.map((panel) => panel.id)).toEqual(["templates"]);
    expect(app.threadPanelActions.map((action) => action.id)).toEqual(["agent-checklist"]);
  });

  it("renders template choices when a thread has no attached checklist", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      {
        rpc: {
          getForThread: () => ({ checklist: null }),
          listTemplates: () => ({
            templates: [builtInTemplate],
          }),
        },
      },
    );

    await slot.findByText("Attach an Agent Checklist");
    await slot.findByRole("button", { name: "Attach Software delivery" });
    expect(slot.rpcCalls).toContainEqual({ method: "getForThread", input: { threadId: "thread-1" } });
    expect(slot.rpcCalls).toContainEqual({ method: "listTemplates", input: null });
  });

  it("shows collection rows and opens the new todo editor", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          listTemplates: () => ({ templates: [] }),
        },
      },
    );

    await slot.findByRole("button", { name: "New todo list" });
    expect(slot.getByText("No checklists yet")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "New todo list" }));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "checklists",
      options: { subPath: "template/new/todo" },
    });
  });

  it("keeps an attached checklist visible when template loading fails", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      {
        rpc: {
          getForThread: () => ({ checklist: attachedChecklist }),
          listTemplates: () => {
            throw new Error("template storage unavailable");
          },
        },
      },
    );

    await slot.findByText("Attached release checklist");
    await slot.findByText("Unable to load saved checklists: template storage unavailable");
    expect(slot.queryByText("Attach an Agent Checklist")).toBeNull();
  });

  it("does not offer attachment actions when the current checklist cannot be loaded", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      {
        rpc: {
          getForThread: () => {
            throw new Error("checklist storage unavailable");
          },
          listTemplates: () => ({ templates: [builtInTemplate] }),
        },
      },
    );

    await slot.findByText("Unable to load the attached checklist: checklist storage unavailable");
    expect(slot.queryByRole("button", { name: "Attach" })).toBeNull();
    expect(slot.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("hides stale attachment choices when a template refresh fails", async () => {
    let templateCalls = 0;
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      {
        rpc: {
          getForThread: () => ({ checklist: null }),
          listTemplates: () => {
            templateCalls += 1;
            if (templateCalls > 1) throw new Error("template refresh unavailable");
            return { templates: [builtInTemplate] };
          },
        },
      },
    );

    await slot.findByRole("button", { name: "Attach Software delivery" });
    await slot.emitRealtime("checklists", { templateId: builtInTemplate.id });
    await slot.findByText("Unable to load saved checklists: template refresh unavailable");
    expect(slot.queryByRole("button", { name: "Attach Software delivery" })).toBeNull();
    expect(slot.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("shows a load error instead of not found for an edit deep link", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "template/custom-release" },
      {
        rpc: {
          listTemplates: () => {
            throw new Error("catalog unavailable");
          },
        },
      },
    );

    await slot.findByText("catalog unavailable");
    expect(slot.queryByText("Checklist template not found.")).toBeNull();
    expect(slot.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("offers creation from an empty attachment picker", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-empty", params: null },
      {
        rpc: {
          getForThread: () => ({ checklist: null }),
          listTemplates: () => ({ templates: [] }),
        },
      },
    );

    await slot.findByText("No saved checklists yet");
    fireEvent.click(slot.getByRole("button", { name: "Create a checklist" }));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "checklists",
      options: { subPath: "template/new/todo" },
    });
  });

  it("renders an editor for a new workflow and saves its structured rows", async () => {
    const saved = {
      id: "custom-release",
      name: "Release workflow",
      description: "Ship safely.",
      defaultMode: "approval" as const,
      isBuiltIn: false,
      createdAt: 1,
      updatedAt: 2,
      steps: [
        { id: "step-1", position: 0, title: "Run checks", description: "Run the test suite." },
      ],
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "template/new/workflow" },
      {
        rpc: {
          listTemplates: () => ({ templates: [] }),
          saveTemplate: (input) => {
            expect(input).toMatchObject({ name: "Release workflow", defaultMode: "approval" });
            return saved;
          },
        },
      },
    );

    const name = await slot.findByLabelText("Name");
    fireEvent.change(name, { target: { value: "Release workflow" } });
    fireEvent.change(slot.getByLabelText("Default continuation"), {
      target: { value: "approval" },
    });
    fireEvent.change(slot.getByLabelText("Step 1 title"), { target: { value: "Run checks" } });
    fireEvent.change(slot.getByLabelText("Step 1 description"), { target: { value: "Run the test suite." } });
    fireEvent.click(slot.getByRole("button", { name: "Save checklist" }));

    await slot.findByRole("button", { name: /Back to checklists/u });
    expect(slot.rpcCalls).toContainEqual({
      method: "saveTemplate",
      input: expect.objectContaining({
        name: "Release workflow",
        steps: [expect.objectContaining({ title: "Run checks" })],
      }),
    });
    expect(slot.queryByRole("alert")).toBeNull();
  });

  it("locks template fields while a save is pending", async () => {
    let resolveSave: ((value: typeof builtInTemplate) => void) | undefined;
    const savePromise = new Promise<typeof builtInTemplate>((resolve) => {
      resolveSave = resolve;
    });
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "template/new/workflow" },
      {
        rpc: {
          listTemplates: () => ({ templates: [] }),
          saveTemplate: () => savePromise,
        },
      },
    );

    const name = await slot.findByLabelText("Name");
    fireEvent.change(name, { target: { value: "Release workflow" } });
    fireEvent.change(slot.getByLabelText("Step 1 title"), { target: { value: "Run checks" } });
    fireEvent.click(slot.getByRole("button", { name: "Save checklist" }));
    await waitFor(() =>
      expect((slot.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true),
    );

    expect((name as HTMLInputElement).disabled).toBe(true);
    expect((slot.getByLabelText("Step 1 title") as HTMLInputElement).disabled).toBe(true);
    expect((slot.getByRole("button", { name: /Back to checklists/u }) as HTMLButtonElement).disabled).toBe(true);
    resolveSave?.(builtInTemplate);
    await slot.findByRole("button", { name: /Back to checklists/u });
  });

  it("does not let a pending catalog load erase a just-saved template", async () => {
    let resolveList: ((value: { templates: typeof builtInTemplate[] }) => void) | undefined;
    const listPromise = new Promise<{ templates: typeof builtInTemplate[] }>((resolve) => {
      resolveList = resolve;
    });
    const savedTemplate = {
      ...builtInTemplate,
      id: "custom-release",
      name: "Release checklist",
      isBuiltIn: false,
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "template/new/workflow" },
      {
        rpc: {
          listTemplates: () => listPromise,
          saveTemplate: () => savedTemplate,
        },
      },
    );

    fireEvent.change(await slot.findByLabelText("Name"), { target: { value: "Release checklist" } });
    fireEvent.change(slot.getByLabelText("Step 1 title"), { target: { value: "Run checks" } });
    fireEvent.click(slot.getByRole("button", { name: "Save checklist" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual(expect.objectContaining({ method: "saveTemplate" })),
    );
    slot.rerender(createElement(app.navPanels[0]!.component, { subPath: "template/custom-release" }));
    await slot.findByRole("button", { name: "Delete checklist" });

    resolveList?.({ templates: [] });
    await waitFor(() => expect(slot.queryByText("Checklist template not found.")).toBeNull());
    expect((slot.getByLabelText("Name") as HTMLInputElement).value).toBe("Release checklist");
  });

  it("removes a deleted row even when the refresh fails", async () => {
    let listCall = 0;
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    try {
      const customTemplate = { ...builtInTemplate, id: "custom-release", name: "Release checklist", isBuiltIn: false };
      const slot = renderSlot(
        app.navPanels[0]!,
        { subPath: "template/custom-release" },
        {
          rpc: {
            listTemplates: () => {
              listCall += 1;
              if (listCall > 1) throw new Error("refresh unavailable");
              return { templates: [customTemplate] };
            },
            deleteTemplate: () => ({ deleted: true }),
          },
        },
      );

      await slot.findByRole("button", { name: "Delete checklist" });
      fireEvent.click(slot.getByRole("button", { name: "Delete checklist" }));
      await slot.findByText("refresh unavailable");
      expect(slot.queryByText("Release checklist")).toBeNull();
    } finally {
      window.confirm = originalConfirm;
    }
  });

  it("keeps the newest template refresh when an older request resolves later", async () => {
    const resolvers: Array<(value: { templates: typeof builtInTemplate[] }) => void> = [];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          listTemplates: () => new Promise((resolve) => resolvers.push(resolve)),
        },
      },
    );

    await waitFor(() => expect(resolvers).toHaveLength(1));
    await slot.emitRealtime("checklists", { templateId: "custom-release" });
    await waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]!({ templates: [{ ...builtInTemplate, name: "Newest checklist" }] });
    await slot.findByText("Newest checklist");
    resolvers[0]!({ templates: [{ ...builtInTemplate, name: "Older checklist" }] });
    await waitFor(() => expect(slot.queryByText("Older checklist")).toBeNull());
    expect(slot.getByText("Newest checklist")).toBeTruthy();
  });
});
