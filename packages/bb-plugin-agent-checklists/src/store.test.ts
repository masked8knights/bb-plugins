import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ChecklistStore, INTERRUPTED_CONTINUATION_ERROR, migrations } from "./store";

const databases: Database.Database[] = [];

function createEmptyStore(): ChecklistStore {
  const database = new Database(":memory:");
  databases.push(database);
  for (const migration of migrations) database.exec(migration);
  return new ChecklistStore(database);
}

function createStore(): ChecklistStore {
  const store = createEmptyStore();
  store.saveTemplate({
    name: "Research to technical document",
    description: "Turn research into a clear document.",
    defaultMode: "approval",
    steps: Array.from({ length: 8 }, (_, index) => ({
      title: `Research step ${index + 1}`,
      description: "",
    })),
  });
  store.saveTemplate({
    name: "Software delivery",
    description: "Carry a coding task through handoff.",
    defaultMode: "automatic",
    steps: Array.from({ length: 8 }, (_, index) => ({
      title: `Delivery step ${index + 1}`,
      description: "",
    })),
  });
  return store;
}

function templateId(store: ChecklistStore, name: string): string {
  const template = store.listTemplates().find((entry) => entry.name === name);
  if (!template) throw new Error(`Missing test template: ${name}`);
  return template.id;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("ChecklistStore", () => {
  it("starts empty and creates isolated attachments from saved definitions", () => {
    expect(createEmptyStore().listTemplates()).toEqual([]);

    const store = createStore();
    const templates = store.listTemplates();
    expect(templates.map((template) => template.name)).toEqual([
      "Research to technical document",
      "Software delivery",
    ]);
    const softwareDeliveryId = templateId(store, "Software delivery");
    const researchId = templateId(store, "Research to technical document");
    expect(templates.find((template) => template.id === softwareDeliveryId)?.steps).toHaveLength(8);

    const first = store.createChecklist("thread-1", softwareDeliveryId, undefined, 8);
    const second = store.createChecklist("thread-2", softwareDeliveryId, undefined, 8);
    expect(first.threadId).toBe("thread-1");
    expect(second.threadId).toBe("thread-2");
    expect(first.steps[0]?.id).not.toBe(second.steps[0]?.id);
    expect(store.getChecklistForThread("thread-1")?.steps.every((step) => !step.checked)).toBe(true);
    expect(researchId).not.toBe(softwareDeliveryId);
  });

  it("creates and edits saved Checklists", () => {
    const store = createStore();
    const custom = store.saveTemplate({
      name: "Release todo",
      description: "Small release reminders.",
      defaultMode: "approval",
      steps: [
        { title: "Run checks", description: "Run the test suite." },
        { title: "Write the handoff", description: "Summarize the release." },
      ],
    });

    expect(custom).toMatchObject({
      name: "Release todo",
      description: "Small release reminders.",
      defaultMode: "approval",
    });
    expect(custom.steps.map((step) => step.title)).toEqual(["Run checks", "Write the handoff"]);

    const edited = store.saveTemplate({
      templateId: custom.id,
      expectedUpdatedAt: custom.updatedAt,
      name: "Release workflow",
      description: "A repeatable release path.",
      defaultMode: "automatic",
      steps: [{ title: "Run checks", description: "Run the test suite." }],
    });
    expect(edited).toMatchObject({ name: "Release workflow", defaultMode: "automatic" });
    expect(edited.steps).toHaveLength(1);
    const softwareDelivery = store.listTemplates().find((template) => template.name === "Software delivery");
    if (!softwareDelivery) throw new Error("Missing software delivery template");
    const editedFixture = store.saveTemplate({
      templateId: softwareDelivery.id,
      expectedUpdatedAt: softwareDelivery.updatedAt,
      name: "Edited delivery",
      description: "A user-owned Checklist.",
      defaultMode: "tracking",
      steps: [{ title: "Do the work", description: "" }],
    });
    expect(editedFixture).toMatchObject({ name: "Edited delivery", defaultMode: "tracking" });
  });

  it("rejects a stale definition edit without replacing newer changes", () => {
    const store = createStore();
    const original = store.saveTemplate({
      name: "Concurrent release",
      description: "Original description.",
      defaultMode: "automatic",
      steps: [
        { title: "Original step", description: "Keep this step." },
        { title: "Second step", description: "Keep this too." },
      ],
    });
    const savedByFirstEditor = store.saveTemplate({
      templateId: original.id,
      expectedUpdatedAt: original.updatedAt,
      name: "First editor release",
      description: "First editor description.",
      defaultMode: "approval",
      steps: [{ title: "First editor step", description: "Newer work." }],
    });

    expect(() =>
      store.saveTemplate({
        templateId: original.id,
        expectedUpdatedAt: original.updatedAt,
        name: "Stale editor release",
        description: "Stale description.",
        defaultMode: "tracking",
        steps: [{ title: "Stale step", description: "Must not replace newer work." }],
      }),
    ).toThrow("changed elsewhere");
    expect(store.getTemplate(original.id)).toEqual(savedByFirstEditor);
  });

  it("only creates new definitions when no template ID is supplied", () => {
    const store = createEmptyStore();
    store.retireBuiltInTemplates();
    const input = {
      name: "Reserved definition",
      description: "",
      defaultMode: "tracking" as const,
      steps: [{ title: "Do the work", description: "" }],
    };

    expect(() => store.saveTemplate({ ...input, templateId: "software-delivery" })).toThrow(
      "Checklist definition not found",
    );
    expect(() => store.saveTemplate({ ...input, templateId: " ", expectedUpdatedAt: 0 })).toThrow(
      "definition ID cannot be empty",
    );
    expect(() => store.saveTemplate({ ...input, templateId: "missing-definition" })).toThrow(
      "Checklist definition not found",
    );
    expect(store.listTemplates()).toEqual([]);
  });

  it("deletes saved definitions without deleting attached snapshots", () => {
    const store = createStore();
    const custom = store.saveTemplate({
      name: "Thread todo",
      description: "",
      defaultMode: "tracking",
      steps: [{ title: "Remember this", description: "" }],
    });
    const attached = store.createChecklist("thread-1", custom.id, undefined, 8);
    expect(() => store.deleteTemplate(custom.id, custom.updatedAt)).not.toThrow();
    expect(store.listTemplates().some((template) => template.id === custom.id)).toBe(false);
    expect(store.getChecklistForThread("thread-1")).toMatchObject({
      id: attached.id,
      name: "Thread todo",
    });
    store.detachChecklist(attached.id);
    expect(store.getChecklistForThread("thread-1")).toBeNull();
  });

  it("closes a lifecycle without deleting its progress or allowing mutations", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", templateId(store, "Software delivery"), undefined, 8);
    const completed = checklist.steps.reduce(
      (current, step) => store.updateStep(current.id, step.id, { checked: true }),
      checklist,
    );
    expect(completed.status).toBe("completed");

    const closed = store.closeChecklist(checklist.id);
    expect(closed).toMatchObject({ id: checklist.id, status: "closed" });
    expect(store.getChecklistForThread("thread-1")).toMatchObject({
      id: checklist.id,
      status: "closed",
      steps: completed.steps,
      notes: [],
    });
    expect(() => store.updateSettings(checklist.id, { status: "active" })).toThrow("closed");
    expect(() => store.updateStep(checklist.id, checklist.steps[0]!.id, { checked: false })).toThrow(
      "closed",
    );
    expect(() => store.addNote(checklist.id, null, "Should not be added")).toThrow("closed");
    expect(() => store.applyAgentUpdate(checklist.id, { stepId: checklist.steps[0]!.id, checked: false })).toThrow(
      "closed",
    );
  });

  it("preserves a continuation error when closing a lifecycle", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", templateId(store, "Software delivery"), undefined, 8);
    store.recordContinuationError(checklist.id, "The reminder could not be delivered.");

    const closed = store.closeChecklist(checklist.id);

    expect(closed).toMatchObject({
      status: "closed",
      lastError: "The reminder could not be delivered.",
    });
  });

  it("settles an orphaned continuation claim without leaving progress behind", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", templateId(store, "Software delivery"), undefined, 8);
    const claimed = store.claimContinuation(checklist.id, false);
    expect(claimed?.continuationCount).toBe(1);
    store.markOrphaned("thread-1");

    const settled = store.cancelContinuationClaim(checklist.id, claimed?.lastReminderAt ?? null);
    expect(settled).toMatchObject({ status: "orphaned", continuationCount: 0, lastReminderAt: null });
  });

  it("rejects deleting a definition with a stale revision", () => {
    const store = createStore();
    const original = store.saveTemplate({
      name: "Delete race",
      description: "Original.",
      defaultMode: "automatic",
      steps: [{ title: "Original step", description: "" }],
    });
    const edited = store.saveTemplate({
      templateId: original.id,
      expectedUpdatedAt: original.updatedAt,
      name: "Updated delete race",
      description: "Newer.",
      defaultMode: "automatic",
      steps: [{ title: "Newer step", description: "" }],
    });

    expect(() => store.deleteTemplate(original.id, original.updatedAt)).toThrow("changed elsewhere");
    expect(store.getTemplate(original.id)).toEqual(edited);
    expect(() => store.deleteTemplate(original.id, edited.updatedAt)).not.toThrow();
  });

  it("requires detaching before attaching another definition to a thread", () => {
    const store = createStore();
    const softwareDeliveryId = templateId(store, "Software delivery");
    const researchId = templateId(store, "Research to technical document");
    const first = store.createChecklist("thread-1", softwareDeliveryId, undefined, 8);
    expect(() => store.createChecklist("thread-1", researchId, undefined, 8)).toThrow(
      "Detach the current Checklist before attaching another",
    );
    store.detachChecklist(first.id);
    expect(
      store.createChecklist("thread-1", researchId, undefined, 8).name,
    ).toBe("Research to technical document");
  });

  it("persists step notes, evidence, and completion state", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", templateId(store, "Software delivery"), undefined, 8);
    const step = checklist.steps[0]!;

    const updated = store.updateStep(checklist.id, step.id, {
      checked: true,
      note: "The request and acceptance criteria are clear.",
      evidence: "User brief",
    });
    expect(updated.steps[0]).toMatchObject({
      checked: true,
      note: "The request and acceptance criteria are clear.",
      evidence: "User brief",
    });
    expect(store.addNote(checklist.id, null, "Keep the handoff concise.").notes).toHaveLength(1);

    let current = updated;
    for (const remaining of current.steps.slice(1)) {
      current = store.updateStep(current.id, remaining.id, { checked: true });
    }
    expect(current.status).toBe("completed");
    expect(store.getChecklistForThread("thread-1")?.status).toBe("completed");

    const reopened = store.updateStep(current.id, step.id, { checked: false });
    expect(reopened.status).toBe("active");
  });

  it("preserves a completion timestamp when only step notes change", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", templateId(store, "Software delivery"), undefined, 8);
    const step = checklist.steps[0]!;
    const checked = store.updateStep(checklist.id, step.id, { checked: true });
    const checkedAt = checked.steps[0]!.checkedAt;

    const noted = store.updateStep(checklist.id, step.id, { note: "Confirmed." });
    expect(noted.steps[0]).toMatchObject({ checked: true, checkedAt, note: "Confirmed." });
  });

  it("claims bounded automatic continuations and records the limit", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", templateId(store, "Software delivery"), "automatic", 1);

    const first = store.claimContinuation(checklist.id, false);
    expect(first).toMatchObject({ continuationCount: 1, status: "active" });
    expect(store.claimContinuation(checklist.id, false)).toBeNull();
    store.completeContinuationClaim(checklist.id, first!.lastReminderAt);
    expect(store.claimContinuation(checklist.id, false)).toMatchObject({
      status: "limit_reached",
      continuationCount: 1,
    });
  });

  it("resets a reached continuation limit only through explicit resume", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", templateId(store, "Software delivery"), "automatic", 1);

    const first = store.claimContinuation(checklist.id, false)!;
    store.completeContinuationClaim(checklist.id, first.lastReminderAt);
    expect(store.claimContinuation(checklist.id, false)?.status).toBe("limit_reached");
    expect(store.resumeAfterLimit(checklist.id)).toMatchObject({
      status: "active",
      continuationCount: 0,
    });
  });

  it("does not bypass a continuation limit by setting active directly", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", templateId(store, "Software delivery"), "automatic", 1);

    const first = store.claimContinuation(checklist.id, false)!;
    store.completeContinuationClaim(checklist.id, first.lastReminderAt);
    expect(store.claimContinuation(checklist.id, false)?.status).toBe("limit_reached");
    expect(() => store.updateSettings(checklist.id, { status: "active" })).toThrow(
      "Resume a limited Checklist",
    );
    expect(() => store.applyAgentUpdate(checklist.id, { status: "active" })).toThrow(
      "Resume a limited Checklist",
    );
    expect(store.getChecklist(checklist.id)?.status).toBe("limit_reached");
  });

  it("releases an interrupted continuation claim after a store restart", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", templateId(store, "Software delivery"), "automatic", 1);
    expect(store.claimContinuation(checklist.id, false)).toMatchObject({ continuationCount: 1 });

    const restarted = new ChecklistStore(databases.at(-1)!);
    expect(restarted.recoverInterruptedContinuationClaims()).toBe(1);
    expect(restarted.getChecklist(checklist.id)).toMatchObject({
      status: "paused",
      continuationCount: 1,
      lastError: INTERRUPTED_CONTINUATION_ERROR,
    });
    expect(restarted.updateSettings(checklist.id, { continuationMode: "tracking" })).toMatchObject({
      status: "paused",
      continuationCount: 1,
      continuationMode: "tracking",
      lastError: INTERRUPTED_CONTINUATION_ERROR,
    });
    expect(restarted.updateSettings(checklist.id, { status: "active" })).toMatchObject({
      status: "active",
      continuationCount: 0,
      lastError: null,
    });
  });

  it("cancels a pre-send continuation claim without overwriting a newer pause", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", templateId(store, "Software delivery"), "automatic", 8);
    const claimed = store.claimContinuation(checklist.id, false)!;
    store.updateSettings(checklist.id, { status: "paused" });

    expect(store.cancelContinuationClaim(checklist.id, claimed.lastReminderAt)).toMatchObject({
      status: "paused",
      continuationCount: 0,
      lastReminderAt: null,
    });
  });

  it("moves capped approval checklists directly to the continuation limit", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", templateId(store, "Software delivery"), "approval", 1);
    store.markAwaitingApproval(checklist.id);
    const claimed = store.claimContinuation(checklist.id, true)!;
    expect(claimed.continuationCount).toBe(1);

    expect(store.markAwaitingApproval(checklist.id)).toMatchObject({
      status: "active",
      continuationCount: 1,
    });
    store.completeContinuationClaim(checklist.id, claimed.lastReminderAt);
    expect(store.markAwaitingApproval(checklist.id)).toMatchObject({
      status: "limit_reached",
      continuationCount: 1,
    });
  });

  it("waits for approval before a manual continuation", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", templateId(store, "Software delivery"), "approval", 8);
    expect(store.claimContinuation(checklist.id, true)).toBeNull();
    expect(store.markAwaitingApproval(checklist.id)?.status).toBe("awaiting_approval");
    expect(store.claimContinuation(checklist.id, true)).toMatchObject({
      status: "active",
      continuationCount: 1,
    });
  });

  it("does not allow a completed checklist to be paused", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", templateId(store, "Software delivery"), undefined, 8);
    let completed = checklist;
    for (const step of completed.steps) {
      completed = store.updateStep(completed.id, step.id, { checked: true });
    }

    expect(completed.status).toBe("completed");
    expect(() => store.updateSettings(completed.id, { status: "paused" })).toThrow(
      "cannot change status",
    );
    expect(store.updateStep(completed.id, completed.steps[0]!.id, { checked: false }).status).toBe(
      "active",
    );
  });

  it("does not manually continue after approval mode is changed", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", templateId(store, "Software delivery"), "approval", 8);
    store.markAwaitingApproval(checklist.id);
    store.updateSettings(checklist.id, { continuationMode: "tracking" });

    expect(store.claimContinuation(checklist.id, true)).toBeNull();
    expect(store.getChecklist(checklist.id)).toMatchObject({
      status: "active",
      continuationMode: "tracking",
    });
  });

  it("rejects mutations after the attached thread is orphaned", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", templateId(store, "Software delivery"), undefined, 8);
    const step = checklist.steps[0]!;
    const orphaned = store.markOrphaned("thread-1");

    expect(orphaned).toMatchObject({ status: "orphaned" });
    expect(() => store.updateStep(checklist.id, step.id, { checked: true })).toThrow(
      "unavailable thread",
    );
    expect(() => store.addNote(checklist.id, null, "No longer current")).toThrow(
      "unavailable thread",
    );
    expect(() => store.updateSettings(checklist.id, { status: "paused" })).toThrow(
      "unavailable thread",
    );
  });

  it("orphaned completed checklists remain read-only", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", templateId(store, "Software delivery"), undefined, 8);
    let completed = checklist;
    for (const step of completed.steps) {
      completed = store.updateStep(completed.id, step.id, { checked: true });
    }

    expect(store.markOrphaned("thread-1")).toMatchObject({ status: "orphaned" });
    expect(store.getChecklistForThread("thread-1")).toMatchObject({ status: "orphaned" });
    expect(() => store.updateStep(completed.id, completed.steps[0]!.id, { checked: false })).toThrow(
      "unavailable thread",
    );
    expect(() => store.addNote(completed.id, null, "No longer current")).toThrow(
      "unavailable thread",
    );
    expect(() => store.updateSettings(completed.id, { status: "paused" })).toThrow(
      "unavailable thread",
    );
  });
});
