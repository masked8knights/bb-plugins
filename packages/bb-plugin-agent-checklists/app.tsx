import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
  type PluginThreadPanelProps,
} from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
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
const fieldClass =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring";

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
    default:
      return "text-primary";
  }
}

function ChecklistStepRow({
  step,
  disabled,
  onUpdate,
}: {
  step: ChecklistStep;
  disabled: boolean;
  onUpdate(input: {
    checked?: boolean;
    note?: string | null;
    evidence?: string | null;
  }): Promise<void>;
}) {
  const [note, setNote] = useState(step.note ?? "");
  const [evidence, setEvidence] = useState(step.evidence ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => setNote(step.note ?? ""), [step.note]);
  useEffect(() => setEvidence(step.evidence ?? ""), [step.evidence]);

  const save = async (input: { checked?: boolean; note?: string | null; evidence?: string | null }) => {
    setSaving(true);
    try {
      await onUpdate(input);
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="border-b border-border py-4 last:border-b-0">
      <div className="flex items-start gap-3">
        <input
          className="mt-1 size-4 accent-primary"
          type="checkbox"
          checked={step.checked}
          disabled={disabled || saving}
          aria-label={`Mark ${step.title} complete`}
          onChange={(event) => void save({ checked: event.target.checked })}
        />
        <div className="min-w-0 flex-1">
          <p className={step.checked ? "text-sm text-muted-foreground line-through" : "text-sm text-foreground"}>
            {step.title}
          </p>
          {step.description ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.description}</p>
          ) : null}
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <label className="text-xs text-muted-foreground">
              Note
              <textarea
                className={`${fieldClass} mt-1 min-h-16 resize-y`}
                value={note}
                disabled={disabled || saving}
                placeholder="Optional context for this step"
                aria-label={`${step.title} note`}
                onChange={(event) => setNote(event.target.value)}
                onBlur={() => {
                  if (note !== (step.note ?? "")) void save({ note: note || null });
                }}
              />
            </label>
            <label className="text-xs text-muted-foreground">
              Evidence
              <textarea
                className={`${fieldClass} mt-1 min-h-16 resize-y`}
                value={evidence}
                disabled={disabled || saving}
                placeholder="Optional file, test, or source reference"
                aria-label={`${step.title} evidence`}
                onChange={(event) => setEvidence(event.target.value)}
                onBlur={() => {
                  if (evidence !== (step.evidence ?? "")) {
                    void save({ evidence: evidence || null });
                  }
                }}
              />
            </label>
          </div>
        </div>
      </div>
    </li>
  );
}

function TemplateCard({
  template,
  onAttach,
  disabled,
}: {
  template: ChecklistTemplate;
  onAttach?: () => void;
  disabled?: boolean;
}) {
  return (
    <article className="border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-foreground">{template.name}</h3>
            <span className="text-[11px] text-muted-foreground">
              {template.isBuiltIn ? "Built-in" : "Custom"}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{template.description}</p>
        </div>
        {onAttach ? (
          <button
            type="button"
            className={primaryButtonClass}
            disabled={disabled}
            aria-label={`Attach ${template.name}`}
            onClick={onAttach}
          >
            Attach
          </button>
        ) : null}
      </div>
      <ol className="mt-4 space-y-2 border-t border-border pt-3">
        {template.steps.map((step) => (
          <li key={step.id} className="flex gap-2 text-xs leading-5 text-muted-foreground">
            <span className="w-5 shrink-0 text-right tabular-nums">{step.position + 1}.</span>
            <span>{step.title}</span>
          </li>
        ))}
      </ol>
    </article>
  );
}

function TemplateCollectionRow({
  template,
  onOpen,
}: {
  template: ChecklistTemplate;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-4 px-3 py-3 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={onOpen}
      aria-label={`Open ${template.name}`}
    >
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{template.name}</span>
          {template.isBuiltIn ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">Built-in</span>
          ) : (
            <span className="shrink-0 text-[11px] text-primary">Custom</span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {template.description || "No description"}
        </span>
      </span>
      <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
        {template.steps.length} {template.steps.length === 1 ? "step" : "steps"}
      </span>
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        {modeLabels[template.defaultMode]}
      </span>
      <span className="text-muted-foreground" aria-hidden="true">›</span>
    </button>
  );
}

type TemplateDraftStep = {
  id: string;
  title: string;
  description: string;
};

type TemplateDraft = {
  templateId: string | null;
  name: string;
  description: string;
  defaultMode: ContinuationMode;
  steps: TemplateDraftStep[];
};

let draftStepCounter = 0;

function newDraftStep(): TemplateDraftStep {
  draftStepCounter += 1;
  return {
    id: `draft-step-${draftStepCounter}`,
    title: "",
    description: "",
  };
}

function draftFromTemplate(template: ChecklistTemplate, copy: boolean): TemplateDraft {
  return {
    templateId: copy ? null : template.id,
    name: copy ? `${template.name} copy` : template.name,
    description: template.description,
    defaultMode: template.defaultMode,
    steps: template.steps.map((step) => ({
      id: step.id,
      title: step.title,
      description: step.description,
    })),
  };
}

function blankTemplateDraft(name: string): TemplateDraft {
  return {
    templateId: null,
    name,
    description: "",
    defaultMode: "automatic",
    steps: [newDraftStep()],
  };
}

function TemplateEditor({
  template,
  copyFrom,
  initialName,
  onSaved,
  onDeleted,
}: {
  template: ChecklistTemplate | null;
  copyFrom: ChecklistTemplate | null;
  initialName?: string;
  onSaved: (template: ChecklistTemplate) => void;
  onDeleted: (templateId: string) => void;
}) {
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  const protectedTemplate = Boolean(template?.isBuiltIn);
  const [draft, setDraft] = useState<TemplateDraft>(() => {
    if (template) return draftFromTemplate(template, false);
    if (copyFrom) return draftFromTemplate(copyFrom, true);
    return blankTemplateDraft(initialName ?? "New checklist");
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorBusy = saving || deleting;

  const updateStep = (index: number, field: "title" | "description", value: string) => {
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step, stepIndex) =>
        stepIndex === index ? { ...step, [field]: value } : step,
      ),
    }));
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= draft.steps.length) return;
    setDraft((current) => {
      const steps = [...current.steps];
      [steps[index], steps[nextIndex]] = [steps[nextIndex]!, steps[index]!];
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

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const saved = await rpc.call("saveTemplate", {
        templateId: draft.templateId,
        name: draft.name,
        description: draft.description,
        defaultMode: draft.defaultMode,
        steps: draft.steps,
      });
      onSaved(saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const deleteTemplate = async () => {
    if (!template || template.isBuiltIn || !window.confirm(`Delete “${template.name}”?`)) return;
    setDeleting(true);
    setError(null);
    try {
      await rpc.call("deleteTemplate", { templateId: template.id });
      onDeleted(template.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDeleting(false);
    }
  };

  if (protectedTemplate && template) {
    return (
      <div className="min-h-full bg-background p-4 md:p-5">
        <div className="mx-auto w-full max-w-3xl space-y-5">
          <button
            type="button"
            className={quietButtonClass}
            onClick={() => navigate.toPluginPanel("checklists", { subPath: "", replace: true })}
          >
            ← Back to checklists
          </button>
          <header className="space-y-2">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-foreground">{template.name}</h1>
              <span className="text-xs text-muted-foreground">Built-in example</span>
            </div>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              {template.description}
            </p>
          </header>
          <TemplateCard template={template} />
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() =>
                navigate.toPluginPanel("checklists", {
                  subPath: `template/new/copy/${encodeURIComponent(template.id)}`,
                })
              }
            >
              Copy to my checklists
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-background p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-5">
        <button
          type="button"
          className={quietButtonClass}
          disabled={editorBusy}
          onClick={() => navigate.toPluginPanel("checklists", { subPath: "", replace: true })}
        >
          ← Back to checklists
        </button>
        <header>
          <h1 className="text-lg font-semibold text-foreground">
            {draft.templateId ? "Edit checklist" : "Create checklist"}
          </h1>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Use a checklist for a short todo list or a repeatable set of agent steps.
          </p>
        </header>
        {error ? <ErrorNotice message={error} /> : null}
        <form className="space-y-5" onSubmit={(event) => void save(event)}>
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
                  <option key={value} value={value}>{label}</option>
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
              placeholder="What is this checklist for?"
              onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
            />
          </label>

          <section aria-labelledby="template-steps-heading">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h2 id="template-steps-heading" className="text-sm font-medium text-foreground">Steps</h2>
                <p className="mt-1 text-xs text-muted-foreground">Keep each row to one clear action.</p>
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
            <div className="divide-y divide-border border-y border-border">
              {draft.steps.map((step, index) => (
                <div key={step.id} className="grid gap-3 px-3 py-3 md:grid-cols-[2rem_minmax(0,1fr)_auto]">
                  <span className="pt-2 text-right text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                  <div className="space-y-2">
                    <label className="sr-only" htmlFor={`template-step-title-${step.id}`}>Step {index + 1} title</label>
                    <input
                      id={`template-step-title-${step.id}`}
                      className={fieldClass}
                      value={step.title}
                      required
                      maxLength={500}
                      disabled={editorBusy}
                      placeholder="Step title"
                      onChange={(event) => updateStep(index, "title", event.target.value)}
                    />
                    <label className="sr-only" htmlFor={`template-step-description-${step.id}`}>Step {index + 1} description</label>
                    <textarea
                      id={`template-step-description-${step.id}`}
                      className={`${fieldClass} min-h-16 resize-y`}
                      value={step.description}
                      maxLength={2_000}
                      disabled={editorBusy}
                      placeholder="Optional instruction or reminder"
                      onChange={(event) => updateStep(index, "description", event.target.value)}
                    />
                  </div>
                  <div className="flex items-start gap-1 md:flex-col">
                    <button
                      type="button"
                      className={quietButtonClass}
                      aria-label={`Move step ${index + 1} up`}
                      disabled={editorBusy || index === 0}
                      onClick={() => moveStep(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className={quietButtonClass}
                      aria-label={`Move step ${index + 1} down`}
                      disabled={editorBusy || index === draft.steps.length - 1}
                      onClick={() => moveStep(index, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className={quietButtonClass}
                      aria-label={`Remove step ${index + 1}`}
                      disabled={editorBusy || draft.steps.length === 1}
                      onClick={() => removeStep(index)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <button type="submit" className={primaryButtonClass} disabled={saving || deleting}>
              {saving ? "Saving…" : "Save checklist"}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={saving || deleting}
              onClick={() => navigate.toPluginPanel("checklists", { subPath: "", replace: true })}
            >
              Cancel
            </button>
            {template ? (
              <button
                type="button"
                className={`${quietButtonClass} ml-auto text-destructive hover:text-destructive`}
                disabled={saving || deleting}
                onClick={() => void deleteTemplate()}
              >
                {deleting ? "Deleting…" : "Delete checklist"}
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </div>
  );
}

function LoadingState() {
  return <div className="p-4 text-sm text-muted-foreground">Loading checklist…</div>;
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
      {message}
    </div>
  );
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
    <div className="min-h-full bg-background p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <ErrorNotice message={message} />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} onClick={onRetry}>
            Retry
          </button>
          <button type="button" className={quietButtonClass} onClick={onBack}>
            Back to checklists
          </button>
        </div>
      </div>
    </div>
  );
}

function ThreadChecklistPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [templates, setTemplates] = useState<ChecklistTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachmentLoadError, setAttachmentLoadError] = useState<string | null>(null);
  const [templateLoadError, setTemplateLoadError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const [attached, available] = await Promise.allSettled([
      rpc.call("getForThread", { threadId }),
      rpc.call("listTemplates", null),
    ]);
    if (generation !== refreshGeneration.current) return;

    const errors: string[] = [];
    if (attached.status === "fulfilled") {
      setChecklist(attached.value.checklist);
      setAttachmentLoadError(null);
    } else {
      const message = errorText(attached.reason);
      setChecklist(null);
      setNote("");
      setAttachmentLoadError(message);
      errors.push(`Unable to load the attached checklist: ${message}`);
    }
    if (available.status === "fulfilled") {
      setTemplates(available.value.templates);
      setTemplateLoadError(null);
    } else {
      const message = errorText(available.reason);
      setTemplates([]);
      setTemplateLoadError(message);
      errors.push(`Unable to load saved checklists: ${message}`);
    }
    setError(errors.length > 0 ? errors.join(" ") : null);
    setLoading(false);
  }, [rpc, threadId]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    void refresh();
  }, [refresh]);

  useRealtime(REALTIME_CHANNEL, (payload) => {
    if (!isRecord(payload) || (payload.threadId !== threadId && payload.templateId === undefined)) return;
    void refresh();
  });

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

  const attach = async (templateId: string) => {
    const next = await mutate(() => rpc.call("attach", { threadId, templateId }));
    if (next) setChecklist(next);
  };

  const updateSettings = async (input: {
    continuationMode?: ContinuationMode;
    status?: "active" | "paused";
  }) => {
    if (!checklist) return;
    const next = await mutate(() => rpc.call("updateSettings", { checklistId: checklist.id, ...input }));
    if (next) setChecklist(next);
  };

  const updateStep = async (
    stepId: string,
    input: { checked?: boolean; note?: string | null; evidence?: string | null },
  ) => {
    if (!checklist) return;
    const next = await mutate(() => rpc.call("updateStep", { checklistId: checklist.id, stepId, ...input }));
    if (next) setChecklist(next);
  };

  const addNote = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!checklist || !note.trim()) return;
    const next = await mutate(() =>
      rpc.call("addNote", { checklistId: checklist.id, content: note.trim() }),
    );
    if (next) {
      setChecklist(next);
      setNote("");
    }
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

  if (loading) return <LoadingState />;

  if (attachmentLoadError) {
    return (
      <div className="space-y-4 p-4">
        <ErrorNotice message={`Unable to load the attached checklist: ${attachmentLoadError}`} />
        <p className="text-xs leading-5 text-muted-foreground">
          BB could not confirm the current checklist state. Retry before changing or attaching anything.
        </p>
        <button type="button" className={buttonClass} onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    );
  }

  if (!checklist) {
    return (
      <div className="space-y-4 p-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">Attach an Agent Checklist</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Choose a structured set of steps for this thread. The agent can update it through tools, and BB can continue incomplete work automatically.
          </p>
        </div>
        {error ? <ErrorNotice message={error} /> : null}
        {templateLoadError ? (
          <div className="space-y-3 border border-dashed border-border bg-surface-recessed/30 px-4 py-5">
            <p className="text-xs leading-5 text-muted-foreground">
              BB could not confirm the saved checklist list. Retry before attaching a checklist.
            </p>
            <button type="button" className={buttonClass} onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        ) : templates.length > 0 ? (
          <div className="space-y-3">
            {templates.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                disabled={busy}
                onAttach={() => void attach(template.id)}
              />
            ))}
          </div>
        ) : error ? null : (
          <div className="space-y-3 border border-dashed border-border bg-surface-recessed/30 px-4 py-5">
            <div>
              <p className="text-sm font-medium text-foreground">No saved checklists yet</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Create a todo list or workflow before attaching one to this thread.
              </p>
            </div>
            <button
              type="button"
              className={buttonClass}
              onClick={() => navigate.toPluginPanel("checklists", { subPath: "template/new/todo" })}
            >
              Create a checklist
            </button>
          </div>
        )}
      </div>
    );
  }

  const completed = checklist.steps.filter((step) => step.checked).length;
  const total = checklist.steps.length;
  const progress = total === 0 ? 0 : Math.round((completed / total) * 100);
  const disabled = busy || checklist.status === "orphaned";

  return (
    <div className="space-y-5 p-4">
      <header className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground">{checklist.name}</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{checklist.description}</p>
          </div>
          <span className={`shrink-0 text-xs font-medium ${statusTone(checklist.status)}`}>
            {statusLabel(checklist.status)}
          </span>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{completed} of {total} steps</span>
            <span>{progress}%</span>
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
        </div>
        {error ? <ErrorNotice message={error} /> : null}
        {checklist.lastError ? <ErrorNotice message={checklist.lastError} /> : null}
      </header>

      <section className="space-y-3 border-y border-border py-4" aria-label="Continuation settings">
        <div className="flex items-center justify-between gap-3">
          <label className="text-sm text-foreground" htmlFor="continuation-mode">
            Continuation mode
          </label>
          <select
            id="continuation-mode"
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
            value={checklist.continuationMode}
            disabled={busy || checklist.status === "orphaned"}
            onChange={(event) =>
              void updateSettings({ continuationMode: event.target.value as ContinuationMode })
            }
          >
            {Object.entries(modeLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          {checklist.continuationMode === "automatic"
            ? "BB resumes the agent when its turn ends with unchecked steps."
            : checklist.continuationMode === "approval"
              ? "BB waits for your approval before each continuation."
              : "BB tracks the steps without waking the agent."}
        </p>
        <div className="flex flex-wrap gap-2">
          {checklist.status === "active" ? (
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void updateSettings({ status: "paused" })}>
              Pause
            </button>
          ) : checklist.status === "paused" ? (
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void updateSettings({ status: "active" })}>
              Resume
            </button>
          ) : null}
          {checklist.status === "awaiting_approval" ? (
            <button type="button" className={primaryButtonClass} disabled={busy} onClick={() => void continueChecklist()}>
              Continue agent
            </button>
          ) : null}
          {checklist.status === "limit_reached" ? (
            <button type="button" className={primaryButtonClass} disabled={busy} onClick={() => void resumeAfterLimit()}>
              Resume continuation
            </button>
          ) : null}
        </div>
        {checklist.status === "limit_reached" ? (
          <p className="text-xs leading-5 text-muted-foreground">
            The reminder count is at its limit. Resume to reset the count and allow automatic continuation again.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="checklist-steps-heading">
        <h3 id="checklist-steps-heading" className="text-sm font-medium text-foreground">Steps</h3>
        <ol className="mt-1">
          {checklist.steps.map((step) => (
            <ChecklistStepRow
              key={step.id}
              step={step}
              disabled={disabled}
              onUpdate={(input) => updateStep(step.id, input)}
            />
          ))}
        </ol>
      </section>

      <section className="space-y-3 border-t border-border pt-4" aria-labelledby="checklist-notes-heading">
        <h3 id="checklist-notes-heading" className="text-sm font-medium text-foreground">Checklist notes</h3>
        <form className="space-y-2" onSubmit={(event) => void addNote(event)}>
          <label className="sr-only" htmlFor="checklist-note">Add a checklist note</label>
          <textarea
            id="checklist-note"
            className={`${fieldClass} min-h-20 resize-y`}
            value={note}
            disabled={disabled || busy}
            placeholder="Add context that should persist with this checklist"
            onChange={(event) => setNote(event.target.value)}
          />
          <button type="submit" className={buttonClass} disabled={disabled || busy || !note.trim()}>
            Add note
          </button>
        </form>
        {checklist.notes.length > 0 ? (
          <ul className="space-y-2">
            {checklist.notes.map((entry) => (
              <li key={entry.id} className="border border-border bg-surface-recessed px-3 py-2 text-xs leading-5 text-muted-foreground">
                {entry.content}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

type TemplateRoute =
  | { kind: "list" }
  | { kind: "edit"; templateId: string }
  | { kind: "new"; preset: "todo" | "workflow" | "blank"; copyFromId?: string };

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
  if (parts[1] === "new") {
    if (parts[2] === "copy" && parts[3]) {
      return { kind: "new", preset: "blank", copyFromId: parts[3] };
    }
    if (parts[2] === "todo" || parts[2] === "workflow") {
      return { kind: "new", preset: parts[2] };
    }
    return { kind: "new", preset: "blank" };
  }
  if (parts[1]) return { kind: "edit", templateId: parts[1] };
  return { kind: "list" };
}

function TemplateCatalog({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  const [templates, setTemplates] = useState<ChecklistTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadGeneration = useRef(0);
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

  const openNew = (preset: "todo" | "workflow") => {
    navigate.toPluginPanel("checklists", { subPath: `template/new/${preset}` });
  };

  const saved = (template: ChecklistTemplate) => {
    loadGeneration.current += 1;
    setError(null);
    setLoading(false);
    setTemplates((current) => {
      const withoutSaved = current.filter((item) => item.id !== template.id);
      return [...withoutSaved, template].sort((left, right) => left.name.localeCompare(right.name));
    });
    navigate.toPluginPanel("checklists", {
      subPath: `template/${encodeURIComponent(template.id)}`,
      replace: true,
    });
  };

  const deleted = (templateId: string) => {
    setTemplates((current) => current.filter((template) => template.id !== templateId));
    void loadTemplates();
    navigate.toPluginPanel("checklists", { subPath: "", replace: true });
  };

  const retryTemplates = () => {
    setLoading(true);
    setError(null);
    void loadTemplates();
  };

  if (route.kind === "edit") {
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
    const template = templates.find((item) => item.id === route.templateId) ?? null;
    if (!template) {
      return (
        <div className="min-h-full bg-background p-4 md:p-5">
          <div className="mx-auto w-full max-w-3xl space-y-4">
            <ErrorNotice message="Checklist template not found." />
            <button
              type="button"
              className={buttonClass}
              onClick={() => navigate.toPluginPanel("checklists", { subPath: "", replace: true })}
            >
              Back to checklists
            </button>
          </div>
        </div>
      );
    }
    return (
      <TemplateEditor
        key={`edit-${template.id}`}
        template={template}
        copyFrom={null}
        initialName={undefined}
        onSaved={saved}
        onDeleted={deleted}
      />
    );
  }

  if (route.kind === "new") {
    if (route.copyFromId && loading) return <LoadingState />;
    if (route.copyFromId && error) {
      return (
        <TemplateLoadFailure
          message={error}
          onRetry={retryTemplates}
          onBack={() => navigate.toPluginPanel("checklists", { subPath: "", replace: true })}
        />
      );
    }
    const copyFrom = route.copyFromId
      ? templates.find((item) => item.id === route.copyFromId) ?? null
      : null;
    if (route.copyFromId && !copyFrom) {
      return (
        <div className="min-h-full bg-background p-4 md:p-5">
          <div className="mx-auto w-full max-w-3xl space-y-4">
            <ErrorNotice message="The checklist to copy was not found." />
            <button
              type="button"
              className={buttonClass}
              onClick={() => navigate.toPluginPanel("checklists", { subPath: "", replace: true })}
            >
              Back to checklists
            </button>
          </div>
        </div>
      );
    }
    return (
      <TemplateEditor
        key={`new-${route.preset}-${route.copyFromId ?? "blank"}`}
        template={null}
        copyFrom={copyFrom}
        initialName={route.preset === "todo" ? "Todo list" : "New workflow"}
        onSaved={saved}
        onDeleted={deleted}
      />
    );
  }

  if (loading) return <LoadingState />;

  return (
    <div className="min-h-full bg-background p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-foreground">Agent Checklists</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              Create a short todo list or a repeatable set of steps for an agent.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} onClick={() => openNew("todo")}>
              New todo list
            </button>
            <button type="button" className={primaryButtonClass} onClick={() => openNew("workflow")}>
              New workflow
            </button>
          </div>
        </header>
        {error ? <ErrorNotice message={error} /> : null}
        <section aria-labelledby="checklist-collection-heading">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 id="checklist-collection-heading" className="text-sm font-medium text-foreground">
              Your checklists
            </h2>
            <span className="text-xs text-muted-foreground">
              {templates.length} {templates.length === 1 ? "item" : "items"}
            </span>
          </div>
          <div className="hidden grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-4 border-y border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:grid">
            <span>Checklist</span>
            <span>Steps</span>
            <span>Default</span>
            <span aria-hidden="true" />
          </div>
          <div className="divide-y divide-border border-b border-border">
            {templates.map((template) => (
              <TemplateCollectionRow
                key={template.id}
                template={template}
                onOpen={() =>
                  navigate.toPluginPanel("checklists", {
                    subPath: `template/${encodeURIComponent(template.id)}`,
                  })
                }
              />
            ))}
          </div>
          {templates.length === 0 && !error ? (
            <div className="border border-dashed border-border bg-surface-recessed/30 px-4 py-6">
              <p className="text-sm font-medium text-foreground">No checklists yet</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Create a todo list or workflow above. It will be available in every thread’s checklist panel.
              </p>
            </div>
          ) : null}
        </section>
        <div className="border-t border-border pt-4 text-xs leading-5 text-muted-foreground">
          Click a row to edit its steps. Built-in examples are protected; copy one to make it your own.
        </div>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "templates",
    title: "Agent Checklists",
    icon: "ClipboardCheck",
    path: "checklists",
    component: TemplateCatalog,
  });

  app.slots.threadPanelAction({
    id: "agent-checklist",
    title: "Agent Checklist",
    icon: "ClipboardCheck",
    component: ThreadChecklistPanel,
  });
});
