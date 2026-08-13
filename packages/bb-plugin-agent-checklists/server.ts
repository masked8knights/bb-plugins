import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { ChecklistStore, migrations } from "./src/store";
import {
  checklistStatuses,
  continuationModes,
  hasIncompleteSteps,
  nextStep,
  userSettableChecklistStatuses,
  type Checklist,
  type ContinuationMode,
} from "./src/types";

const REALTIME_CHANNEL = "checklists";
const DEFAULT_MAX_CONTINUATIONS = 8;

const modeSchema = z.enum(continuationModes);
const statusSchema = z.enum(checklistStatuses);
const userSettableStatusSchema = z.enum(userSettableChecklistStatuses);

const templateStepSchema = z
  .object({
    id: z.string(),
    position: z.number().int().nonnegative(),
    title: z.string(),
    description: z.string(),
  })
  .strict();

const templateStepInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().max(2_000),
  })
  .strict();

const templateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    defaultMode: modeSchema,
    isBuiltIn: z.boolean(),
    steps: z.array(templateStepSchema),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();

const checklistStepSchema = z
  .object({
    id: z.string(),
    templateStepId: z.string(),
    position: z.number().int().nonnegative(),
    title: z.string(),
    description: z.string(),
    checked: z.boolean(),
    note: z.string().nullable(),
    evidence: z.string().nullable(),
    checkedAt: z.number().nullable(),
    updatedAt: z.number(),
  })
  .strict();

const checklistNoteSchema = z
  .object({
    id: z.string(),
    stepId: z.string().nullable(),
    content: z.string(),
    createdAt: z.number(),
  })
  .strict();

const checklistSchema = z
  .object({
    id: z.string(),
    templateId: z.string(),
    threadId: z.string(),
    name: z.string(),
    description: z.string(),
    status: statusSchema,
    continuationMode: modeSchema,
    continuationCount: z.number().int().nonnegative(),
    maxContinuations: z.number().int().positive(),
    lastReminderAt: z.number().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    steps: z.array(checklistStepSchema),
    notes: z.array(checklistNoteSchema),
  })
  .strict();

const threadIdInput = z.object({ threadId: z.string().min(1) }).strict();
const checklistIdInput = z.object({ checklistId: z.string().min(1) }).strict();

const updateStepInput = z
  .object({
    checklistId: z.string().min(1),
    stepId: z.string().min(1),
    checked: z.boolean().optional(),
    note: z.string().max(10_000).nullable().optional(),
    evidence: z.string().max(10_000).nullable().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.checked !== undefined || input.note !== undefined || input.evidence !== undefined,
    "Provide a checkbox value, note, or evidence.",
  );

const addNoteInput = z
  .object({
    checklistId: z.string().min(1),
    stepId: z.string().min(1).nullable().optional(),
    content: z.string().trim().min(1).max(10_000),
  })
  .strict();

const updateSettingsInput = z
  .object({
    checklistId: z.string().min(1),
    continuationMode: modeSchema.optional(),
    status: userSettableStatusSchema.optional(),
  })
  .strict()
  .refine(
    (input) => input.continuationMode !== undefined || input.status !== undefined,
    "Provide a continuation mode or status.",
  );

const attachInput = z
  .object({
    threadId: z.string().min(1),
    templateId: z.string().min(1),
    continuationMode: modeSchema.optional(),
  })
  .strict();

const saveTemplateInput = z
  .object({
    templateId: z.string().min(1).nullable().optional(),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2_000),
    defaultMode: modeSchema,
    steps: z.array(templateStepInputSchema).min(1).max(100),
  })
  .strict();

const agentUpdateInput = z
  .object({
    stepId: z.string().min(1).optional(),
    checked: z.boolean().optional(),
    note: z.string().max(10_000).optional(),
    evidence: z.string().max(10_000).optional(),
    status: z.enum(["active", "paused"]).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.stepId !== undefined ||
      input.note !== undefined ||
      input.evidence !== undefined ||
      input.status !== undefined,
    "Provide a step update, note, evidence, or status.",
  );

export const rpcContract = defineRpcContract({
  listTemplates: {
    input: z.null(),
    output: z.object({ templates: z.array(templateSchema) }).strict(),
  },
  getForThread: {
    input: threadIdInput,
    output: z.object({ checklist: checklistSchema.nullable() }).strict(),
  },
  attach: {
    input: attachInput,
    output: checklistSchema,
  },
  saveTemplate: {
    input: saveTemplateInput,
    output: templateSchema,
  },
  deleteTemplate: {
    input: z.object({ templateId: z.string().min(1) }).strict(),
    output: z.object({ deleted: z.boolean() }).strict(),
  },
  updateSettings: {
    input: updateSettingsInput,
    output: checklistSchema,
  },
  updateStep: {
    input: updateStepInput,
    output: checklistSchema,
  },
  addNote: {
    input: addNoteInput,
    output: checklistSchema,
  },
  continue: {
    input: checklistIdInput,
    output: z
      .object({
        sent: z.boolean(),
        checklist: checklistSchema.nullable(),
      })
      .strict(),
  },
  resume: {
    input: checklistIdInput,
    output: checklistSchema,
  },
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingThreadError(error: unknown): boolean {
  const message = errorText(error).toLowerCase();
  return message.includes("thread not found") || message.includes("thread_not_found");
}

function isUnavailableThread(thread: { archivedAt: number | null; deletedAt: number | null }): boolean {
  return thread.archivedAt !== null || thread.deletedAt !== null;
}

function publish(bb: BbPluginApi, checklist: Checklist | null): void {
  if (!checklist) return;
  bb.realtime.publish(REALTIME_CHANNEL, {
    checklistId: checklist.id,
    threadId: checklist.threadId,
    updatedAt: checklist.updatedAt,
  });
}

function publishTemplate(bb: BbPluginApi, templateId: string): void {
  bb.realtime.publish(REALTIME_CHANNEL, {
    templateId,
    updatedAt: Date.now(),
  });
}

function reminderText(checklist: Checklist): string {
  const next = nextStep(checklist);
  const complete = checklist.steps.filter((step) => step.checked).length;
  const total = checklist.steps.length;
  return [
    `Agent Checklist reminder: "${checklist.name}" is ${complete} of ${total} steps complete.`,
    next
      ? `Continue with the next unchecked step: "${next.title}". ${next.description}`
      : "The checklist has no remaining unchecked steps.",
    "Use agent_checklist_update after completing a step. Leave the step unchecked and add a note if user input or an external dependency blocks progress.",
  ].join("\n\n");
}

async function reconcilePersistedThreads(bb: BbPluginApi, store: ChecklistStore): Promise<void> {
  await Promise.all(
    store.listAttachedThreadIds().map(async (threadId) => {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (isUnavailableThread(thread)) store.markOrphaned(threadId);
      } catch (error) {
        if (isMissingThreadError(error)) {
          store.markOrphaned(threadId);
        } else {
          bb.log.warn(`Could not reconcile Agent Checklist thread ${threadId}: ${errorText(error)}`);
        }
      }
    }),
  );
}

async function sendContinuation(
  bb: BbPluginApi,
  store: ChecklistStore,
  checklistId: string,
  manual: boolean,
  canSend: (threadId: string) => boolean,
): Promise<{ sent: boolean; checklist: Checklist | null }> {
  const claimed = store.claimContinuation(checklistId, manual);
  if (!claimed) {
    return { sent: false, checklist: claimed };
  }
  if (claimed.status === "limit_reached" || !hasIncompleteSteps(claimed)) {
    publish(bb, claimed);
    return { sent: false, checklist: claimed };
  }

  let thread;
  try {
    thread = await bb.sdk.threads.get({ threadId: claimed.threadId });
  } catch (error) {
    if (isMissingThreadError(error)) {
      const orphaned = store.markOrphaned(claimed.threadId);
      publish(bb, orphaned);
      return { sent: false, checklist: orphaned };
    }
    const paused = store.releaseContinuationClaim(
      claimed.id,
      claimed.lastReminderAt,
      errorText(error),
    );
    publish(bb, paused);
    throw error;
  }
  if (isUnavailableThread(thread) || !canSend(claimed.threadId)) {
    const orphaned = store.markOrphaned(claimed.threadId);
    publish(bb, orphaned);
    return { sent: false, checklist: orphaned };
  }

  try {
    await bb.sdk.threads.send({
      threadId: claimed.threadId,
      mode: "auto",
      input: [
        {
          type: "text",
          text: reminderText(claimed),
          visibility: "agent-only",
          mentions: [],
        },
      ],
    });
  } catch (error) {
    const paused = store.releaseContinuationClaim(
      claimed.id,
      claimed.lastReminderAt,
      errorText(error),
    );
    publish(bb, paused);
    throw error;
  }
  store.completeContinuationClaim(claimed.id, claimed.lastReminderAt);
  const updated = store.getChecklist(claimed.id);
  publish(bb, updated);
  return { sent: true, checklist: updated };
}

function parseMaxContinuations(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : DEFAULT_MAX_CONTINUATIONS;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    maxContinuations: {
      type: "string",
      label: "Maximum automatic continuations",
      description: "Stops an automatic checklist after this many reminders until you resume it.",
      default: String(DEFAULT_MAX_CONTINUATIONS),
    },
  });

  const db = bb.storage.database();
  db.pragma("foreign_keys = ON");
  bb.storage.migrate(db, migrations);
  const store = new ChecklistStore(db);
  store.seedBuiltInTemplates();
  store.recoverInterruptedContinuationClaims();
  await reconcilePersistedThreads(bb, store);
  const continuationsInFlight = new Set<string>();
  const threadLifecycleVersions = new Map<string, number>();

  const lifecycleVersion = (threadId: string): number =>
    threadLifecycleVersions.get(threadId) ?? 0;

  const markThreadUnavailable = (threadId: string): Checklist | null => {
    threadLifecycleVersions.set(threadId, lifecycleVersion(threadId) + 1);
    return store.markOrphaned(threadId);
  };

  const guardedSendContinuation = async (
    checklistId: string,
    manual: boolean,
  ): Promise<{ sent: boolean; checklist: Checklist | null }> => {
    if (continuationsInFlight.has(checklistId)) {
      return { sent: false, checklist: store.getChecklist(checklistId) };
    }
    const current = store.getChecklist(checklistId);
    const version = current ? lifecycleVersion(current.threadId) : 0;
    continuationsInFlight.add(checklistId);
    try {
      return await sendContinuation(
        bb,
        store,
        checklistId,
        manual,
        (threadId) => lifecycleVersion(threadId) === version,
      );
    } finally {
      continuationsInFlight.delete(checklistId);
    }
  };

  const continueIfIdle = async (checklist: Checklist): Promise<Checklist> => {
    let thread;
    try {
      thread = await bb.sdk.threads.get({ threadId: checklist.threadId });
    } catch (error) {
      if (isMissingThreadError(error)) {
        const orphaned = markThreadUnavailable(checklist.threadId);
        publish(bb, orphaned);
        return orphaned ?? checklist;
      }
      bb.log.warn(`Could not check checklist thread before re-enabling continuation: ${errorText(error)}`);
      return checklist;
    }
    if (isUnavailableThread(thread)) {
      const orphaned = markThreadUnavailable(checklist.threadId);
      publish(bb, orphaned);
      return orphaned ?? checklist;
    }
    if (thread.status !== "idle") return checklist;
    const result = await guardedSendContinuation(checklist.id, false);
    return result.checklist ?? checklist;
  };

  bb.rpc.register(rpcContract, {
    listTemplates() {
      return { templates: store.listTemplates() };
    },
    getForThread({ threadId }) {
      return { checklist: store.getChecklistForThread(threadId) };
    },
    async attach({ threadId, templateId, continuationMode }) {
      const configured = await settings.get();
      const lifecycleBeforeLookup = lifecycleVersion(threadId);
      const thread = await bb.sdk.threads.get({ threadId });
      if (
        isUnavailableThread(thread) ||
        lifecycleVersion(threadId) !== lifecycleBeforeLookup
      ) {
        throw new Error("Cannot attach a checklist to an archived or deleted thread");
      }
      const checklist = store.createChecklist(
        threadId,
        templateId,
        continuationMode,
        parseMaxContinuations(configured.maxContinuations),
      );
      publish(bb, checklist);
      return checklist;
    },
    saveTemplate(input) {
      const template = store.saveTemplate(input);
      publishTemplate(bb, template.id);
      return template;
    },
    deleteTemplate({ templateId }) {
      store.deleteTemplate(templateId);
      publishTemplate(bb, templateId);
      return { deleted: true };
    },
    async updateSettings(input) {
      const current = store.getChecklist(input.checklistId);
      const checklist = store.updateSettings(input.checklistId, input);
      const shouldContinue =
        checklist.status === "active" &&
        checklist.continuationMode === "automatic" &&
        hasIncompleteSteps(checklist) &&
        (input.status === "active" ||
          (input.continuationMode === "automatic" && current?.continuationMode !== "automatic"));
      const updated = shouldContinue ? await continueIfIdle(checklist) : checklist;
      publish(bb, updated);
      return updated;
    },
    updateStep(input) {
      const checklist = store.updateStep(input.checklistId, input.stepId, input);
      publish(bb, checklist);
      return checklist;
    },
    addNote(input) {
      const checklist = store.addNote(input.checklistId, input.stepId ?? null, input.content);
      publish(bb, checklist);
      return checklist;
    },
    async continue({ checklistId }) {
      const result = await guardedSendContinuation(checklistId, true);
      return result;
    },
    resume({ checklistId }) {
      const checklist = store.resumeAfterLimit(checklistId);
      publish(bb, checklist);
      return checklist;
    },
  });

  bb.agents.registerTool({
    name: "agent_checklist_get",
    description: "Read the persisted Agent Checklist attached to the current BB thread.",
    instructions:
      "Read the checklist before starting work and after major progress. Use the structured checkbox state, not Markdown, as the source of truth.",
    experimental_statusLabels: {
      pending: "Reading Agent Checklist",
      completed: "Agent Checklist read",
    },
    parameters: z.object({}).strict(),
    execute(_input, context) {
      return JSON.stringify({ checklist: store.getChecklistForThread(context.threadId) });
    },
  });

  bb.agents.registerTool({
    name: "agent_checklist_update",
    description: "Update a step, note, evidence, or pause state in the current thread's Agent Checklist.",
    instructions:
      "Check a step when it is complete. Add notes or evidence when useful. If user input or an external dependency blocks progress, leave the step unchecked and add a note, then pause the checklist.",
    experimental_statusLabels: {
      pending: "Updating Agent Checklist",
      completed: "Agent Checklist updated",
    },
    parameters: agentUpdateInput,
    execute(input, context) {
      const checklist = store.getChecklistForThread(context.threadId);
      if (!checklist) {
        return JSON.stringify({ checklist: null, message: "No Agent Checklist is attached to this thread." });
      }
      const updated = store.applyAgentUpdate(checklist.id, input);
      publish(bb, updated);
      return JSON.stringify({ checklist: updated });
    },
  });

  bb.agents.configure(() => ({
    tools: ["agent_checklist_get", "agent_checklist_update"],
    skills: [],
    instructions:
      "When an Agent Checklist is attached to this thread, use its tools to read the steps and persist checkbox updates, notes, and evidence as you work.",
  }));

  bb.events.on("thread.idle", ({ thread }) => {
    void (async () => {
      const checklist = store.getChecklistForThread(thread.id);
      if (!checklist || !hasIncompleteSteps(checklist) || checklist.status !== "active") return;
      if (checklist.continuationMode === "automatic") {
        await guardedSendContinuation(checklist.id, false);
      } else if (checklist.continuationMode === "approval") {
        const awaiting = store.markAwaitingApproval(checklist.id);
        publish(bb, awaiting);
      }
    })().catch((error) => {
      bb.log.error(`Automatic checklist continuation failed: ${errorText(error)}`);
    });
  });

  bb.events.on("thread.archived", ({ thread }) => publish(bb, markThreadUnavailable(thread.id)));
  bb.events.on("thread.deleted", ({ thread }) => publish(bb, markThreadUnavailable(thread.id)));
}
