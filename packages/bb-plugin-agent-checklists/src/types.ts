export const continuationModes = ["automatic", "approval", "tracking"] as const;
export type ContinuationMode = (typeof continuationModes)[number];

export const checklistStatuses = [
  "active",
  "awaiting_approval",
  "paused",
  "completed",
  "limit_reached",
  "orphaned",
] as const;
export type ChecklistStatus = (typeof checklistStatuses)[number];

export const userSettableChecklistStatuses = ["active", "paused"] as const;
export type UserSettableChecklistStatus = (typeof userSettableChecklistStatuses)[number];

export interface TemplateStep {
  id: string;
  position: number;
  title: string;
  description: string;
}

export interface ChecklistTemplate {
  id: string;
  name: string;
  description: string;
  defaultMode: ContinuationMode;
  steps: TemplateStep[];
  createdAt: number;
  updatedAt: number;
}

export interface ChecklistStep {
  id: string;
  templateStepId: string;
  position: number;
  title: string;
  description: string;
  checked: boolean;
  note: string | null;
  evidence: string | null;
  checkedAt: number | null;
  updatedAt: number;
}

export interface ChecklistNote {
  id: string;
  stepId: string | null;
  content: string;
  createdAt: number;
}

export interface Checklist {
  id: string;
  templateId: string;
  threadId: string;
  name: string;
  description: string;
  status: ChecklistStatus;
  continuationMode: ContinuationMode;
  continuationCount: number;
  maxContinuations: number;
  lastReminderAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  steps: ChecklistStep[];
  notes: ChecklistNote[];
}

export function completedStepCount(checklist: Checklist): number {
  return checklist.steps.filter((step) => step.checked).length;
}

export function nextStep(checklist: Checklist): ChecklistStep | null {
  return checklist.steps.find((step) => !step.checked) ?? null;
}

export function hasIncompleteSteps(checklist: Checklist): boolean {
  return checklist.steps.some((step) => !step.checked);
}
