import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginFileOpenerProps,
  type PluginNavPanelProps,
  type PluginThreadPanelProps,
} from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type {
  BindingRecord,
  BindingStatus,
  DocumentSource,
} from "./src/types";

type EditorTarget =
  | { kind: "source"; path: string; source: DocumentSource }
  | { kind: "binding"; bindingId: string };

type RecorderState = "idle" | "recording" | "transcribing" | "error";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventBindingId(value: unknown): string | null {
  if (!isRecord(value) || typeof value.bindingId !== "string") return null;
  return value.bindingId;
}

function sourceFromFile(
  source: PluginFileOpenerProps["source"],
): DocumentSource {
  return {
    kind: source.kind,
    threadId: source.threadId,
    environmentId: source.environmentId,
    projectId: source.projectId,
    hostId: null,
  };
}

function titleFromPath(filePath: string): string {
  const name = filePath.split(/[\\/]/u).at(-1) ?? "Untitled";
  return name.replace(/\.(?:md|mdx|markdown)$/iu, "") || "Untitled";
}

function statusLabel(status: BindingStatus): string {
  switch (status) {
    case "working":
      return "Agent working";
    case "error":
      return "Needs attention";
    case "orphaned":
      return "Agent unavailable";
    default:
      return "Agent ready";
  }
}

function statusClass(status: BindingStatus): string {
  switch (status) {
    case "working":
      return "bg-primary";
    case "error":
    case "orphaned":
      return "bg-destructive";
    default:
      return "bg-success";
  }
}

const buttonBaseClass =
  "inline-flex min-h-8 items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const primaryButtonClass = `${buttonBaseClass} bg-primary text-primary-foreground hover:opacity-90`;
const secondaryButtonClass = `${buttonBaseClass} border border-border bg-transparent text-foreground hover:bg-state-hover`;
const quietButtonClass = `${buttonBaseClass} px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground`;
const fieldClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

function BindingStatusView({
  status,
  withLabel = true,
}: {
  status: BindingStatus;
  withLabel?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span
        aria-hidden="true"
        className={`size-2 shrink-0 rounded-full ${statusClass(status)}`}
      />
      {withLabel ? statusLabel(status) : null}
    </span>
  );
}

function InlineNotice({
  tone,
  children,
  action,
}: {
  tone: "error" | "info" | "success";
  children: ReactNode;
  action?: ReactNode;
}) {
  const toneClass =
    tone === "error"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : tone === "success"
        ? "border-success/30 bg-success/10 text-success"
        : "border-border bg-surface-recessed text-muted-foreground";
  return (
    <div
      className={`flex items-start justify-between gap-3 border px-4 py-2.5 text-xs ${toneClass}`}
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? undefined : "polite"}
    >
      <span className="min-w-0">{children}</span>
      {action}
    </div>
  );
}

function bindingCanAcceptDictation(
  binding: BindingRecord | null,
): binding is BindingRecord {
  return binding?.status === "ready" || binding?.status === "working";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function transcribeBlob(blob: Blob): Promise<string> {
  const form = new FormData();
  const extension = blob.type.includes("ogg")
    ? "ogg"
    : blob.type.includes("mp4")
      ? "mp4"
      : "webm";
  form.set("file", blob, `grove-dictation.${extension}`);
  const response = await fetch("/api/v1/system/voice-transcription", {
    method: "POST",
    body: form,
    credentials: "same-origin",
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (isRecord(body) && typeof body.message === "string") {
      throw new Error(body.message);
    }
    throw new Error(`Voice transcription failed (${response.status})`);
  }
  if (!isRecord(body) || typeof body.text !== "string") {
    throw new Error("Voice transcription returned an invalid response");
  }
  const text = body.text.trim();
  if (!text) throw new Error("No words were detected");
  return text;
}

function useDictationRecorder(
  onTranscript: (text: string) => Promise<void>,
): {
  state: RecorderState;
  error: string | null;
  supported: boolean;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  clearError: () => void;
} {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cancelledRef = useRef(false);
  const [state, setState] = useState<RecorderState>("idle");
  const [error, setError] = useState<string | null>(null);
  const supported =
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined";

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const finish = useCallback(
    async (recorder: MediaRecorder) => {
      const blob = new Blob(chunksRef.current, {
        type: recorder.mimeType || "audio/webm",
      });
      chunksRef.current = [];
      releaseStream();
      if (cancelledRef.current) {
        cancelledRef.current = false;
        setState("idle");
        return;
      }
      if (blob.size === 0) {
        setError("The recording was empty");
        setState("error");
        return;
      }
      setState("transcribing");
      try {
        await onTranscript(await transcribeBlob(blob));
        setError(null);
        setState("idle");
      } catch (reason) {
        setError(formatError(reason));
        setState("error");
      }
    },
    [onTranscript, releaseStream],
  );

  const start = useCallback(async () => {
    if (!supported || state === "recording" || state === "transcribing") return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      cancelledRef.current = false;
      const mimeType = ["audio/webm", "audio/mp4", "audio/ogg"].find(
        (candidate) => MediaRecorder.isTypeSupported(candidate),
      );
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        recorderRef.current = null;
        void finish(recorder);
      });
      recorder.start();
      setState("recording");
    } catch (reason) {
      releaseStream();
      setError(formatError(reason));
      setState("error");
    }
  }, [finish, releaseStream, state, supported]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") {
      recorder.stop();
    } else {
      releaseStream();
      setState("idle");
    }
  }, [releaseStream]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  useEffect(
    () => () => {
      cancelledRef.current = true;
      const recorder = recorderRef.current;
      if (recorder?.state === "recording") recorder.stop();
      releaseStream();
    },
    [releaseStream],
  );

  return { state, error, supported, start, stop, cancel, clearError };
}

function DocumentView({
  initialTarget,
  onBack,
}: {
  initialTarget: EditorTarget;
  onBack?: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [target, setTarget] = useState(initialTarget);
  const [document, setDocument] = useState<{
    path: string;
    content: string;
    sha256: string;
    sizeBytes: number;
  } | null>(null);
  const [binding, setBinding] = useState<BindingRecord | null>(null);
  const bindingRef = useRef<BindingRecord | null>(null);
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
  const savedRef = useRef("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);
  const [dictationText, setDictationText] = useState("");
  const [dictationError, setDictationError] = useState<string | null>(null);
  const [queueMessage, setQueueMessage] = useState<string | null>(null);

  useEffect(() => {
    setTarget(initialTarget);
  }, [initialTarget]);

  const load = useCallback(
    async (allowDirty = false) => {
      if (!allowDirty && draftRef.current !== savedRef.current) {
        setRemoteChanged(true);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result =
          target.kind === "binding"
            ? await rpc.call("openBinding", { bindingId: target.bindingId })
            : await rpc.call("openDocument", {
                path: target.path,
                source: target.source,
              });
        setDocument(result.document);
        setBinding(result.binding);
        bindingRef.current = result.binding;
        draftRef.current = result.document.content;
        savedRef.current = result.document.content;
        setDraft(result.document.content);
        setRemoteChanged(false);
      } catch (reason) {
        setError(formatError(reason));
      } finally {
        setLoading(false);
      }
    },
    [rpc, target],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const handleBindingEvent = useCallback(
    (payload: unknown) => {
      const changedBindingId = eventBindingId(payload);
      if (
        changedBindingId &&
        bindingRef.current?.id === changedBindingId
      ) {
        void load();
      }
    },
    [load],
  );
  useRealtime("grove-document-changed", handleBindingEvent);
  useRealtime("grove-binding-changed", handleBindingEvent);

  const updateDraft = (value: string) => {
    draftRef.current = value;
    setDraft(value);
    setQueueMessage(null);
  };

  const save = useCallback(
    async (force = false) => {
      if (!document || saving) return;
      setSaving(true);
      setError(null);
      try {
        const result =
          target.kind === "binding"
            ? await rpc.call("saveDocument", {
                kind: "binding",
                bindingId: target.bindingId,
                content: draftRef.current,
                expectedSha256: document.sha256,
                force,
              })
            : await rpc.call("saveDocument", {
                kind: "source",
                path: target.path,
                source: target.source,
                content: draftRef.current,
                expectedSha256: document.sha256,
                force,
              });
        if (result.outcome === "conflict") {
          setRemoteChanged(true);
          setError("The file changed on disk. Reload it or explicitly overwrite it.");
          return;
        }
        setDocument((current) =>
          current
            ? { ...current, content: draftRef.current, sha256: result.sha256, sizeBytes: result.sizeBytes }
            : current,
        );
        savedRef.current = draftRef.current;
        setRemoteChanged(false);
        setQueueMessage("Saved");
      } catch (reason) {
        setError(formatError(reason));
      } finally {
        setSaving(false);
      }
    },
    [document, rpc, saving, target],
  );

  const startAgent = useCallback(async () => {
    if (!document) return;
    const bindInput =
      target.kind === "binding"
        ? binding
          ? {
              path: binding.path,
              source: binding.source,
              title: binding.title,
            }
          : null
        : {
            path: target.path,
            source: target.source,
            title: binding?.title ?? titleFromPath(target.path),
          };
    if (!bindInput) return;
    setError(null);
    try {
      const next = await rpc.call("bindDocument", bindInput);
      setBinding(next);
      bindingRef.current = next;
      setTarget({ kind: "binding", bindingId: next.id });
      setQueueMessage(
        binding ? "Document agent restarted" : "Document agent started",
      );
    } catch (reason) {
      setError(formatError(reason));
    }
  }, [binding, document, rpc, target]);

  const queue = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (!binding) {
        setDictationError("Start a document agent before sending dictation");
        return;
      }
      if (draftRef.current !== savedRef.current) {
        setDictationError("Save your direct edits before sending dictation to the agent");
        return;
      }
      if (!text) return;
      setQueueMessage(null);
      setDictationError(null);
      setError(null);
      try {
        await rpc.call("queueDictation", {
          bindingId: binding.id,
          text,
        });
        setLastTranscript(text);
        setDictationText("");
        setQueueMessage("Queued for the document agent");
      } catch (reason) {
        setDictationError(formatError(reason));
      }
    },
    [binding, rpc],
  );

  const recorder = useDictationRecorder(queue);
  const submitDictation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    recorder.clearError();
    void queue(dictationText);
  };

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        Loading document…
      </div>
    );
  }
  if (!document) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
        <InlineNotice tone="error">
          {error ?? "Document could not be opened"}
        </InlineNotice>
        {onBack ? (
          <button type="button" className={`${quietButtonClass} self-start`} onClick={onBack}>
            ← Back to documents
          </button>
        ) : null}
      </div>
    );
  }

  const dirty = draft !== savedRef.current;
  const title = binding?.title ?? titleFromPath(document.path);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <header className="border-b border-border px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          {onBack ? (
            <button type="button" className={quietButtonClass} onClick={onBack}>
              ← Documents
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h1 className="truncate text-base font-semibold tracking-tight">
                {title}
              </h1>
              {dirty ? (
                <span className="text-xs text-muted-foreground">Unsaved changes</span>
              ) : null}
            </div>
            <p
              className="mt-1 truncate font-mono text-xs text-muted-foreground"
              title={document.path}
            >
              {document.path}
            </p>
          </div>
          {binding ? (
            <BindingStatusView status={binding.status} />
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground">
              Agent not started
            </span>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 sm:px-5">
        <button
          type="button"
          className={primaryButtonClass}
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {remoteChanged ? (
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => void load(true)}
          >
            Reload from disk
          </button>
        ) : null}
        {bindingCanAcceptDictation(binding) ? (
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => navigate.toThread(binding.ownerThreadId)}
          >
            Open agent thread
          </button>
        ) : (
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => void startAgent()}
          >
            {binding ? "Restart document agent" : "Start document agent"}
          </button>
        )}
      </div>

      {binding?.lastError ? (
        <InlineNotice tone="error">Agent issue: {binding.lastError}</InlineNotice>
      ) : null}
      {error ? (
        <InlineNotice
          tone="error"
          action={
            remoteChanged ? (
              <button
                type="button"
                className={`${quietButtonClass} shrink-0 text-foreground`}
                onClick={() => void save(true)}
              >
                Overwrite
              </button>
            ) : undefined
          }
        >
          {error}
        </InlineNotice>
      ) : null}
      {queueMessage ? (
        <InlineNotice tone={queueMessage === "Saved" ? "success" : "info"}>
          {queueMessage}
        </InlineNotice>
      ) : null}

      <textarea
        aria-label="Markdown document"
        className="mx-auto min-h-0 w-full max-w-4xl flex-1 resize-none bg-background px-4 py-6 font-mono text-sm leading-7 text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-8 sm:py-8"
        value={draft}
        onChange={(event) => updateDraft(event.target.value)}
        spellCheck
      />

      {bindingCanAcceptDictation(binding) ? (
        <form
          className="border-t border-border bg-surface-recessed/40 px-4 py-3 sm:px-5"
          onSubmit={submitDictation}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Send an instruction</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Dictation is queued for the document agent to shape into Markdown.
              </p>
            </div>
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={!recorder.supported || recorder.state === "transcribing"}
              onClick={() =>
                recorder.state === "recording"
                  ? recorder.stop()
                  : void recorder.start()
              }
            >
              {recorder.state === "recording"
                ? "Stop dictation"
                : recorder.state === "transcribing"
                  ? "Transcribing…"
                  : "Dictate"}
            </button>
          </div>
          {!recorder.supported ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Voice dictation is not available in this browser. You can still type an instruction below.
            </p>
          ) : null}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
            <label
              className="min-w-0 flex-1 text-xs text-muted-foreground"
              htmlFor="grove-dictation-text"
            >
              <span className="mb-1 block">Instruction</span>
              <input
                id="grove-dictation-text"
                className={fieldClass}
                aria-describedby={dictationError ? "grove-dictation-error" : undefined}
                aria-invalid={Boolean(dictationError)}
                value={dictationText}
                onChange={(event) => {
                  setDictationError(null);
                  recorder.clearError();
                  setDictationText(event.target.value);
                }}
                placeholder="Add a section, tighten the opening, or…"
              />
            </label>
            <button
              type="submit"
              className={`${secondaryButtonClass} shrink-0`}
              disabled={!dictationText.trim()}
            >
              Queue to agent
            </button>
          </div>
          {dictationError ? (
            <p
              id="grove-dictation-error"
              className="mt-2 text-xs text-destructive"
              role="alert"
            >
              {dictationError}
            </p>
          ) : null}
          {recorder.error ? (
            <p
              className="mt-2 text-xs text-destructive"
              role="alert"
            >
              {recorder.error}
            </p>
          ) : null}
          {lastTranscript ? (
            <p
              className="mt-2 truncate text-xs text-muted-foreground"
              title={lastTranscript}
            >
              Last queued: {lastTranscript}
            </p>
          ) : null}
        </form>
      ) : (
        <div className="border-t border-border bg-surface-recessed/40 px-4 py-3 sm:px-5">
          <p className="text-sm font-medium">Direct editing is ready</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {binding
              ? "Restart the document agent to turn dictation into shaped Markdown."
              : "Start the document agent to turn dictation into shaped Markdown."}
          </p>
        </div>
      )}
    </div>
  );
}

function GroveFileOpener({ path: filePath, source }: PluginFileOpenerProps) {
  const target = useMemo(
    () => ({ kind: "source" as const, path: filePath, source: sourceFromFile(source) }),
    [filePath, source.environmentId, source.kind, source.projectId, source.threadId],
  );
  return <DocumentView initialTarget={target} />;
}

function GrovePanel({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const context = useBbContext();
  const [bindings, setBindings] = useState<BindingRecord[]>([]);
  const [activeTarget, setActiveTarget] = useState<EditorTarget | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadBindings = useCallback(async () => {
    try {
      const result = await rpc.call("listBindings", null);
      setBindings(result.bindings);
      setError(null);
    } catch (reason) {
      setError(formatError(reason));
    }
  }, [rpc]);

  useEffect(() => {
    void loadBindings();
  }, [loadBindings]);

  useEffect(() => {
    if (subPath) setActiveTarget({ kind: "binding", bindingId: decodeURIComponent(subPath) });
  }, [subPath]);

  useRealtime("grove-binding-changed", () => void loadBindings());

  if (activeTarget) {
    return <DocumentView initialTarget={activeTarget} onBack={() => { setActiveTarget(null); navigate.toPluginPanel("grove", { subPath: "" }); }} />;
  }

  const openPath = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = pathInput.trim();
    if (!trimmed) return;
    setActiveTarget({
      kind: "source",
      path: trimmed,
      source: {
        kind: "host",
        threadId: context.threadId,
        environmentId: null,
        projectId: context.projectId,
        hostId: null,
      },
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto text-foreground">
      <header className="border-b border-border px-5 py-5">
        <p className="text-xs font-medium text-muted-foreground">Grove writing</p>
        <h1 className="mt-1 text-lg font-semibold tracking-tight">Your documents</h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
          Edit Markdown directly or give a visible document agent a focused instruction.
          Every agent change is checked against the file before it is applied.
        </p>
      </header>

      <section className="border-b border-border px-5 py-5">
        <div className="mb-3">
          <h2 className="text-sm font-semibold">Open a document</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            .md, .mdx, and .markdown files are supported.
          </p>
        </div>
        <form className="space-y-2" onSubmit={openPath}>
          <label className="block text-xs text-muted-foreground" htmlFor="grove-open-path">
            File path
            <input
              id="grove-open-path"
              className={`${fieldClass} mt-1.5`}
              value={pathInput}
              onChange={(event) => setPathInput(event.target.value)}
              placeholder="/Users/you/Notes/idea.md"
            />
          </label>
          <button
            type="submit"
            className={`${primaryButtonClass} w-full`}
            disabled={!pathInput.trim()}
          >
            Open document
          </button>
        </form>
      </section>

      {error ? (
        <div className="px-5 pt-4">
          <InlineNotice tone="error">{error}</InlineNotice>
        </div>
      ) : null}

      <section className="px-5 py-5">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold">Bound documents</h2>
          {bindings.length ? (
            <span className="text-xs text-muted-foreground">
              {bindings.length} {bindings.length === 1 ? "document" : "documents"}
            </span>
          ) : null}
        </div>
        {bindings.length ? (
          <div className="divide-y divide-border border-y border-border">
            {bindings.map((binding) => (
              <button
                key={binding.id}
                type="button"
                className="group flex w-full min-w-0 items-center gap-3 py-3 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => navigate.toPluginPanel("grove", { subPath: binding.id })}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium group-hover:text-foreground">
                    {binding.title}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                    {binding.path}
                  </span>
                </span>
                <BindingStatusView status={binding.status} />
              </button>
            ))}
          </div>
        ) : error ? null : (
          <div className="border border-dashed border-border bg-surface-recessed/30 px-4 py-5">
            <p className="text-sm font-medium">Nothing bound yet</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Open a Markdown file above, then start its document agent when you
              want help shaping the draft.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function GroveThreadPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [binding, setBinding] = useState<BindingRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const restartAgent = useCallback(async () => {
    if (!binding) return;
    setError(null);
    try {
      const next = await rpc.call("bindDocument", {
        path: binding.path,
        source: binding.source,
        title: binding.title,
      });
      setBinding(next);
    } catch (reason) {
      setError(formatError(reason));
    }
  }, [binding, rpc]);

  const load = useCallback(async () => {
    try {
      const result = await rpc.call("bindingForThread", { threadId });
      setBinding(result.binding);
      setError(null);
    } catch (reason) {
      setError(formatError(reason));
    }
  }, [rpc, threadId]);
  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("grove-binding-changed", () => void load());

  if (error) {
    return (
      <div className="p-4">
        <InlineNotice tone="error">{error}</InlineNotice>
      </div>
    );
  }
  if (!binding) {
    return (
      <div className="p-4">
        <div className="border border-dashed border-border bg-surface-recessed/30 px-4 py-5 text-sm text-muted-foreground">
          This thread is not the owner of a Grove document.
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col text-foreground">
      <div className="border-b border-border px-4 py-4">
        <p className="text-xs font-medium text-muted-foreground">Grove document</p>
        <h2 className="mt-1 text-base font-semibold tracking-tight">{binding.title}</h2>
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
          {binding.path}
        </p>
      </div>
      <div className="flex flex-col gap-4 px-4 py-4">
        <BindingStatusView status={binding.status} />
        {binding.lastError ? (
          <InlineNotice tone="error">Agent issue: {binding.lastError}</InlineNotice>
        ) : null}
        <button
          type="button"
          className={`${bindingCanAcceptDictation(binding) ? secondaryButtonClass : primaryButtonClass} self-start`}
          onClick={() => navigate.toPluginPanel("grove", { subPath: binding.id })}
        >
          Open document
        </button>
        {!bindingCanAcceptDictation(binding) ? (
          <button
            type="button"
            className={`${secondaryButtonClass} self-start`}
            onClick={() => void restartAgent()}
          >
            Restart document agent
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "grove",
    title: "Grove",
    icon: "FileText",
    path: "grove",
    component: GrovePanel,
  });
  app.slots.fileOpener({
    id: "grove",
    title: "Grove writing",
    extensions: ["md", "mdx", "markdown"],
    component: GroveFileOpener,
  });
  app.slots.threadPanelAction({
    id: "document-agent",
    title: "Document agent",
    icon: "FileText",
    component: GroveThreadPanel,
  });
});
