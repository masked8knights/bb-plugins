import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  Checklist,
  ChecklistNote,
  ChecklistStatus,
  ChecklistStep,
  ChecklistTemplate,
  ContinuationMode,
  UserSettableChecklistStatus,
} from "./types";
import { userSettableChecklistStatuses } from "./types";
import { BUILT_IN_TEMPLATES } from "./templates";

export const migrations = [
  `CREATE TABLE IF NOT EXISTS checklist_templates (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL,
     default_mode TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS checklist_template_steps (
     id TEXT PRIMARY KEY,
     template_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     FOREIGN KEY (template_id) REFERENCES checklist_templates(id) ON DELETE CASCADE,
     UNIQUE(template_id, position)
   )`,
  `CREATE TABLE IF NOT EXISTS checklists (
     id TEXT PRIMARY KEY,
     template_id TEXT NOT NULL,
     thread_id TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     description TEXT NOT NULL,
     status TEXT NOT NULL,
     continuation_mode TEXT NOT NULL,
     continuation_count INTEGER NOT NULL DEFAULT 0,
     max_continuations INTEGER NOT NULL DEFAULT 8,
     last_reminder_at INTEGER,
     last_error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     FOREIGN KEY (template_id) REFERENCES checklist_templates(id)
   )`,
  `CREATE TABLE IF NOT EXISTS checklist_steps (
     id TEXT PRIMARY KEY,
     checklist_id TEXT NOT NULL,
     template_step_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     checked INTEGER NOT NULL DEFAULT 0,
     note TEXT,
     evidence TEXT,
     checked_at INTEGER,
     updated_at INTEGER NOT NULL,
     FOREIGN KEY (checklist_id) REFERENCES checklists(id) ON DELETE CASCADE,
     UNIQUE(checklist_id, template_step_id)
   )`,
  `CREATE TABLE IF NOT EXISTS checklist_notes (
     id TEXT PRIMARY KEY,
     checklist_id TEXT NOT NULL,
     step_id TEXT,
     content TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     FOREIGN KEY (checklist_id) REFERENCES checklists(id) ON DELETE CASCADE,
     FOREIGN KEY (step_id) REFERENCES checklist_steps(id) ON DELETE SET NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_checklists_thread ON checklists(thread_id)`,
  `CREATE INDEX IF NOT EXISTS idx_checklist_steps_checklist ON checklist_steps(checklist_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_checklist_notes_checklist ON checklist_notes(checklist_id, created_at)`,
  `ALTER TABLE checklists ADD COLUMN continuation_claimed_at INTEGER`,
];

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integer(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function nullableInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : integer(value);
}

function toMode(value: unknown): ContinuationMode {
  return value === "approval" || value === "tracking" ? value : "automatic";
}

function toStatus(value: unknown): ChecklistStatus {
  switch (value) {
    case "awaiting_approval":
    case "paused":
    case "completed":
    case "limit_reached":
    case "orphaned":
      return value;
    default:
      return "active";
  }
}

const BUILT_IN_TEMPLATE_IDS = new Set(BUILT_IN_TEMPLATES.map((template) => template.id));

function templateFromRows(templateRow: Row, stepRows: Row[]): ChecklistTemplate {
  return {
    id: text(templateRow.id),
    name: text(templateRow.name),
    description: text(templateRow.description),
    defaultMode: toMode(templateRow.default_mode),
    isBuiltIn: BUILT_IN_TEMPLATE_IDS.has(text(templateRow.id)),
    steps: stepRows.map((row) => ({
      id: text(row.id),
      position: integer(row.position),
      title: text(row.title),
      description: text(row.description),
    })),
    createdAt: integer(templateRow.created_at),
    updatedAt: integer(templateRow.updated_at),
  };
}

function stepFromRow(row: Row): ChecklistStep {
  return {
    id: text(row.id),
    templateStepId: text(row.template_step_id),
    position: integer(row.position),
    title: text(row.title),
    description: text(row.description),
    checked: integer(row.checked) === 1,
    note: nullableText(row.note),
    evidence: nullableText(row.evidence),
    checkedAt: nullableInteger(row.checked_at),
    updatedAt: integer(row.updated_at),
  };
}

function noteFromRow(row: Row): ChecklistNote {
  return {
    id: text(row.id),
    stepId: nullableText(row.step_id),
    content: text(row.content),
    createdAt: integer(row.created_at),
  };
}

export class ChecklistStore {
  constructor(private readonly db: Database.Database) {}

  seedBuiltInTemplates(): void {
    const insertTemplate = this.db.prepare(
      `INSERT OR IGNORE INTO checklist_templates
       (id, name, description, default_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertStep = this.db.prepare(
      `INSERT OR IGNORE INTO checklist_template_steps
       (id, template_id, position, title, description)
       VALUES (?, ?, ?, ?, ?)`,
    );

    const seed = this.db.transaction(() => {
      for (const template of BUILT_IN_TEMPLATES) {
        insertTemplate.run(
          template.id,
          template.name,
          template.description,
          template.defaultMode,
          template.createdAt,
          template.updatedAt,
        );
        for (const step of template.steps) {
          insertStep.run(
            step.id,
            template.id,
            step.position,
            step.title,
            step.description,
          );
        }
      }
    });
    seed();
  }

  listTemplates(): ChecklistTemplate[] {
    const rows = this.db
      .prepare("SELECT * FROM checklist_templates ORDER BY name")
      .all() as Row[];
    return rows.map((row) =>
      templateFromRows(
        row,
        this.db
          .prepare(
            "SELECT * FROM checklist_template_steps WHERE template_id = ? ORDER BY position",
          )
          .all(row.id) as Row[],
      ),
    );
  }

  getTemplate(templateId: string): ChecklistTemplate | null {
    const row = this.db
      .prepare("SELECT * FROM checklist_templates WHERE id = ?")
      .get(templateId) as Row | undefined;
    if (!row) return null;
    const steps = this.db
      .prepare(
        "SELECT * FROM checklist_template_steps WHERE template_id = ? ORDER BY position",
      )
      .all(templateId) as Row[];
    return templateFromRows(row, steps);
  }

  saveTemplate(input: {
    templateId?: string | null;
    name: string;
    description: string;
    defaultMode: ContinuationMode;
    steps: Array<{ title: string; description: string }>;
  }): ChecklistTemplate {
    const name = input.name.trim();
    const description = input.description.trim();
    const steps = input.steps.map((step) => ({
      title: step.title.trim(),
      description: step.description.trim(),
    }));
    if (!name) throw new Error("Checklist name cannot be empty");
    if (steps.length === 0) throw new Error("A checklist needs at least one step");
    if (steps.some((step) => !step.title)) throw new Error("Every checklist step needs a title");

    const templateId = input.templateId?.trim() || `custom-${randomUUID()}`;
    const existing = this.getTemplate(templateId);
    if (existing?.isBuiltIn) throw new Error("Built-in checklists cannot be edited");
    if (input.templateId && !existing) throw new Error("Checklist template not found");

    const now = Date.now();
    const insertStep = this.db.prepare(
      `INSERT INTO checklist_template_steps
       (id, template_id, position, title, description)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const save = this.db.transaction(() => {
      if (existing) {
        this.db
          .prepare(
            `UPDATE checklist_templates
             SET name = ?, description = ?, default_mode = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(name, description, input.defaultMode, now, templateId);
        this.db
          .prepare("DELETE FROM checklist_template_steps WHERE template_id = ?")
          .run(templateId);
      } else {
        this.db
          .prepare(
            `INSERT INTO checklist_templates
             (id, name, description, default_mode, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(templateId, name, description, input.defaultMode, now, now);
      }
      steps.forEach((step, position) => {
        insertStep.run(randomUUID(), templateId, position, step.title, step.description);
      });
    });
    save();
    return this.getTemplate(templateId)!;
  }

  deleteTemplate(templateId: string): void {
    const template = this.getTemplate(templateId);
    if (!template) throw new Error("Checklist template not found");
    if (template.isBuiltIn) throw new Error("Built-in checklists cannot be deleted");
    const used = this.db
      .prepare("SELECT 1 FROM checklists WHERE template_id = ? LIMIT 1")
      .get(templateId);
    if (used) throw new Error("A checklist attached to a thread cannot be deleted");
    const remove = this.db.transaction(() => {
      this.db.prepare("DELETE FROM checklist_template_steps WHERE template_id = ?").run(templateId);
      this.db.prepare("DELETE FROM checklist_templates WHERE id = ?").run(templateId);
    });
    remove();
  }

  private getChecklistRow(checklistId: string): Row | undefined {
    return this.db
      .prepare("SELECT * FROM checklists WHERE id = ?")
      .get(checklistId) as Row | undefined;
  }

  private hydrate(row: Row): Checklist {
    const checklistId = text(row.id);
    const steps = this.db
      .prepare("SELECT * FROM checklist_steps WHERE checklist_id = ? ORDER BY position")
      .all(checklistId) as Row[];
    const notes = this.db
      .prepare("SELECT * FROM checklist_notes WHERE checklist_id = ? ORDER BY created_at, id")
      .all(checklistId) as Row[];
    return {
      id: checklistId,
      templateId: text(row.template_id),
      threadId: text(row.thread_id),
      name: text(row.name),
      description: text(row.description),
      status: toStatus(row.status),
      continuationMode: toMode(row.continuation_mode),
      continuationCount: integer(row.continuation_count),
      maxContinuations: integer(row.max_continuations),
      lastReminderAt: nullableInteger(row.last_reminder_at),
      lastError: nullableText(row.last_error),
      createdAt: integer(row.created_at),
      updatedAt: integer(row.updated_at),
      steps: steps.map(stepFromRow),
      notes: notes.map(noteFromRow),
    };
  }

  getChecklist(checklistId: string): Checklist | null {
    const row = this.getChecklistRow(checklistId);
    return row ? this.hydrate(row) : null;
  }

  listAttachedThreadIds(): string[] {
    return (this.db
      .prepare("SELECT thread_id FROM checklists ORDER BY thread_id")
      .all() as Row[])
      .map((row) => text(row.thread_id));
  }

  getChecklistForThread(threadId: string): Checklist | null {
    const row = this.db
      .prepare("SELECT * FROM checklists WHERE thread_id = ?")
      .get(threadId) as Row | undefined;
    if (!row) return null;
    const checklist = this.hydrate(row);
    return this.reconcileCompletion(checklist);
  }

  createChecklist(
    threadId: string,
    templateId: string,
    mode: ContinuationMode | undefined,
    maxContinuations: number,
  ): Checklist {
    const existing = this.getChecklistForThread(threadId);
    if (existing) return existing;
    const template = this.getTemplate(templateId);
    if (!template) throw new Error("Checklist template not found");
    const now = Date.now();
    const checklistId = randomUUID();
    const insertChecklist = this.db.prepare(
      `INSERT INTO checklists
       (id, template_id, thread_id, name, description, status, continuation_mode,
        continuation_count, max_continuations, last_reminder_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?, NULL, NULL, ?, ?)`,
    );
    const insertStep = this.db.prepare(
      `INSERT INTO checklist_steps
       (id, checklist_id, template_step_id, position, title, description, checked,
        note, evidence, checked_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?)`,
    );
    const selectedMode = mode ?? template.defaultMode;
    const create = this.db.transaction(() => {
      insertChecklist.run(
        checklistId,
        template.id,
        threadId,
        template.name,
        template.description,
        selectedMode,
        Math.max(1, Math.floor(maxContinuations)),
        now,
        now,
      );
      for (const step of template.steps) {
        insertStep.run(
          randomUUID(),
          checklistId,
          step.id,
          step.position,
          step.title,
          step.description,
          now,
        );
      }
    });
    create();
    return this.getChecklist(checklistId)!;
  }

  private reconcileCompletion(checklist: Checklist): Checklist {
    if (checklist.status === "orphaned") return checklist;
    const complete = checklist.steps.length > 0 && checklist.steps.every((step) => step.checked);
    if (complete && checklist.status !== "completed") {
      const now = Date.now();
      this.db
        .prepare("UPDATE checklists SET status = 'completed', updated_at = ? WHERE id = ?")
        .run(now, checklist.id);
      return { ...checklist, status: "completed", updatedAt: now };
    }
    if (!complete && checklist.status === "completed") {
      const now = Date.now();
      this.db
        .prepare("UPDATE checklists SET status = 'active', updated_at = ? WHERE id = ?")
        .run(now, checklist.id);
      return { ...checklist, status: "active", updatedAt: now };
    }
    return checklist;
  }

  updateSettings(
    checklistId: string,
    input: { continuationMode?: ContinuationMode; status?: UserSettableChecklistStatus },
  ): Checklist {
    const current = this.getChecklist(checklistId);
    if (!current) throw new Error("Checklist not found");
    if (current.status === "orphaned") {
      throw new Error("This checklist belongs to an unavailable thread");
    }
    if (
      input.status !== undefined &&
      !userSettableChecklistStatuses.includes(input.status)
    ) {
      throw new Error("Invalid checklist status");
    }
    if (current.status === "completed" && input.status !== undefined) {
      throw new Error("A completed checklist cannot change status until a step is unchecked");
    }
    const nextStatus =
      input.status ??
      (current.status === "awaiting_approval" && input.continuationMode !== "approval"
        ? "active"
        : current.status);
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE checklists
         SET continuation_mode = ?, status = ?, last_error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(input.continuationMode ?? current.continuationMode, nextStatus, now, checklistId);
    return this.getChecklist(checklistId)!;
  }

  updateStep(
    checklistId: string,
    stepId: string,
    input: { checked?: boolean; note?: string | null; evidence?: string | null },
  ): Checklist {
    const current = this.getChecklist(checklistId);
    if (!current) throw new Error("Checklist not found");
    if (current.status === "orphaned") {
      throw new Error("This checklist belongs to an unavailable thread");
    }
    const step = this.db
      .prepare("SELECT * FROM checklist_steps WHERE id = ? AND checklist_id = ?")
      .get(stepId, checklistId) as Row | undefined;
    if (!step) throw new Error("Checklist step not found");
    const now = Date.now();
    const checked = input.checked === undefined ? integer(step.checked) === 1 : input.checked;
    const note = input.note === undefined ? nullableText(step.note) : input.note?.trim() || null;
    const evidence =
      input.evidence === undefined ? nullableText(step.evidence) : input.evidence?.trim() || null;
    this.db
      .prepare(
        `UPDATE checklist_steps
         SET checked = ?, note = ?, evidence = ?, checked_at = ?, updated_at = ?
         WHERE id = ? AND checklist_id = ?`,
      )
      .run(checked ? 1 : 0, note, evidence, checked ? now : null, now, stepId, checklistId);
    const checklist = this.getChecklist(checklistId);
    if (!checklist) throw new Error("Checklist not found");
    return this.reconcileCompletion(checklist);
  }

  addNote(checklistId: string, stepId: string | null, content: string): Checklist {
    const trimmed = content.trim();
    if (!trimmed) throw new Error("Note cannot be empty");
    const current = this.getChecklist(checklistId);
    if (!current) throw new Error("Checklist not found");
    if (current.status === "orphaned") {
      throw new Error("This checklist belongs to an unavailable thread");
    }
    if (stepId) {
      const step = this.db
        .prepare("SELECT id FROM checklist_steps WHERE id = ? AND checklist_id = ?")
        .get(stepId, checklistId);
      if (!step) throw new Error("Checklist step not found");
    }
    this.db
      .prepare(
        "INSERT INTO checklist_notes (id, checklist_id, step_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(randomUUID(), checklistId, stepId, trimmed, Date.now());
    return this.getChecklist(checklistId)!;
  }

  applyAgentUpdate(
    checklistId: string,
    input: {
      stepId?: string;
      checked?: boolean;
      note?: string;
      evidence?: string;
      status?: UserSettableChecklistStatus;
    },
  ): Checklist {
    const current = this.getChecklist(checklistId);
    if (!current) throw new Error("Checklist not found");
    if (current.status === "orphaned") {
      throw new Error("This checklist belongs to an unavailable thread");
    }
    if (
      input.status !== undefined &&
      !userSettableChecklistStatuses.includes(input.status)
    ) {
      throw new Error("Invalid checklist status");
    }

    const step = input.stepId
      ? current.steps.find((candidate) => candidate.id === input.stepId)
      : undefined;
    if (input.stepId && !step) throw new Error("Checklist step not found");

    let noteContent: string | null = null;
    if (!input.stepId && (input.note !== undefined || input.evidence !== undefined)) {
      const note = input.note?.trim() ?? "";
      const evidence = input.evidence?.trim() ?? "";
      noteContent = [note, evidence ? `Evidence: ${evidence}` : null]
        .filter(Boolean)
        .join("\n\n");
      if (!noteContent) throw new Error("Note cannot be empty");
    }

    const projectedSteps = step
      ? current.steps.map((candidate) =>
          candidate.id === step.id
            ? {
                ...candidate,
                checked: input.checked ?? candidate.checked,
                note: input.note === undefined ? candidate.note : input.note.trim() || null,
                evidence:
                  input.evidence === undefined
                    ? candidate.evidence
                    : input.evidence.trim() || null,
              }
            : candidate,
        )
      : current.steps;
    const complete =
      projectedSteps.length > 0 && projectedSteps.every((candidate) => candidate.checked);
    if (complete && input.status !== undefined) {
      throw new Error("A completed checklist cannot change status until a step is unchecked");
    }
    const nextStatus = complete
      ? "completed"
      : current.status === "completed"
        ? input.status ?? "active"
        : input.status ?? current.status;
    const now = Date.now();

    const apply = this.db.transaction(() => {
      if (step) {
        const nextStep = projectedSteps.find((candidate) => candidate.id === step.id)!;
        this.db
          .prepare(
            `UPDATE checklist_steps
             SET checked = ?, note = ?, evidence = ?, checked_at = ?, updated_at = ?
             WHERE id = ? AND checklist_id = ?`,
          )
          .run(
            nextStep.checked ? 1 : 0,
            nextStep.note,
            nextStep.evidence,
            nextStep.checked ? now : null,
            now,
            step.id,
            checklistId,
          );
      }
      if (noteContent) {
        this.db
          .prepare(
            "INSERT INTO checklist_notes (id, checklist_id, step_id, content, created_at) VALUES (?, ?, NULL, ?, ?)",
          )
          .run(randomUUID(), checklistId, noteContent, now);
      }
      if (step || input.status !== undefined) {
        this.db
          .prepare(
            `UPDATE checklists
             SET status = ?, last_error = CASE WHEN ? = 1 THEN NULL ELSE last_error END,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(nextStatus, input.status !== undefined ? 1 : 0, now, checklistId);
      }
    });
    apply();
    return this.getChecklist(checklistId)!;
  }

  markAwaitingApproval(checklistId: string): Checklist | null {
    const checklist = this.getChecklist(checklistId);
    if (!checklist || checklist.status !== "active" || checklist.continuationMode !== "approval") {
      return checklist;
    }
    const now = Date.now();
    this.db
      .prepare("UPDATE checklists SET status = 'awaiting_approval', updated_at = ? WHERE id = ?")
      .run(now, checklistId);
    return this.getChecklist(checklistId);
  }

  claimContinuation(checklistId: string, manual: boolean): Checklist | null {
    let checklist = this.getChecklist(checklistId);
    if (!checklist || !checklist.steps.some((step) => !step.checked)) return checklist;
    if (manual) {
      if (checklist.status !== "awaiting_approval" || checklist.continuationMode !== "approval") {
        return null;
      }
    } else if (checklist.status !== "active" || checklist.continuationMode !== "automatic") {
      return null;
    }
    if (checklist.continuationCount >= checklist.maxContinuations) {
      const now = Date.now();
      this.db
        .prepare("UPDATE checklists SET status = 'limit_reached', updated_at = ? WHERE id = ?")
        .run(now, checklistId);
      return this.getChecklist(checklistId);
    }
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE checklists
         SET status = 'active', continuation_count = continuation_count + 1,
             last_reminder_at = ?, continuation_claimed_at = ?, last_error = NULL, updated_at = ?
         WHERE id = ? AND continuation_count < max_continuations
           AND status IN ('active', 'awaiting_approval')`,
      )
      .run(now, now, now, checklistId);
    if (result.changes !== 1) return null;
    checklist = this.getChecklist(checklistId);
    return checklist;
  }

  resumeAfterLimit(checklistId: string): Checklist {
    const current = this.getChecklist(checklistId);
    if (!current) throw new Error("Checklist not found");
    if (current.status !== "limit_reached") {
      throw new Error("This checklist has not reached its continuation limit");
    }
    if (!current.steps.some((step) => !step.checked)) {
      return this.reconcileCompletion(current);
    }
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE checklists
         SET status = 'active', continuation_count = 0, last_reminder_at = NULL,
             continuation_claimed_at = NULL, last_error = NULL, updated_at = ?
         WHERE id = ? AND status = 'limit_reached'`,
      )
      .run(now, checklistId);
    return this.getChecklist(checklistId)!;
  }

  recordContinuationError(checklistId: string, error: string): Checklist | null {
    const current = this.getChecklist(checklistId);
    if (!current || current.status === "orphaned") return current;
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE checklists SET status = 'paused', continuation_claimed_at = NULL, last_error = ?, updated_at = ? WHERE id = ?",
      )
      .run(error.slice(0, 1000), now, checklistId);
    return this.getChecklist(checklistId);
  }

  recoverInterruptedContinuationClaims(): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE checklists
         SET status = CASE WHEN status = 'completed' THEN status ELSE 'paused' END,
             continuation_count = CASE WHEN continuation_count > 0 THEN continuation_count - 1 ELSE 0 END,
             last_reminder_at = NULL,
             continuation_claimed_at = NULL,
             last_error = 'A continuation was interrupted before delivery; resume to retry.',
             updated_at = ?
         WHERE continuation_claimed_at IS NOT NULL AND status != 'orphaned'`,
      )
      .run(now);
    return result.changes;
  }

  completeContinuationClaim(checklistId: string, claimedAt: number | null): Checklist | null {
    if (claimedAt === null) return this.getChecklist(checklistId);
    this.db
      .prepare(
        `UPDATE checklists
         SET continuation_claimed_at = NULL
         WHERE id = ? AND continuation_claimed_at = ?`,
      )
      .run(checklistId, claimedAt);
    return this.getChecklist(checklistId);
  }

  releaseContinuationClaim(
    checklistId: string,
    claimedAt: number | null,
    error: string,
  ): Checklist | null {
    if (claimedAt === null) return this.recordContinuationError(checklistId, error);
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE checklists
         SET status = CASE WHEN status IN ('orphaned', 'completed') THEN status ELSE 'paused' END,
             continuation_count = CASE WHEN continuation_count > 0 THEN continuation_count - 1 ELSE 0 END,
             last_reminder_at = NULL,
             continuation_claimed_at = NULL,
             last_error = ?, updated_at = ?
         WHERE id = ? AND continuation_claimed_at = ? AND status != 'orphaned'`,
      )
      .run(error.slice(0, 1000), now, checklistId, claimedAt);
    return this.getChecklist(checklistId);
  }

  markOrphaned(threadId: string): Checklist | null {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE checklists
         SET status = 'orphaned',
             continuation_claimed_at = NULL,
             updated_at = ?
         WHERE thread_id = ?`,
      )
      .run(now, threadId);
    const row = this.db
      .prepare("SELECT * FROM checklists WHERE thread_id = ?")
      .get(threadId) as Row | undefined;
    return row ? this.hydrate(row) : null;
  }
}
