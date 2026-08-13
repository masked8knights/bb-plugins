import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ChecklistStore, migrations } from "./store";

const databases: Database.Database[] = [];

function createStore(): ChecklistStore {
  const database = new Database(":memory:");
  databases.push(database);
  for (const migration of migrations) database.exec(migration);
  const store = new ChecklistStore(database);
  store.seedBuiltInTemplates();
  return store;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("ChecklistStore", () => {
  it("seeds structured templates and creates isolated thread attachments", () => {
    const store = createStore();
    const templates = store.listTemplates();
    expect(templates.map((template) => template.id)).toEqual([
      "research-to-technical-document",
      "software-delivery",
    ]);
    expect(templates.find((template) => template.id === "software-delivery")?.steps).toHaveLength(8);

    const first = store.createChecklist("thread-1", "software-delivery", undefined, 8);
    const second = store.createChecklist("thread-2", "software-delivery", undefined, 8);
    expect(first.threadId).toBe("thread-1");
    expect(second.threadId).toBe("thread-2");
    expect(first.steps[0]?.id).not.toBe(second.steps[0]?.id);
    expect(store.getChecklistForThread("thread-1")?.steps.every((step) => !step.checked)).toBe(true);
  });

  it("creates and edits custom templates without changing built-ins", () => {
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
      isBuiltIn: false,
    });
    expect(custom.steps.map((step) => step.title)).toEqual(["Run checks", "Write the handoff"]);

    const edited = store.saveTemplate({
      templateId: custom.id,
      name: "Release workflow",
      description: "A repeatable release path.",
      defaultMode: "automatic",
      steps: [{ title: "Run checks", description: "Run the test suite." }],
    });
    expect(edited).toMatchObject({ name: "Release workflow", defaultMode: "automatic" });
    expect(edited.steps).toHaveLength(1);
    expect(() =>
      store.saveTemplate({
        templateId: "software-delivery",
        name: "Changed built-in",
        description: "No.",
        defaultMode: "automatic",
        steps: [{ title: "No", description: "" }],
      }),
    ).toThrow("Built-in checklists cannot be edited");
  });

  it("protects custom templates that are already attached", () => {
    const store = createStore();
    const custom = store.saveTemplate({
      name: "Thread todo",
      description: "",
      defaultMode: "tracking",
      steps: [{ title: "Remember this", description: "" }],
    });
    store.createChecklist("thread-1", custom.id, undefined, 8);
    expect(() => store.deleteTemplate(custom.id)).toThrow(
      "A checklist attached to a thread cannot be deleted",
    );
  });

  it("persists step notes, evidence, and completion state", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", "software-delivery", undefined, 8);
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

  it("claims bounded automatic continuations and records the limit", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", "software-delivery", "automatic", 1);

    const first = store.claimContinuation(checklist.id, false);
    expect(first).toMatchObject({ continuationCount: 1, status: "active" });
    const second = store.claimContinuation(checklist.id, false);
    expect(second).toMatchObject({ status: "limit_reached", continuationCount: 1 });
  });

  it("resets a reached continuation limit only through explicit resume", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", "software-delivery", "automatic", 1);

    store.claimContinuation(checklist.id, false);
    expect(store.claimContinuation(checklist.id, false)?.status).toBe("limit_reached");
    expect(store.resumeAfterLimit(checklist.id)).toMatchObject({
      status: "active",
      continuationCount: 0,
    });
  });

  it("releases an interrupted continuation claim after a store restart", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", "software-delivery", "automatic", 1);
    expect(store.claimContinuation(checklist.id, false)).toMatchObject({ continuationCount: 1 });

    const restarted = new ChecklistStore(databases.at(-1)!);
    expect(restarted.recoverInterruptedContinuationClaims()).toBe(1);
    expect(restarted.getChecklist(checklist.id)).toMatchObject({
      status: "paused",
      continuationCount: 0,
      lastError: "A continuation was interrupted before delivery; resume to retry.",
    });
  });

  it("waits for approval before a manual continuation", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", "software-delivery", "approval", 8);
    expect(store.claimContinuation(checklist.id, true)).toBeNull();
    expect(store.markAwaitingApproval(checklist.id)?.status).toBe("awaiting_approval");
    expect(store.claimContinuation(checklist.id, true)).toMatchObject({
      status: "active",
      continuationCount: 1,
    });
  });

  it("does not allow a completed checklist to be paused", () => {
    const store = createStore();
    const checklist = store.createChecklist("thread-1", "software-delivery", undefined, 8);
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
    const checklist = store.createChecklist("thread-1", "software-delivery", "approval", 8);
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
    const checklist = store.createChecklist("thread-1", "software-delivery", undefined, 8);
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
    const checklist = store.createChecklist("thread-1", "software-delivery", undefined, 8);
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
