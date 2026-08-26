import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  useBbNavigate,
  useComposerView,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginComposerScope,
  type PluginNavPanelProps,
  type PluginPendingInteractionProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { callRpc } from "./src/rpc";
import type {
  Checklist,
  ChecklistStep,
  ChecklistTemplate,
  ContinuationMode,
} from "./src/types";

const REALTIME_CHANNEL = "checklists";
type RpcContract = typeof rpcContract;

const buttonClass =
  "inline-flex min-h-8 items-center justify-center rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const primaryButtonClass =
  "inline-flex min-h-8 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const quietButtonClass =
  "inline-flex min-h-8 items-center justify-center rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const iconButtonClass =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const fieldClass =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring";
const modeButtonClass = (selected: boolean) =>
  `inline-flex min-h-8 items-center justify-center px-2.5 text-xs font-medium transition-colors focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 ${
    selected
      ? "bg-background text-foreground shadow-sm"
      : "text-muted-foreground hover:bg-state-hover hover:text-foreground"
  }`;

const modeLabels: Record<ContinuationMode, string> = {
  automatic: "Automatic",
  approval: "Approval",
  tracking: "Tracking only",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusLabel(status: Checklist["status"]): string {
  switch (status) {
    case "awaiting_approval":
      return "Waiting for approval";
    case "paused":
      return "Paused";
    case "completed":
      return "Complete";
    case "closed":
      return "Closed";
    case "limit_reached":
      return "Continuation limit reached";
    case "orphaned":
      return "Thread unavailable";
    default:
      return "Active";
  }
}

function statusTone(status: Checklist["status"]): string {
  switch (status) {
    case "completed":
      return "text-success";
    case "paused":
    case "awaiting_approval":
    case "limit_reached":
      return "text-warning";
    case "orphaned":
      return "text-destructive";
    case "closed":
      return "text-muted-foreground";
    default:
      return "text-primary";
  }
}

function completedCount(checklist: Checklist): number {
  return checklist.steps.filter((step) => step.checked).length;
}

function LoadingState() {
  return <div className="p-5 text-sm text-muted-foreground">Loading Checklist…</div>;
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
      {message}
    </div>
  );
}

type PickerTemplate = {
  id: string;
  name: string;
};

function AgentChecklistPicker({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const navigate = useBbNavigate();
  const payload = interaction.payload as { templates?: PickerTemplate[] } | null;
  const templates = payload?.templates ?? [];

  const createChecklist = async () => {
    await cancel();
    navigate.toPluginPanel("checklists", { subPath: "template/new" });
  };

  return (
    <div className="flex items-center gap-2">
      {templates.length === 0 ? (
        <>
          <span className="min-w-0 flex-1 text-sm text-muted-foreground">No saved Checklists.</span>
          <button type="button" className={buttonClass} onClick={() => void createChecklist()}>
            New Checklist
          </button>
        </>
      ) : (
        <>
          <label className="sr-only" htmlFor="agent-checklist-picker">
            Checklist
          </label>
          <select
            id="agent-checklist-picker"
            className={`${fieldClass} min-w-0 flex-1`}
            defaultValue=""
            autoFocus
            onChange={(event) => {
              const templateId = event.target.value;
              if (templateId) void submit({ templateId });
            }}
          >
            <option value="" disabled>
              Select a checklist…
            </option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </>
      )}
      <button type="button" className={quietButtonClass} onClick={() => void cancel()}>
        Cancel
      </button>
    </div>
  );
}

type TemplateDraftStep = {
  id: string;
  title: string;
  description: string;
};

type TemplateDraft = {
  templateId: string | null;
  expectedUpdatedAt: number | null;
  name: string;
  description: string;
  defaultMode: ContinuationMode;
  steps: TemplateDraftStep[];
};

let draftStepCounter = 0;

function newDraftStep(): TemplateDraftStep {
  draftStepCounter += 1;
  return { id: `draft-step-${draftStepCounter}`, title: "", description: "" };
}

function draftFromTemplate(template: ChecklistTemplate): TemplateDraft {
  return {
    templateId: template.id,
    expectedUpdatedAt: template.updatedAt,
    name: template.name,
    description: template.description,
    defaultMode: template.defaultMode,
    steps: template.steps.map((step) => ({
      id: step.id,
      title: step.title,
      description: step.description,
    })),
  };
}

function blankTemplateDraft(): TemplateDraft {
  return {
    templateId: null,
    expectedUpdatedAt: null,
    name: "New checklist",
    description: "",
    defaultMode: "automatic",
    steps: [newDraftStep()],
  };
}

function TemplateEditor({
  template,
  onSaved,
  onDeleted,
}: {
  template: ChecklistTemplate | null;
  onSaved: (template: ChecklistTemplate) => void;
  onDeleted: (templateId: string) => void;
}) {
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  const [draft, setDraft] = useState<TemplateDraft>(() =>
    template ? draftFromTemplate(template) : blankTemplateDraft(),
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [keyboardDragIndex, setKeyboardDragIndex] = useState<number | null>(null);
  const pointerDrag = useRef<{ index: number; pointerId: number } | null>(null);
  const editorBusy = saving || deleting;

  const updateStep = (index: number, field: "title" | "description", value: string) => {
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step, stepIndex) =>
        stepIndex === index ? { ...step, [field]: value } : step,
      ),
    }));
  };

  const reorderStep = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || toIndex < 0 || toIndex >= draft.steps.length) return;
    setDraft((current) => {
      const steps = [...current.steps];
      const [moved] = steps.splice(fromIndex, 1);
      if (!moved) return current;
      steps.splice(toIndex, 0, moved);
      return { ...current, steps };
    });
  };

  const removeStep = (index: number) => {
    if (draft.steps.length === 1) return;
    setDraft((current) => ({
      ...current,
      steps: current.steps.filter((_, stepIndex) => stepIndex !== index),
    }));
  };

  const handleDragStart = (event: DragEvent<HTMLButtonElement>, index: number) => {
    if (editorBusy) return;
    setDraggedIndex(index);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, index: number) => {
    event.preventDefault();
    if (draggedIndex !== null) reorderStep(draggedIndex, index);
    handleDragEnd();
  };

  const pointerTargetIndex = (clientX: number, clientY: number): number | null => {
    if (typeof document.elementFromPoint !== "function") return null;
    const row = document.elementFromPoint(clientX, clientY)?.closest("[data-agent-step-index]");
    const value = row?.getAttribute("data-agent-step-index");
    if (value === null || value === undefined) return null;
    const index = Number(value);
    return Number.isInteger(index) && index >= 0 && index < draft.steps.length ? index : null;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, index: number) => {
    if (editorBusy || pointerDrag.current || event.pointerType === "mouse") return;
    event.preventDefault();
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    pointerDrag.current = { index, pointerId: event.pointerId };
    setDraggedIndex(index);
    setDragOverIndex(index);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = pointerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const targetIndex = pointerTargetIndex(event.clientX, event.clientY);
    if (targetIndex !== null) setDragOverIndex(targetIndex);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = pointerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const targetIndex = pointerTargetIndex(event.clientX, event.clientY) ?? dragOverIndex;
    if (targetIndex !== null) reorderStep(drag.index, targetIndex);
    if (
      typeof event.currentTarget.hasPointerCapture === "function" &&
      event.currentTarget.hasPointerCapture(event.pointerId) &&
      typeof event.currentTarget.releasePointerCapture === "function"
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointerDrag.current = null;
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = pointerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (
      typeof event.currentTarget.hasPointerCapture === "function" &&
      event.currentTarget.hasPointerCapture(event.pointerId) &&
      typeof event.currentTarget.releasePointerCapture === "function"
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointerDrag.current = null;
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleReorderKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (editorBusy) return;
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      setKeyboardDragIndex((current) => (current === index ? null : index));
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setKeyboardDragIndex(null);
      return;
    }
    if (keyboardDragIndex !== index) return;
    if (event.key === "ArrowUp" && index > 0) {
      event.preventDefault();
      reorderStep(index, index - 1);
      setKeyboardDragIndex(index - 1);
    } else if (event.key === "ArrowDown" && index < draft.steps.length - 1) {
      event.preventDefault();
      reorderStep(index, index + 1);
      setKeyboardDragIndex(index + 1);
    }
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const saved = await rpc.call("saveTemplate", {
        templateId: draft.templateId,
        ...(draft.expectedUpdatedAt === null ? {} : { expectedUpdatedAt: draft.expectedUpdatedAt }),
        name: draft.name,
        description: draft.description,
        defaultMode: draft.defaultMode,
        steps: draft.steps,
      });
      setDraft((current) => ({ ...current, expectedUpdatedAt: saved.updatedAt }));
      onSaved(saved);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
    }
  };

  const deleteTemplate = async () => {
    if (
      !template ||
      draft.expectedUpdatedAt === null ||
      !window.confirm(`Delete Checklist “${template.name}”?`)
    ) return;
    setDeleting(true);
    setError(null);
    try {
      await rpc.call("deleteTemplate", {
        templateId: template.id,
        expectedUpdatedAt: draft.expectedUpdatedAt,
      });
      onDeleted(template.id);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain bg-background p-4 md:p-6"
      data-testid="checklist-editor-scroll"
    >
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <button
          type="button"
          className={quietButtonClass}
          disabled={editorBusy}
          onClick={() => navigate.toPluginPanel("checklists", { subPath: "", replace: true })}
        >
          Back to Checklists
        </button>

        <header>
          <h1 className="text-lg font-semibold text-foreground">
            {draft.templateId ? "Edit Checklist" : "New Checklist"}
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Define the steps the agent must follow and update as it works.
          </p>
        </header>

        {error ? <ErrorNotice message={error} /> : null}

        <form className="space-y-7" onSubmit={(event) => void save(event)}>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_12rem]">
            <label className="text-xs text-muted-foreground">
              Name
              <input
                className={`${fieldClass} mt-1`}
                value={draft.name}
                required
                maxLength={200}
                disabled={editorBusy}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              />
            </label>
            <label className="text-xs text-muted-foreground">
              Default continuation
              <select
                className={`${fieldClass} mt-1 h-9`}
                value={draft.defaultMode}
                disabled={editorBusy}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    defaultMode: event.target.value as ContinuationMode,
                  }))
                }
              >
                {Object.entries(modeLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block text-xs text-muted-foreground">
            Description
            <textarea
              className={`${fieldClass} mt-1 min-h-20 resize-y`}
              value={draft.description}
              maxLength={2_000}
              disabled={editorBusy}
              placeholder="What should the agent accomplish with these steps?"
              onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
            />
          </label>

          <section aria-labelledby="agent-checklist-steps-heading">
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <h2 id="agent-checklist-steps-heading" className="text-sm font-medium text-foreground">
                  Agent steps
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">Drag a row to set its order.</p>
              </div>
              <button
                type="button"
                className={buttonClass}
                disabled={editorBusy}
                onClick={() => setDraft((current) => ({ ...current, steps: [...current.steps, newDraftStep()] }))}
              >
                Add step
              </button>
            </div>

            <div className="space-y-2">
              {draft.steps.map((step, index) => (
                <div
                  key={step.id}
                  data-agent-step-index={index}
                  className={`rounded-md bg-surface-recessed/30 px-3 py-3 transition-colors ${
                    dragOverIndex === index ? "bg-state-hover" : ""
                  }`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragOverIndex(index);
                  }}
                  onDrop={(event) => handleDrop(event, index)}
                >
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      className={`${iconButtonClass} mt-1 cursor-grab touch-none active:cursor-grabbing`}
                      draggable={!editorBusy}
                      disabled={editorBusy}
                      aria-label={`Reorder agent step ${index + 1}`}
                      aria-pressed={keyboardDragIndex === index}
                      title="Drag to reorder. On touch, press and hold, then move the handle. Press Space, then use Arrow Up or Arrow Down."
                      onDragStart={(event) => handleDragStart(event, index)}
                      onDragEnd={handleDragEnd}
                      onKeyDown={(event) => handleReorderKeyDown(event, index)}
                      onPointerDown={(event) => handlePointerDown(event, index)}
                      onPointerMove={handlePointerMove}
                      onPointerUp={handlePointerUp}
                      onPointerCancel={handlePointerCancel}
                    >
                      <span aria-hidden="true" className="text-base leading-none">⠿</span>
                    </button>
                    <span className="mt-2 w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1 space-y-2">
                      <label className="sr-only" htmlFor={`agent-step-title-${step.id}`}>
                        Agent step {index + 1} title
                      </label>
                      <input
                        id={`agent-step-title-${step.id}`}
                        className={fieldClass}
                        value={step.title}
                        required
                        maxLength={500}
                        disabled={editorBusy}
                        placeholder="What should the agent do?"
                        onChange={(event) => updateStep(index, "title", event.target.value)}
                      />
                      <label className="sr-only" htmlFor={`agent-step-description-${step.id}`}>
                        Agent step {index + 1} reminder
                      </label>
                      <textarea
                        id={`agent-step-description-${step.id}`}
                        className={`${fieldClass} min-h-16 resize-y`}
                        value={step.description}
                        maxLength={2_000}
                        disabled={editorBusy}
                        placeholder="Optional reminder for the agent"
                        onChange={(event) => updateStep(index, "description", event.target.value)}
                      />
                    </div>
                    <button
                      type="button"
                      className={`${iconButtonClass} mt-1 text-destructive hover:text-destructive`}
                      disabled={editorBusy || draft.steps.length === 1}
                      aria-label={`Delete agent step ${index + 1}`}
                      title="Delete step"
                      onClick={() => removeStep(index)}
                    >
                      <span aria-hidden="true" className="text-lg leading-none">×</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="submit" className={primaryButtonClass} disabled={editorBusy}>
              {saving ? "Saving…" : "Save Checklist"}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={editorBusy}
              onClick={() => navigate.toPluginPanel("checklists", { subPath: "", replace: true })}
            >
              Cancel
            </button>
            {template ? (
              <button
                type="button"
                className={`${quietButtonClass} ml-auto text-destructive hover:text-destructive`}
                disabled={editorBusy}
                onClick={() => void deleteTemplate()}
              >
                {deleting ? "Deleting…" : "Delete Checklist"}
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </div>
  );
}

function TemplateCollectionRow({
  template,
  disabled,
  onOpen,
  onDelete,
}: {
  template: ChecklistTemplate;
  disabled?: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group flex min-w-0 items-center gap-3 rounded-md px-3 py-3 transition-colors hover:bg-state-hover">
      <button
        type="button"
        className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        disabled={disabled}
        aria-label={`Edit ${template.name}`}
        onClick={onOpen}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{template.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {template.steps.length} {template.steps.length === 1 ? "step" : "steps"}
          </span>
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {modeLabels[template.defaultMode]}
          </span>
        </span>
        {template.description ? (
          <span className="mt-1 block truncate text-xs text-muted-foreground">{template.description}</span>
        ) : null}
      </button>
      <button
        type="button"
        className={`${iconButtonClass} text-destructive hover:text-destructive`}
        disabled={disabled}
        aria-label={`Delete ${template.name}`}
        title="Delete Checklist"
        onClick={onDelete}
      >
        <span aria-hidden="true" className="text-lg leading-none">×</span>
      </button>
    </div>
  );
}

type TemplateRoute =
  | { kind: "list" }
  | { kind: "edit"; templateId: string }
  | { kind: "new" };

function decodeRouteSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseTemplateRoute(subPath: string): TemplateRoute {
  const parts = subPath.split("/").filter(Boolean).map(decodeRouteSegment);
  if (parts[0] !== "template") return { kind: "list" };
  if (parts[1] === "new") return { kind: "new" };
  if (parts[1]) return { kind: "edit", templateId: parts[1] };
  return { kind: "list" };
}

function TemplateLoadFailure({
  message,
  onRetry,
  onBack,
}: {
  message: string;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <div className="min-h-full bg-background p-4 md:p-6">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <ErrorNotice message={message} />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} onClick={onRetry}>
            Retry
          </button>
          <button type="button" className={quietButtonClass} onClick={onBack}>
            Back to Checklists
          </button>
        </div>
      </div>
    </div>
  );
}

function TemplateCatalog({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  const realtimeConnection = useRealtimeConnectionState();
  const [templates, setTemplates] = useState<ChecklistTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const previousConnection = useRef(realtimeConnection);
  const route = parseTemplateRoute(subPath);

  const loadTemplates = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      const result = await rpc.call("listTemplates", null);
      if (generation !== loadGeneration.current) return;
      setTemplates(result.templates);
      setError(null);
      setLoading(false);
    } catch (reason) {
      if (generation === loadGeneration.current) {
        setError(errorText(reason));
        setLoading(false);
      }
    }
  }, [rpc]);

  useEffect(() => {
    setLoading(true);
    void loadTemplates();
  }, [loadTemplates]);

  useRealtime(REALTIME_CHANNEL, (payload) => {
    if (!isRecord(payload) || payload.templateId === undefined) return;
    void loadTemplates();
  });

  useEffect(() => {
    const reconnected =
      previousConnection.current === "reconnecting" && realtimeConnection === "connected";
    previousConnection.current = realtimeConnection;
    if (reconnected) void loadTemplates();
  }, [loadTemplates, realtimeConnection]);

  const saved = (template: ChecklistTemplate) => {
    loadGeneration.current += 1;
    setError(null);
    setLoading(false);
    setTemplates((current) => {
      const withoutSaved = current.filter((item) => item.id !== template.id);
      return [...withoutSaved, template].sort((left, right) => left.name.localeCompare(right.name));
    });
    toast.success("Checklist saved");
    navigate.toPluginPanel("checklists", { subPath: "", replace: true });
  };

  const deleteTemplate = async (template: ChecklistTemplate) => {
    if (!window.confirm(`Delete Checklist “${template.name}”?`)) return;
    setDeletingId(template.id);
    setActionError(null);
    try {
      await rpc.call("deleteTemplate", {
        templateId: template.id,
        expectedUpdatedAt: template.updatedAt,
      });
      loadGeneration.current += 1;
      setTemplates((current) => current.filter((item) => item.id !== template.id));
      if (route.kind === "edit" && route.templateId === template.id) {
        navigate.toPluginPanel("checklists", { subPath: "", replace: true });
      }
    } catch (reason) {
      setActionError(errorText(reason));
    } finally {
      setDeletingId(null);
    }
  };

  const retryTemplates = () => {
    setLoading(true);
    setError(null);
    void loadTemplates();
  };

  const deleted = (templateId: string) => {
    loadGeneration.current += 1;
    setTemplates((current) => current.filter((item) => item.id !== templateId));
    navigate.toPluginPanel("checklists", { subPath: "", replace: true });
  };

  if (route.kind === "new") {
    return <TemplateEditor template={null} onSaved={saved} onDeleted={() => undefined} />;
  }

  if (loading) return <LoadingState />;

  if (error) {
    return (
      <TemplateLoadFailure
        message={error}
        onRetry={retryTemplates}
        onBack={() => navigate.toPluginPanel("checklists", { subPath: "", replace: true })}
      />
    );
  }

  if (route.kind === "edit") {
    const template = templates.find((item) => item.id === route.templateId) ?? null;
    if (!template) {
      return (
        <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain bg-background p-4 md:p-6">
          <div className="mx-auto w-full max-w-3xl space-y-4">
            <ErrorNotice message="Checklist not found." />
            <button
              type="button"
              className={buttonClass}
              onClick={() => navigate.toPluginPanel("checklists", { subPath: "", replace: true })}
            >
              Back to Checklists
            </button>
          </div>
        </div>
      );
    }
    return <TemplateEditor key={template.id} template={template} onSaved={saved} onDeleted={deleted} />;
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain bg-background p-4 md:p-6">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-foreground">Your Checklists</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              Saved instructions the agent can follow and update while it works.
            </p>
          </div>
          <button type="button" className={primaryButtonClass} onClick={() => navigate.toPluginPanel("checklists", { subPath: "template/new" })}>
            New Checklist
          </button>
        </header>

        {actionError ? <ErrorNotice message={actionError} /> : null}

        {templates.length === 0 ? (
          <div className="rounded-md bg-surface-recessed/40 px-4 py-6">
            <p className="text-sm font-medium text-foreground">No Checklists yet</p>
            <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
              Create one to give the agent a durable set of steps for a conversation.
            </p>
          </div>
        ) : (
          <section aria-label="Saved Checklists" className="space-y-1">
            {templates.map((template) => (
              <TemplateCollectionRow
                key={template.id}
                template={template}
                disabled={deletingId !== null}
                onOpen={() => navigate.toPluginPanel("checklists", { subPath: `template/${encodeURIComponent(template.id)}` })}
                onDelete={() => void deleteTemplate(template)}
              />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function ReadOnlyStepRow({ step, isNext }: { step: ChecklistStep; isNext: boolean }) {
  const stateLabel = step.checked ? "Completed" : isNext ? "Next" : "Not started";

  return (
    <li className="relative flex gap-3 py-2.5">
      <span
        role="img"
        aria-label={`${stateLabel}: ${step.title}`}
        className={`relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-background text-xs ${
          step.checked
            ? "bg-success/15 font-semibold text-success"
            : isNext
              ? "border-2 border-primary text-primary"
              : "border border-border text-muted-foreground"
        }`}
      >
        {step.checked ? "✓" : null}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <p className={step.checked ? "text-sm text-muted-foreground line-through" : "text-sm text-foreground"}>
            {step.title}
          </p>
          <span className={`shrink-0 text-xs ${step.checked ? "text-success" : isNext ? "text-primary" : "text-muted-foreground"}`}>
            {stateLabel}
          </span>
        </div>
        {step.description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.description}</p> : null}
        {step.note || step.evidence ? (
          <div className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
            {step.note ? <p><span className="font-medium text-foreground">Note:</span> {step.note}</p> : null}
            {step.evidence ? <p><span className="font-medium text-foreground">Evidence:</span> {step.evidence}</p> : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function ThreadChecklistPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<RpcContract>();
  const realtimeConnection = useRealtimeConnectionState();
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshGeneration = useRef(0);
  const previousConnection = useRef(realtimeConnection);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const result = await rpc.call("getForThread", { threadId });
      if (generation !== refreshGeneration.current) return;
      setChecklist(result.checklist);
      setError(null);
      setLoading(false);
    } catch (reason) {
      if (generation !== refreshGeneration.current) return;
      setChecklist(null);
      setError(errorText(reason));
      setLoading(false);
    }
  }, [rpc, threadId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  useRealtime(REALTIME_CHANNEL, (payload) => {
    if (!isRecord(payload) || payload.threadId !== threadId) return;
    void refresh();
  });

  useEffect(() => {
    const reconnected =
      previousConnection.current === "reconnecting" && realtimeConnection === "connected";
    previousConnection.current = realtimeConnection;
    if (reconnected) void refresh();
  }, [realtimeConnection, refresh]);

  const mutate = async <T,>(action: () => Promise<T>): Promise<T | null> => {
    refreshGeneration.current += 1;
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (reason) {
      setError(errorText(reason));
      return null;
    } finally {
      refreshGeneration.current += 1;
      setBusy(false);
    }
  };

  const updateSettings = async (input: { continuationMode?: ContinuationMode; status?: "active" | "paused" }) => {
    if (!checklist) return;
    const next = await mutate(() => rpc.call("updateSettings", { checklistId: checklist.id, ...input }));
    if (next) setChecklist(next);
  };

  const continueChecklist = async () => {
    if (!checklist) return;
    const result = await mutate(() => rpc.call("continue", { checklistId: checklist.id }));
    if (result?.checklist) setChecklist(result.checklist);
  };

  const resumeAfterLimit = async () => {
    if (!checklist) return;
    const next = await mutate(() => rpc.call("resume", { checklistId: checklist.id }));
    if (next) setChecklist(next);
  };

  const closeLifecycle = async () => {
    if (!checklist || checklist.status === "orphaned" || checklist.status === "closed") return;
    if (
      checklist.status !== "completed" &&
      !window.confirm(
        `Close Checklist “${checklist.name}”? The agent will stop continuing it, but its progress and notes will remain available.`,
      )
    ) {
      return;
    }
    const next = await mutate(() => rpc.call("close", { checklistId: checklist.id }));
    if (next) setChecklist(next);
  };

  const detach = async () => {
    if (!checklist || !window.confirm(`Detach Checklist “${checklist.name}”?`)) return;
    const result = await mutate(() => rpc.call("detach", { checklistId: checklist.id }));
    if (result?.detached) setChecklist(null);
  };

  if (loading) return <LoadingState />;

  if (error && !checklist) {
    return (
      <div className="space-y-4 p-5">
        <ErrorNotice message={`Unable to load the Checklist: ${error}`} />
        <button type="button" className={buttonClass} onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    );
  }

  if (!checklist) {
    return (
      <div className="space-y-3 p-5">
        <h2 className="text-base font-semibold text-foreground">No Checklist attached</h2>
        <p className="text-sm leading-6 text-muted-foreground">
          Use the composer’s <span className="font-medium text-foreground">+</span> menu and choose <span className="font-medium text-foreground">Checklist</span>.
        </p>
      </div>
    );
  }

  const completed = completedCount(checklist);
  const total = checklist.steps.length;
  const progress = total === 0 ? 0 : Math.round((completed / total) * 100);
  const unavailable = checklist.status === "orphaned";
  const nextStepIndex = checklist.steps.findIndex((step) => !step.checked);

  return (
    <div className="p-4">
      <div className="overflow-hidden rounded-md border border-border bg-surface-recessed/10">
        <header className="space-y-3 px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-foreground">{checklist.name}</h2>
              {checklist.description ? <p className="mt-1 text-sm leading-6 text-muted-foreground">{checklist.description}</p> : null}
            </div>
            <span className={`shrink-0 text-xs font-medium ${statusTone(checklist.status)}`}>
              {completed} of {total} complete
            </span>
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-surface-recessed"
            role="progressbar"
            aria-label="Checklist progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
          </div>
          {error ? <ErrorNotice message={error} /> : null}
          {checklist.lastError ? <ErrorNotice message={checklist.lastError} /> : null}
        </header>

        <section
          className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-2.5"
          aria-label="Checklist controls"
          role="toolbar"
        >
          <span className={`shrink-0 text-xs font-medium ${statusTone(checklist.status)}`}>
            {statusLabel(checklist.status)}
          </span>
          {checklist.status === "active" || checklist.status === "awaiting_approval" ? (
            <button
              type="button"
              className={`${quietButtonClass} text-foreground`}
              disabled={busy || unavailable}
              title="Pause agent continuation"
              aria-label="Pause agent continuation"
              onClick={() => void updateSettings({ status: "paused" })}
            >
              Pause
            </button>
          ) : checklist.status === "paused" ? (
            <button
              type="button"
              className={`${quietButtonClass} text-foreground`}
              disabled={busy || unavailable}
              title="Resume agent continuation"
              aria-label="Resume agent continuation"
              onClick={() => void updateSettings({ status: "active" })}
            >
              Resume
            </button>
          ) : null}
          {checklist.status === "awaiting_approval" ? (
            <button type="button" className={primaryButtonClass} disabled={busy || unavailable} onClick={() => void continueChecklist()}>
              Approve continuation
            </button>
          ) : null}
          {checklist.status === "limit_reached" ? (
            <button type="button" className={primaryButtonClass} disabled={busy || unavailable} onClick={() => void resumeAfterLimit()}>
              Resume continuation
            </button>
          ) : null}
          {checklist.status !== "closed" && !unavailable ? (
            <button
              type="button"
              className={`${quietButtonClass} text-destructive hover:text-destructive`}
              disabled={busy}
              title="Close lifecycle"
              aria-label={`Close Checklist lifecycle for ${checklist.name}`}
              onClick={() => void closeLifecycle()}
            >
              Close lifecycle
            </button>
          ) : null}
          <button
            type="button"
            className={`${quietButtonClass} text-destructive hover:text-destructive`}
            disabled={busy}
            onClick={() => void detach()}
          >
            Detach
          </button>
          <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
          <span className="shrink-0 text-xs font-medium text-muted-foreground">Mode</span>
          <div className="flex overflow-hidden rounded-md border border-border" role="group" aria-label="Continuation mode">
            {Object.entries(modeLabels).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={modeButtonClass(checklist.continuationMode === value)}
                aria-pressed={checklist.continuationMode === value}
                disabled={busy || unavailable || checklist.status === "completed" || checklist.status === "closed"}
                onClick={() => void updateSettings({ continuationMode: value as ContinuationMode })}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        <section aria-labelledby="agent-checklist-steps-heading" className="border-t border-border px-4 pb-4 pt-3">
          <h3 id="agent-checklist-steps-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Agent steps</h3>
          <div className="relative mt-2">
            {checklist.steps.length > 1 ? <span className="absolute bottom-4 left-2.5 top-4 w-px bg-border" aria-hidden="true" /> : null}
            <ol className="relative">
              {checklist.steps.map((step, index) => (
                <ReadOnlyStepRow key={step.id} step={step} isNext={index === nextStepIndex} />
              ))}
            </ol>
          </div>
        </section>

        {checklist.notes.length > 0 ? (
          <section aria-labelledby="agent-checklist-notes-heading" className="border-t border-border px-4 py-3">
            <h3 id="agent-checklist-notes-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Agent notes</h3>
            <ul className="mt-2 space-y-2">
              {checklist.notes.map((entry) => (
                <li key={entry.id} className="text-xs leading-5 text-muted-foreground">{entry.content}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function ComposerChecklistBanner() {
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  const realtimeConnection = useRealtimeConnectionState();
  const view = useComposerView();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const refreshGeneration = useRef(0);
  const previousConnection = useRef(realtimeConnection);
  const activeThreadId = useRef(threadId);
  activeThreadId.current = threadId;

  const refresh = useCallback(async () => {
    if (!threadId) return;
    const generation = ++refreshGeneration.current;
    try {
      const result = await rpc.call("getForThread", { threadId });
      if (generation !== refreshGeneration.current) return;
      setChecklist(result.checklist?.status === "closed" ? null : result.checklist);
      setError(null);
      setLoading(false);
    } catch (reason) {
      if (generation !== refreshGeneration.current) return;
      setChecklist(null);
      setError(errorText(reason));
      setLoading(false);
    }
  }, [rpc, threadId]);

  useEffect(() => {
    setLoading(Boolean(threadId));
    setActionBusy(false);
    if (threadId) void refresh();
  }, [refresh, threadId]);

  useRealtime(REALTIME_CHANNEL, (payload) => {
    if (!threadId || !isRecord(payload) || payload.threadId !== threadId) return;
    void refresh();
  });

  useEffect(() => {
    const reconnected =
      previousConnection.current === "reconnecting" && realtimeConnection === "connected";
    previousConnection.current = realtimeConnection;
    if (reconnected) void refresh();
  }, [realtimeConnection, refresh]);

  if (!threadId || loading) return null;

  if (error) {
    return (
      <div className="mx-auto mb-2 flex w-full min-w-0 max-w-3xl flex-wrap items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
        <span className="min-w-0 flex-1 break-words">Checklist unavailable: {error}</span>
        <button type="button" className={`${quietButtonClass} shrink-0`} onClick={() => void refresh()}>Retry</button>
      </div>
    );
  }

  if (!checklist || checklist.status === "closed") return null;

  const completed = completedCount(checklist);
  const total = checklist.steps.length;
  const nextStep = checklist.steps.find((step) => !step.checked) ?? null;
  const openDetails = () => {
    if (!navigate.openThreadPanel({ actionId: "agent-checklist", title: `Checklist · ${checklist.name}` })) {
      toast.info("Open this conversation in the main view to inspect its Checklist.");
    }
  };

  const performAction = async (
    action: () => Promise<Checklist | null>,
    onSuccess?: () => void,
  ) => {
    if (actionBusy) return;
    const actionThreadId = threadId;
    setActionBusy(true);
    setError(null);
    try {
      const next = await action();
      if (actionThreadId === activeThreadId.current) {
        if (next) setChecklist(next);
        onSuccess?.();
      }
    } catch (reason) {
      if (actionThreadId === activeThreadId.current) setError(errorText(reason));
    } finally {
      if (actionThreadId === activeThreadId.current) setActionBusy(false);
    }
  };

  const closeLifecycle = () => {
    if (
      checklist.status !== "completed" &&
      !window.confirm(
        `Close Checklist “${checklist.name}”? The agent will stop continuing it, but its progress and notes will remain available.`,
      )
    ) {
      return;
    }
    void performAction(
      async () => {
        await rpc.call("close", { checklistId: checklist.id });
        return null;
      },
      () => setChecklist(null),
    );
  };

  return (
    <div
      className="mx-auto mb-2 w-full min-w-0 max-w-3xl overflow-hidden rounded-md border border-border bg-surface-recessed/10 px-3 py-2.5"
      role="region"
      aria-label="Checklist status"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="min-w-0 basis-full truncate text-sm font-medium text-foreground sm:flex-1 sm:basis-auto">{checklist.name}</span>
        {checklist.status !== "active" ? (
          <span className={`min-w-0 max-w-full break-words text-xs font-medium ${statusTone(checklist.status)}`}>
            {statusLabel(checklist.status)}
          </span>
        ) : null}
        <span
          className={`shrink-0 text-xs ${statusTone(checklist.status)}`}
          aria-label={`${completed} of ${total} Checklist steps complete`}
        >
          {completed} of {total}
        </span>
        <button
          type="button"
          className={`${quietButtonClass} shrink-0`}
          aria-label={`Open Checklist details for ${checklist.name}`}
          onClick={openDetails}
        >
          Open
        </button>
        {checklist.status !== "orphaned" ? (
          <button
            type="button"
            className={iconButtonClass}
            aria-label={`Close Checklist lifecycle for ${checklist.name}`}
            title="Close lifecycle"
            disabled={actionBusy}
            onClick={closeLifecycle}
          >
            <span aria-hidden="true" className="text-base leading-none">×</span>
          </button>
        ) : null}
      </div>
      <div
        className="mt-2 h-1 overflow-hidden rounded-full bg-surface-recessed"
        role="progressbar"
        aria-label="Checklist progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={total === 0 ? 0 : Math.round((completed / total) * 100)}
      >
        <div
          className="h-full bg-primary transition-[width]"
          style={{ width: `${total === 0 ? 0 : Math.round((completed / total) * 100)}%` }}
        />
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
        <div className="flex min-w-0 flex-1 basis-full items-center gap-2 sm:basis-auto">
          {nextStep ? (
            <>
              <span className="shrink-0 font-medium text-primary">Up next:</span>
              <span className="min-w-0 truncate text-muted-foreground">{nextStep.title}</span>
            </>
          ) : (
            <span className="min-w-0 text-success">All agent steps complete</span>
          )}
        </div>
        {checklist.status === "awaiting_approval" ? (
          <button
            type="button"
            className={`${quietButtonClass} shrink-0 text-foreground sm:ml-auto`}
            disabled={actionBusy}
            onClick={() =>
              void performAction(async () =>
                (await rpc.call("continue", { checklistId: checklist.id })).checklist,
              )
            }
          >
            Approve
          </button>
        ) : checklist.status === "paused" ? (
          <button
            type="button"
            className={`${quietButtonClass} shrink-0 text-foreground sm:ml-auto`}
            disabled={actionBusy}
            onClick={() =>
              void performAction(() =>
                rpc.call("updateSettings", { checklistId: checklist.id, status: "active" }),
              )
            }
          >
            Resume
          </button>
        ) : checklist.status === "limit_reached" ? (
          <button
            type="button"
            className={`${quietButtonClass} shrink-0 text-foreground sm:ml-auto`}
            disabled={actionBusy}
            onClick={() =>
              void performAction(() => rpc.call("resume", { checklistId: checklist.id }))
            }
          >
            Resume continuation
          </button>
        ) : null}
        {checklist.status === "awaiting_approval" ? (
          <button
            type="button"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            disabled={actionBusy}
            onClick={() =>
              void performAction(() =>
                rpc.call("updateSettings", { checklistId: checklist.id, status: "paused" }),
              )
            }
          >
            Pause
          </button>
        ) : null}
      </div>
    </div>
  );
}

async function attachFromComposer(scope: PluginComposerScope) {
  if (scope.kind !== "thread") return;
  try {
    const current = await callRpc("getForThread", { threadId: scope.threadId });
    if (current.checklist) {
      toast.info("Detach the current Checklist before attaching another.");
      return;
    }
    const picked = await callRpc("pickTemplate", { threadId: scope.threadId });
    if (!picked.templateId) return;
    await callRpc("attach", { threadId: scope.threadId, templateId: picked.templateId });
    toast.success("Checklist attached");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Unable to attach Checklist");
  }
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "templates",
    title: "Checklists",
    icon: "ListTodo",
    path: "checklists",
    component: TemplateCatalog,
  });

  app.slots.threadPanelAction({
    id: "agent-checklist",
    title: "Checklist",
    icon: "ListTodo",
    component: ThreadChecklistPanel,
  });

  app.slots.pendingInteraction({
    id: "agent-checklist-picker",
    component: AgentChecklistPicker,
  });

  app.composer.customize({
    id: "agent-checklist-composer",
    scopes: ["thread", "new-thread"],
    plusMenu: [
      {
        id: "agent-checklist",
        label: "Checklist",
        icon: "ListTodo",
        description: "Attach a checklist to this conversation",
        disabled: (view) => view.scope.kind !== "thread",
        run: ({ view }) => {
          void attachFromComposer(view.scope);
        },
      },
    ],
    banners: [
      { id: "agent-checklist-summary", chrome: "bare", component: ComposerChecklistBanner },
    ],
  });
});
