// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("../app"));

const template = {
  id: "agent-release",
  name: "Release Checklist",
  description: "Carry a release through validation.",
  defaultMode: "automatic" as const,
  createdAt: 1,
  updatedAt: 1,
  steps: [
    { id: "template-step-1", position: 0, title: "Run checks", description: "Run the test suite." },
    { id: "template-step-2", position: 1, title: "Prepare handoff", description: "Summarize the result." },
  ],
};

const attachedChecklist = {
  id: "checklist-1",
  templateId: template.id,
  threadId: "thread-1",
  name: template.name,
  description: template.description,
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
      title: "Run checks",
      description: "Run the test suite.",
      checked: true,
      note: "The suite passed locally.",
      evidence: "pnpm test",
      checkedAt: 2,
      updatedAt: 2,
    },
    {
      id: "checklist-step-2",
      templateStepId: "template-step-2",
      position: 1,
      title: "Prepare handoff",
      description: "Summarize the result.",
      checked: false,
      note: null,
      evidence: null,
      checkedAt: null,
      updatedAt: 1,
    },
    {
      id: "checklist-step-3",
      templateStepId: "template-step-3",
      position: 2,
      title: "Confirm deployment",
      description: "Verify the deployed build.",
      checked: false,
      note: null,
      evidence: null,
      checkedAt: null,
      updatedAt: 1,
    },
    {
      id: "checklist-step-4",
      templateStepId: "template-step-4",
      position: 3,
      title: "Close the release",
      description: "Record the final state.",
      checked: false,
      note: null,
      evidence: null,
      checkedAt: null,
      updatedAt: 1,
    },
  ],
  notes: [{ id: "note-1", stepId: null, content: "Keep the handoff concise.", createdAt: 2 }],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Checklists app", () => {
  it("registers the library, inspector, composer picker, and summary", () => {
    expect(app.navPanels.map((panel) => panel.id)).toEqual(["templates"]);
    expect(app.navPanels[0]?.title).toBe("Checklists");
    expect(app.navPanels[0]?.icon).toBe("ListTodo");
    expect(app.threadPanelActions.map((action) => action.id)).toEqual(["agent-checklist"]);
    expect(app.threadPanelActions[0]?.title).toBe("Checklist");
    expect(app.threadPanelActions[0]?.icon).toBe("ListTodo");
    expect(app.pendingInteractions.map((interaction) => interaction.id)).toEqual(["agent-checklist-picker"]);
    expect(app.composerCustomizations).toHaveLength(1);
    const customization = app.composerCustomizations[0]!;
    expect(customization.scopes).toEqual(["thread", "new-thread"]);
    expect(customization.plusMenu?.map((item) => item.label)).toEqual([
      "Checklist",
    ]);
    const item = customization.plusMenu![0]!;
    expect(item.icon).toBe("ListTodo");
    expect(typeof item.disabled).toBe("function");
    if (typeof item.disabled === "function") {
      const baseView = {
        layout: "expanded" as const,
        draft: { text: "", isEmpty: true, attachmentCount: 0 },
        run: { isRunning: false, isSubmitting: false },
      };
      expect(
        item.disabled({
          ...baseView,
          scope: { kind: "new-thread", projectId: null },
        }),
      ).toBe(true);
      expect(
        item.disabled({
          ...baseView,
          scope: { kind: "thread", threadId: "thread-1" },
        }),
      ).toBe(false);
    }
    expect(customization.banners?.map((banner) => banner.id)).toEqual([
      "agent-checklist-summary",
    ]);
  });

  it("shows an empty user-owned library and opens a new Checklist editor", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: { listTemplates: () => ({ templates: [] }) } },
    );

    await slot.findByText("No Checklists yet");
    fireEvent.click(slot.getByRole("button", { name: "New Checklist" }));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "checklists",
      options: { subPath: "template/new" },
    });
  });

  it("renders saved definitions as editable rows with a delete action", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: { listTemplates: () => ({ templates: [template] }) } },
    );

    await slot.findByRole("button", { name: "Edit Release Checklist" });
    expect(slot.getByRole("button", { name: "Delete Release Checklist" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Edit Release Checklist" }));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "checklists",
      options: { subPath: "template/agent-release" },
    });
  });

  it("keeps the library visible when deleting a definition fails", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          listTemplates: () => ({ templates: [template] }),
          deleteTemplate: async () => {
            throw new Error("Delete failed");
          },
        },
      },
    );

    await slot.findByRole("button", { name: "Delete Release Checklist" });
    fireEvent.click(slot.getByRole("button", { name: "Delete Release Checklist" }));
    await slot.findByText("Delete failed");
    expect(slot.getByRole("button", { name: "Edit Release Checklist" })).toBeTruthy();
  });

  it("removes a definition after deleting it from the editor", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "template/agent-release" },
      {
        rpc: {
          listTemplates: () => ({ templates: [template] }),
          deleteTemplate: () => ({ deleted: true }),
        },
      },
    );

    await slot.findByRole("button", { name: "Delete Checklist" });
    fireEvent.click(slot.getByRole("button", { name: "Delete Checklist" }));
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "checklists",
        options: { subPath: "", replace: true },
      }),
    );
    expect(slot.rpcCalls).toContainEqual({
      method: "deleteTemplate",
      input: { templateId: template.id, expectedUpdatedAt: template.updatedAt },
    });
  });

  it("uses drag and drop to persist Checklist step order", async () => {
    const saved = { ...template, updatedAt: 2 };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "template/new" },
      {
        rpc: {
          listTemplates: () => ({ templates: [] }),
          saveTemplate: (input) => {
            const value = input as {
              name: string;
              description: string;
              defaultMode: typeof template.defaultMode;
              steps: Array<{ title: string; description: string }>;
            };
            return {
              ...saved,
              id: "custom-release",
              name: value.name,
              description: value.description,
              defaultMode: value.defaultMode,
              steps: value.steps.map((step, index) => ({
              id: `saved-step-${index}`,
              position: index,
              title: step.title,
              description: step.description,
              })),
            };
          },
        },
      },
    );

    const firstTitle = await slot.findByRole("textbox", { name: "Agent step 1 title" });
    fireEvent.change(firstTitle, { target: { value: "First step" } });
    fireEvent.click(slot.getByRole("button", { name: "Add step" }));
    fireEvent.change(slot.getByRole("textbox", { name: "Agent step 2 title" }), {
      target: { value: "Second step" },
    });

    const handles = slot.getAllByRole("button", { name: /Reorder agent step/u });
    const dataTransfer = { effectAllowed: "", setData: vi.fn() };
    const firstRow = handles[0]!.parentElement!.parentElement!;
    fireEvent.dragStart(handles[1]!, { dataTransfer });
    fireEvent.dragOver(firstRow);
    fireEvent.drop(firstRow, { dataTransfer });
    fireEvent.click(slot.getByRole("button", { name: "Save Checklist" }));

    await waitFor(() => expect(slot.rpcCalls).toContainEqual(expect.objectContaining({ method: "saveTemplate" })));
    const saveCall = slot.rpcCalls.find((call) => call.method === "saveTemplate") as {
      input: { steps: Array<{ title: string }> };
    };
    expect(saveCall.input.steps.map((step) => step.title)).toEqual(["Second step", "First step"]);
  });

  it("sends the loaded definition revision when saving an edit", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "template/agent-release" },
      {
        rpc: {
          listTemplates: () => ({ templates: [template] }),
          saveTemplate: (input) => ({ ...template, ...(input as object) }),
        },
      },
    );

    await slot.findByRole("textbox", { name: "Name" });
    fireEvent.click(slot.getByRole("button", { name: "Save Checklist" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual(expect.objectContaining({ method: "saveTemplate" })));
    const saveCall = slot.rpcCalls.find((call) => call.method === "saveTemplate") as {
      input: { expectedUpdatedAt: number };
    };
    expect(saveCall.input.expectedUpdatedAt).toBe(template.updatedAt);
  });

  it("confirms a save and returns to the Checklist collection", async () => {
    const successToast = vi.spyOn(toast, "success");
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "template/agent-release" },
      {
        rpc: {
          listTemplates: () => ({ templates: [template] }),
          saveTemplate: () => ({ ...template, updatedAt: template.updatedAt + 1 }),
        },
      },
    );

    await slot.findByRole("button", { name: "Save Checklist" });
    fireEvent.click(slot.getByRole("button", { name: "Save Checklist" }));

    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "checklists",
        options: { subPath: "", replace: true },
      }),
    );
    expect(successToast).toHaveBeenCalledWith("Checklist saved");
  });

  it("keeps the Checklist editor in a scrollable panel body", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "template/agent-release" },
      { rpc: { listTemplates: () => ({ templates: [template] }) } },
    );

    await slot.findByRole("heading", { name: "Edit Checklist" });
    const editor = slot.getByTestId("checklist-editor-scroll");
    expect(editor.className).toContain("min-h-0");
    expect(editor.className).toContain("flex-1");
    expect(editor.className).toContain("overflow-y-auto");
  });

  it("uses the latest revision for a second save in the same editor", async () => {
    let saveCount = 0;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "template/agent-release" },
      {
        rpc: {
          listTemplates: () => ({ templates: [template] }),
          saveTemplate: (input) => {
            saveCount += 1;
            return {
              ...template,
              name: (input as { name: string }).name,
              updatedAt: saveCount + 1,
            };
          },
        },
      },
    );

    const name = await slot.findByRole("textbox", { name: "Name" });
    fireEvent.click(slot.getByRole("button", { name: "Save Checklist" }));
    await waitFor(() => expect(saveCount).toBe(1));
    fireEvent.change(name, { target: { value: "Second edit" } });
    fireEvent.click(slot.getByRole("button", { name: "Save Checklist" }));
    await waitFor(() => expect(saveCount).toBe(2));

    const saveCalls = slot.rpcCalls.filter((call) => call.method === "saveTemplate") as Array<{
      input: { expectedUpdatedAt: number };
    }>;
    expect(saveCalls.map((call) => call.input.expectedUpdatedAt)).toEqual([1, 2]);
  });

  it("supports touch drag handles without restoring arrow controls", async () => {
    const saved = { ...template, updatedAt: 2 };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "template/new" },
      {
        rpc: {
          listTemplates: () => ({ templates: [] }),
          saveTemplate: (input) => {
            const value = input as { steps: Array<{ title: string; description: string }> };
            return {
              ...saved,
              steps: value.steps.map((step, index) => ({
                id: `saved-step-${index}`,
                position: index,
                title: step.title,
                description: step.description,
              })),
            };
          },
        },
      },
    );

    const firstTitle = await slot.findByRole("textbox", { name: "Agent step 1 title" });
    fireEvent.change(firstTitle, { target: { value: "First step" } });
    fireEvent.click(slot.getByRole("button", { name: "Add step" }));
    fireEvent.change(slot.getByRole("textbox", { name: "Agent step 2 title" }), {
      target: { value: "Second step" },
    });

    const handles = slot.getAllByRole("button", { name: /Reorder agent step/u });
    const firstRow = handles[0]!.parentElement!.parentElement!;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => firstRow,
    });
    fireEvent.pointerDown(handles[1]!, { pointerId: 7, pointerType: "touch" });
    fireEvent.pointerMove(handles[1]!, { pointerId: 7, pointerType: "touch", clientX: 1, clientY: 1 });
    fireEvent.pointerUp(handles[1]!, { pointerId: 7, pointerType: "touch", clientX: 1, clientY: 1 });
    fireEvent.click(slot.getByRole("button", { name: "Save Checklist" }));

    await waitFor(() => expect(slot.rpcCalls).toContainEqual(expect.objectContaining({ method: "saveTemplate" })));
    const saveCall = slot.rpcCalls.find((call) => call.method === "saveTemplate") as {
      input: { steps: Array<{ title: string }> };
    };
    expect(saveCall.input.steps.map((step) => step.title)).toEqual(["Second step", "First step"]);
    expect(slot.queryByRole("button", { name: /Move (up|down)/u })).toBeNull();
  });

  it("keeps editor fields disabled while saving", async () => {
    let resolveSave: ((value: typeof template) => void) | undefined;
    const savePromise = new Promise<typeof template>((resolve) => {
      resolveSave = resolve;
    });
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "template/new" },
      {
        rpc: {
          listTemplates: () => ({ templates: [] }),
          saveTemplate: () => savePromise,
        },
      },
    );

    const name = await slot.findByRole("textbox", { name: "Name" });
    fireEvent.change(slot.getByRole("textbox", { name: "Agent step 1 title" }), {
      target: { value: "Start" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save Checklist" }));
    await waitFor(() => expect((name as HTMLInputElement).disabled).toBe(true));
    resolveSave?.(template);
  });

  it("keeps the thread inspector agent-owned and read-only", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      { rpc: { getForThread: () => ({ checklist: attachedChecklist }) } },
    );

    await slot.findByText("Release Checklist");
    expect(slot.getByText("Prepare handoff")).toBeTruthy();
    expect(slot.getByText("The suite passed locally.")).toBeTruthy();
    expect(slot.getByText("Keep the handoff concise.")).toBeTruthy();
    expect(slot.getByRole("toolbar", { name: "Checklist controls" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Automatic" }).getAttribute("aria-pressed")).toBe("true");
    expect(slot.getByRole("button", { name: "Approval" }).getAttribute("aria-pressed")).toBe("false");
    expect(slot.getByRole("button", { name: "Tracking only" }).getAttribute("aria-pressed")).toBe("false");
    expect(slot.getByRole("img", { name: "Completed: Run checks" })).toBeTruthy();
    expect(slot.getByRole("img", { name: "Next: Prepare handoff" })).toBeTruthy();
    expect(slot.getByText("Next")).toBeTruthy();
    expect(slot.getAllByText("Not started")).toHaveLength(2);
    expect(slot.getByText("Run checks").className).toContain("line-through");
    expect(slot.queryAllByRole("checkbox")).toHaveLength(0);
    expect(slot.queryByRole("textbox")).toBeNull();
    expect(slot.getByRole("button", { name: "Detach" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Pause agent continuation" })).toBeTruthy();
    expect(slot.queryByRole("combobox")).toBeNull();
  });

  it("updates continuation mode and pause state from the status toolbar", async () => {
    let current = attachedChecklist;
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      {
        rpc: {
          getForThread: () => ({ checklist: current }),
          updateSettings: (input) => {
            const next = input as { continuationMode?: typeof current.continuationMode; status?: typeof current.status };
            current = {
              ...current,
              continuationMode: next.continuationMode ?? current.continuationMode,
              status: next.status ?? current.status,
            };
            return current;
          },
        },
      },
    );

    await slot.findByRole("toolbar", { name: "Checklist controls" });
    fireEvent.click(slot.getByRole("button", { name: "Approval" }));
    await waitFor(() => expect(slot.getByRole("button", { name: "Approval" }).getAttribute("aria-pressed")).toBe("true"));
    expect(slot.rpcCalls).toContainEqual({
      method: "updateSettings",
      input: { checklistId: attachedChecklist.id, continuationMode: "approval" },
    });

    fireEvent.click(slot.getByRole("button", { name: "Pause agent continuation" }));
    await waitFor(() => expect(slot.getByRole("button", { name: "Resume agent continuation" })).toBeTruthy());
    expect(slot.rpcCalls).toContainEqual({
      method: "updateSettings",
      input: { checklistId: attachedChecklist.id, status: "paused" },
    });
  });

  it("shows completed progress and disables mode changes when every step is complete", async () => {
    const completedChecklist = {
      ...attachedChecklist,
      status: "completed" as const,
      steps: attachedChecklist.steps.map((step) => ({ ...step, checked: true })),
    };
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      { rpc: { getForThread: () => ({ checklist: completedChecklist }) } },
    );

    await slot.findByText("Complete");
    expect(slot.getByText("4 of 4 complete")).toBeTruthy();
    expect(slot.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    expect(slot.getAllByRole("img", { name: /^Completed:/u })).toHaveLength(4);
    expect(slot.getByText("Run checks").className).toContain("line-through");
    expect(slot.queryByRole("button", { name: "Pause agent continuation" })).toBeNull();
    expect(slot.getByRole("button", { name: "Close Checklist lifecycle for Release Checklist" })).toBeTruthy();
    expect((slot.getByRole("button", { name: "Automatic" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes a lifecycle from the inspector toolbar while keeping the detail record visible", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let current: Omit<typeof attachedChecklist, "status"> & { status: "active" | "closed" } = attachedChecklist;
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      {
        rpc: {
          getForThread: () => ({ checklist: current }),
          close: () => {
            current = { ...current, status: "closed" as const };
            return current;
          },
        },
      },
    );

    await slot.findByRole("button", { name: "Close Checklist lifecycle for Release Checklist" });
    fireEvent.click(slot.getByRole("button", { name: "Close Checklist lifecycle for Release Checklist" }));
    await waitFor(() => expect(slot.getByText("Closed")).toBeTruthy());
    expect(slot.rpcCalls).toContainEqual({ method: "close", input: { checklistId: attachedChecklist.id } });
    expect(slot.getByRole("button", { name: "Detach" })).toBeTruthy();
  });

  it("shows the approval action while a checklist is awaiting approval", async () => {
    const awaiting = {
      ...attachedChecklist,
      status: "awaiting_approval" as const,
      continuationMode: "approval" as const,
    };
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      {
        rpc: {
          getForThread: () => ({ checklist: awaiting }),
          continue: () => ({ checklist: { ...awaiting, status: "active" as const } }),
        },
      },
    );

    await slot.findByRole("button", { name: "Approve continuation" });
    expect(slot.getByRole("button", { name: "Pause agent continuation" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Approve continuation" }));
    await waitFor(() => expect(slot.getByRole("button", { name: "Pause agent continuation" })).toBeTruthy());
    expect(slot.rpcCalls).toContainEqual({ method: "continue", input: { checklistId: awaiting.id } });
  });

  it("shows the resume action when the continuation limit is reached", async () => {
    const limited = {
      ...attachedChecklist,
      status: "limit_reached" as const,
      continuationCount: attachedChecklist.maxContinuations,
    };
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      {
        rpc: {
          getForThread: () => ({ checklist: limited }),
          resume: () => ({ ...limited, status: "active" as const, continuationCount: 0 }),
        },
      },
    );

    await slot.findByRole("button", { name: "Resume continuation" });
    fireEvent.click(slot.getByRole("button", { name: "Resume continuation" }));
    await waitFor(() => expect(slot.getByRole("button", { name: "Pause agent continuation" })).toBeTruthy());
    expect(slot.rpcCalls).toContainEqual({ method: "resume", input: { checklistId: limited.id } });
  });

  it("detaches from the toolbar after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      {
        rpc: {
          getForThread: () => ({ checklist: attachedChecklist }),
          detach: () => ({ detached: true }),
        },
      },
    );

    await slot.findByRole("button", { name: "Detach" });
    fireEvent.click(slot.getByRole("button", { name: "Detach" }));
    await waitFor(() => expect(slot.getByText("No Checklist attached")).toBeTruthy());
    expect(slot.rpcCalls).toContainEqual({ method: "detach", input: { checklistId: attachedChecklist.id } });
  });

  it("explains how to attach when the thread has no Checklist", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-empty", params: null },
      { rpc: { getForThread: () => ({ checklist: null }) } },
    );

    await slot.findByText("No Checklist attached");
    expect(slot.getByText(/composer’s/u)).toBeTruthy();
    expect(slot.rpcCalls.some((call) => call.method === "listTemplates")).toBe(false);
  });

  it("shows only the next few incomplete steps above the composer", async () => {
    const bannerDefinition = app.composerCustomizations[0]!.banners![0]!;
    const slot = renderSlot(
      bannerDefinition,
      {},
      {
        composer: { scope: { kind: "thread", threadId: "thread-1" } },
        rpc: { getForThread: () => ({ checklist: attachedChecklist }) },
        openThreadPanel: () => true,
      },
    );

    await slot.findByRole("region", { name: "Checklist status" });
    expect(slot.getByText("Prepare handoff")).toBeTruthy();
    expect(slot.getByText("1 of 4")).toBeTruthy();
    expect(slot.getByText("Up next:")).toBeTruthy();
    expect(slot.queryByText("Run checks")).toBeNull();
    expect(slot.queryByRole("checkbox")).toBeNull();
    const bannerRegion = slot.getByRole("region", { name: "Checklist status" });
    expect(bannerRegion.className).toContain("min-w-0");
    expect(bannerRegion.className).toContain("overflow-hidden");
    expect((bannerRegion.firstElementChild as HTMLElement).className).toContain("flex-wrap");
    expect((bannerRegion.firstElementChild?.firstElementChild as HTMLElement).className).toContain("basis-full");
    expect((bannerRegion.children[2] as HTMLElement).className).toContain("flex-wrap");
    fireEvent.click(slot.getByRole("button", { name: "Open Checklist details for Release Checklist" }));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "openThreadPanel",
      options: { actionId: "agent-checklist", title: "Checklist · Release Checklist" },
    });
  });

  it("removes a completed lifecycle from the compact composer banner", async () => {
    const completed = {
      ...attachedChecklist,
      status: "completed" as const,
      steps: attachedChecklist.steps.map((step) => ({ ...step, checked: true })),
    };
    const slot = renderSlot(
      app.composerCustomizations[0]!.banners![0]!,
      {},
      {
        composer: { scope: { kind: "thread", threadId: "thread-1" } },
        rpc: {
          getForThread: () => ({ checklist: completed }),
          close: () => ({ ...completed, status: "closed" as const }),
        },
      },
    );

    await slot.findByRole("region", { name: "Checklist status" });
    fireEvent.click(
      slot.getByRole("button", { name: "Close Checklist lifecycle for Release Checklist" }),
    );
    await waitFor(() => expect(slot.queryByRole("region", { name: "Checklist status" })).toBeNull());
    expect(slot.rpcCalls).toContainEqual({ method: "close", input: { checklistId: completed.id } });
  });

  it("shows approval status and an action in the compact composer banner", async () => {
    const awaiting = {
      ...attachedChecklist,
      status: "awaiting_approval" as const,
      continuationMode: "approval" as const,
    };
    const slot = renderSlot(
      app.composerCustomizations[0]!.banners![0]!,
      {},
      {
        composer: { scope: { kind: "thread", threadId: "thread-1" } },
        rpc: {
          getForThread: () => ({ checklist: awaiting }),
          continue: () => ({ checklist: { ...awaiting, status: "active" as const } }),
        },
      },
    );

    await slot.findByText("Waiting for approval");
    expect(slot.getByRole("button", { name: "Pause" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual({
      method: "continue",
      input: { checklistId: awaiting.id },
    }));
  });

  it("ignores a delayed composer action after switching threads", async () => {
    const paused = { ...attachedChecklist, status: "paused" as const };
    const other = {
      ...attachedChecklist,
      id: "checklist-2",
      threadId: "thread-2",
      name: "Other Checklist",
    };
    const resumeResult = { ...paused, status: "active" as const };
    let resolveResume: ((value: typeof resumeResult) => void) | undefined;
    const resumePromise = new Promise<typeof resumeResult>((resolve) => {
      resolveResume = resolve;
    });
    const slot = renderSlot(
      app.composerCustomizations[0]!.banners![0]!,
      {},
      {
        composer: { scope: { kind: "thread", threadId: "thread-1" } },
        rpc: {
          getForThread: (input) => {
            const threadId = (input as { threadId: string }).threadId;
            return { checklist: threadId === "thread-1" ? paused : other };
          },
          updateSettings: () => resumePromise,
        },
      },
    );

    await slot.findByText("Release Checklist");
    fireEvent.click(slot.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual({
      method: "updateSettings",
      input: { checklistId: paused.id, status: "active" },
    }));
    await slot.behavior.setComposerScope({ kind: "thread", threadId: "thread-2" });
    await slot.findByText("Other Checklist");

    resolveResume?.(resumeResult);
    await waitFor(() => expect(slot.getByText("Other Checklist")).toBeTruthy());
    expect(slot.queryByText("Release Checklist")).toBeNull();
  });

  it("renders the composer attachment picker as a compact Checklist dropdown", async () => {
    let submitted: unknown = null;
    const slot = renderSlot(
      app.pendingInteractions[0]!,
      {
        interaction: {
          id: "interaction-1",
          threadId: "thread-1",
          title: "Checklist",
          payload: {
            templates: [
              {
                id: template.id,
                name: template.name,
              },
            ],
          },
          createdAt: 1,
          expiresAt: null,
        },
        submit: async (value) => {
          submitted = value;
        },
        cancel: async () => undefined,
      },
    );

    const picker = await slot.findByRole("combobox", { name: "Checklist" });
    expect(slot.getByRole("option", { name: "Release Checklist" })).toBeTruthy();
    expect(slot.queryByText("Choose the saved steps the agent should follow in this conversation.")).toBeNull();
    expect(slot.queryByRole("button", { name: "Attach Release Checklist" })).toBeNull();
    fireEvent.change(picker, { target: { value: template.id } });
    await waitFor(() => expect(submitted).toEqual({ templateId: template.id }));
  });
});
