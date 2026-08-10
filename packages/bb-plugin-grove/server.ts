import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { canonicalDocumentPath, resolveDocumentTarget } from "./src/paths";
import { GroveStore } from "./src/store";
import type {
  BindingRecord,
  BindingStatus,
  DocumentRecord,
  DocumentSource,
  ResolvedDocumentTarget,
} from "./src/types";

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_DOCUMENT_CHARS = 1_500_000;
const MAX_DICTATION_CHARS = 12_000;

const sourceSchema = z
  .object({
    kind: z.enum(["workspace", "host", "thread-storage"]),
    threadId: z.string().nullable(),
    environmentId: z.string().nullable(),
    projectId: z.string().nullable(),
    hostId: z.string().nullable(),
  })
  .strict();

const bindingSchema = z
  .object({
    id: z.string(),
    path: z.string(),
    title: z.string(),
    source: sourceSchema,
    ownerThreadId: z.string(),
    status: z.enum(["ready", "working", "error", "orphaned"]),
    lastSha256: z.string().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();

const documentSchema = z
  .object({
    path: z.string(),
    content: z.string(),
    sha256: z.string(),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

const openDocumentInput = z
  .object({ path: z.string().min(1), source: sourceSchema })
  .strict();

const bindDocumentInput = z
  .object({
    path: z.string().min(1),
    title: z.string().trim().min(1).max(200),
    source: sourceSchema,
  })
  .strict();

const saveDocumentInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("binding"),
      bindingId: z.string().min(1),
      content: z.string().max(MAX_DOCUMENT_CHARS),
      expectedSha256: z.string().nullable(),
      force: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("source"),
      path: z.string().min(1),
      source: sourceSchema,
      content: z.string().max(MAX_DOCUMENT_CHARS),
      expectedSha256: z.string().nullable(),
      force: z.boolean(),
    })
    .strict(),
]);

const queueDictationInput = z
  .object({
    bindingId: z.string().min(1),
    text: z.string().trim().min(1).max(MAX_DICTATION_CHARS),
  })
  .strict();

const bindingIdInput = z.object({ bindingId: z.string().min(1) }).strict();
const threadIdInput = z.object({ threadId: z.string().min(1) }).strict();

const documentResponse = z
  .object({
    document: documentSchema,
    binding: bindingSchema.nullable(),
  })
  .strict();

const saveResponse = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("written"),
      sha256: z.string(),
      sizeBytes: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("conflict"),
      currentSha256: z.string().nullable(),
    })
    .strict(),
]);

export const rpcContract = defineRpcContract({
  listBindings: {
    input: z.null(),
    output: z.object({ bindings: z.array(bindingSchema) }).strict(),
  },
  openDocument: {
    input: openDocumentInput,
    output: documentResponse,
  },
  openBinding: {
    input: bindingIdInput,
    output: documentResponse,
  },
  bindDocument: {
    input: bindDocumentInput,
    output: bindingSchema,
  },
  saveDocument: {
    input: saveDocumentInput,
    output: saveResponse,
  },
  queueDictation: {
    input: queueDictationInput,
    output: z
      .object({
        queueId: z.string(),
        threadId: z.string(),
        status: z.literal("queued"),
      })
      .strict(),
  },
  bindingForThread: {
    input: threadIdInput,
    output: z.object({ binding: bindingSchema.nullable() }).strict(),
  },
});

const readDocumentToolParameters = z
  .object({
    bindingId: z.string().min(1).describe("The Grove document binding to read"),
  })
  .strict();

const applyDocumentToolParameters = z
  .object({
    bindingId: z.string().min(1).describe("The Grove document binding to edit"),
    baseSha256: z
      .string()
      .min(1)
      .describe("The SHA-256 returned by grove_read_document"),
    content: z
      .string()
      .max(MAX_DOCUMENT_CHARS)
      .describe("The complete replacement Markdown document"),
    rationale: z.string().max(500).optional(),
  })
  .strict();

type SourceInput = z.infer<typeof sourceSchema>;
type SaveInput = z.infer<typeof saveDocumentInput>;
type ThreadSnapshot = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

function asSource(source: SourceInput, projectId: string | null): DocumentSource {
  return {
    kind: source.kind,
    threadId: source.threadId,
    environmentId:
      source.kind === "thread-storage" ? null : source.environmentId,
    projectId: source.projectId ?? projectId,
    hostId: source.kind === "host" ? source.hostId : null,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bindingDto(binding: BindingRecord) {
  return binding;
}

function documentDto(
  target: ResolvedDocumentTarget,
  file: DocumentRecord,
): DocumentRecord {
  return {
    path: target.displayPath,
    content: file.content,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
  };
}

function sourceForTarget(
  source: DocumentSource,
  target: ResolvedDocumentTarget,
): DocumentSource {
  if (source.kind !== "host" || source.hostId || !target.hostId) {
    return source;
  }
  return { ...source, hostId: target.hostId };
}

async function resolveProjectId(
  bb: BbPluginApi,
  preferredProjectId: string | null,
  environmentId: string | null,
): Promise<string> {
  const projects = await bb.sdk.projects.list({ includePersonal: true });
  if (preferredProjectId) {
    const preferred = projects.find((project) => project.id === preferredProjectId);
    if (preferred) return preferred.id;
  }
  if (environmentId) {
    const environment = await bb.sdk.environments.get({ environmentId });
    return environment.projectId;
  }
  const personal = projects.find((project) => project.kind === "personal");
  const standard = projects.find((project) => project.kind === "standard");
  const fallback = personal ?? standard ?? projects[0];
  if (!fallback) throw new Error("No BB project is available for a document agent");
  return fallback.id;
}

function ownerPrompt(bindingId: string, title: string, filePath: string): string {
  return [
    `You are the Grove document agent for "${title}".`,
    `Binding id: ${bindingId}. Document path: ${filePath}.`,
    "Your job is to shape user dictation into a coherent Markdown document.",
    "This setup turn only establishes ownership: do not modify the document.",
    "On later turns, use grove_read_document before editing and use grove_apply_document with the exact SHA you read.",
    "Never overwrite a changed document: if the edit reports a conflict, read again and reconcile deliberately.",
    "Keep the user's meaning and voice. Treat direct edits as authoritative input, not as noise.",
  ].join("\n\n");
}

function dictationPrompt(binding: BindingRecord, transcript: string): string {
  return [
    `New dictated passage for the document "${binding.title}".`,
    "The passage is user editorial intent. Shape it into the document instead of appending raw transcript text mechanically.",
    "Read the current document first. Preserve existing structure and meaning, then apply a coherent Markdown edit with grove_apply_document.",
    "If the document changed since you read it, do not overwrite it; reconcile against the newest SHA.",
    "<dictation>",
    transcript,
    "</dictation>",
  ].join("\n");
}

async function readTarget(
  bb: BbPluginApi,
  target: ResolvedDocumentTarget,
): Promise<DocumentRecord> {
  const file = await bb.sdk.files.read({
    path: target.filePath,
    rootPath: target.rootPath,
    ...(target.hostId ? { hostId: target.hostId } : {}),
  });
  if (file.contentEncoding !== "utf8") {
    throw new Error("Grove only edits UTF-8 Markdown files");
  }
  if (file.sizeBytes > MAX_DOCUMENT_BYTES) {
    throw new Error("Grove documents must be smaller than 2 MiB");
  }
  return {
    path: target.displayPath,
    content: file.content,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
  };
}

async function writeTarget(
  bb: BbPluginApi,
  target: ResolvedDocumentTarget,
  content: string,
  expectedSha256: string | null,
  force: boolean,
) {
  if (Buffer.byteLength(content, "utf8") > MAX_DOCUMENT_BYTES) {
    throw new Error("Grove documents must be smaller than 2 MiB");
  }
  const base = {
    path: target.filePath,
    rootPath: target.rootPath,
    content,
    contentEncoding: "utf8" as const,
    createParents: true,
    ...(target.hostId ? { hostId: target.hostId } : {}),
  };
  if (force) return bb.sdk.files.write(base);
  return bb.sdk.files.write({ ...base, expectedSha256 });
}

async function openSourceDocument(
  bb: BbPluginApi,
  store: GroveStore,
  sourceInput: SourceInput,
  filePath: string,
  reconcile?: (binding: BindingRecord) => Promise<BindingRecord>,
): Promise<{ document: DocumentRecord; binding: BindingRecord | null }> {
  const requestedSource = asSource(sourceInput, sourceInput.projectId);
  const initialTarget = await resolveDocumentTarget(bb, requestedSource, filePath);
  const source = sourceForTarget(requestedSource, initialTarget);
  const canonicalPath = canonicalDocumentPath(source, initialTarget);
  const stored = store.findBySource(source, canonicalPath);
  const binding = stored && reconcile ? await reconcile(stored) : stored;
  const target = binding
    ? await resolveDocumentTarget(bb, binding.source, binding.path)
    : initialTarget;
  const file = await readTarget(bb, target);
  return { document: documentDto(target, file), binding };
}

async function openBindingDocument(
  bb: BbPluginApi,
  store: GroveStore,
  bindingId: string,
): Promise<{ document: DocumentRecord; binding: BindingRecord }> {
  const binding = store.getBinding(bindingId);
  if (!binding) throw new Error("Grove document binding not found");
  const target = await resolveDocumentTarget(bb, binding.source, binding.path);
  const file = await readTarget(bb, target);
  return { document: documentDto(target, file), binding };
}

async function runOwnerThread(
  bb: BbPluginApi,
  binding: Pick<BindingRecord, "id" | "path" | "title" | "source">,
): Promise<{ threadId: string; projectId: string }> {
  let environmentId = binding.source.environmentId;
  if (
    !environmentId &&
    binding.source.threadId &&
    (binding.source.kind === "host" || binding.source.kind === "thread-storage")
  ) {
    const thread = await bb.sdk.threads.get({
      threadId: binding.source.threadId,
      include: "environment",
    });
    environmentId = thread.environmentId;
  }
  if (!environmentId && binding.source.kind === "thread-storage") {
    throw new Error("The thread has no environment for its storage files");
  }
  const projectId = await resolveProjectId(
    bb,
    binding.source.projectId,
    environmentId,
  );
  const thread = await bb.sdk.threads.spawn({
    projectId,
    environment: environmentId
      ? { type: "reuse", environmentId }
      : { type: "project-default" },
    title: `Grove · ${binding.title}`,
    visibility: "visible",
    prompt: ownerPrompt(binding.id, binding.title, binding.path),
  });
  return { threadId: thread.id, projectId };
}

function requireOwner(binding: BindingRecord | null, threadId: string): BindingRecord {
  if (!binding) throw new Error("Grove document binding not found");
  if (binding.ownerThreadId !== threadId) {
    throw new Error("This agent does not own the requested Grove document");
  }
  return binding;
}

function parseCliArgs(argv: string[]): { args: string[]; json: boolean } {
  return { args: argv.filter((value) => value !== "--json"), json: argv.includes("--json") };
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  const store = new GroveStore(db);
  store.migrate((database, statements) => bb.storage.migrate(database, statements));

  let bindingLock: Promise<void> = Promise.resolve();
  const pendingOwnerStatuses = new Map<
    string,
    { status: BindingStatus; error: string | null }
  >();

  function applyPendingOwnerStatus(binding: BindingRecord): BindingRecord {
    const pending = pendingOwnerStatuses.get(binding.ownerThreadId);
    if (!pending) return binding;
    pendingOwnerStatuses.delete(binding.ownerThreadId);
    store.updateStatus(binding.id, pending.status, pending.error);
    return store.getBinding(binding.id) ?? binding;
  }

  function withBindingLock<T>(operation: () => Promise<T>): Promise<T> {
    const current = bindingLock.then(operation);
    bindingLock = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  function ownerState(
    thread: ThreadSnapshot,
    current: BindingRecord,
    preserveWorkingOnIdle: boolean,
  ): { status: BindingStatus; error: string | null } {
    if (thread.deletedAt !== null) {
      return { status: "orphaned", error: "The owner thread was deleted" };
    }
    if (thread.archivedAt !== null) {
      return { status: "orphaned", error: "The owner thread was archived" };
    }
    if (thread.status === "error") {
      return {
        status: "error",
        error: current.lastError ?? "The owner thread is in an error state",
      };
    }
    if (
      preserveWorkingOnIdle &&
      current.status === "working" &&
      thread.status === "idle"
    ) {
      return { status: "working", error: null };
    }
    if (current.status === "error" || current.status === "orphaned") {
      return { status: current.status, error: current.lastError };
    }
    return {
      status:
        thread.status === "active" ||
        thread.status === "starting" ||
        thread.status === "stopping"
          ? "working"
          : "ready",
      error: null,
    };
  }

  function isMissingThreadError(error: unknown): boolean {
    const message = errorText(error).toLowerCase();
    return message.includes("thread not found") || message.includes("thread_not_found");
  }

  async function reconcileBindingOwner(
    binding: BindingRecord,
    preserveWorkingOnIdle = true,
  ): Promise<BindingRecord> {
    let thread: ThreadSnapshot;
    try {
      thread = await bb.sdk.threads.get({ threadId: binding.ownerThreadId });
    } catch (error) {
      if (!isMissingThreadError(error)) return store.getBinding(binding.id) ?? binding;
      const current = store.getBinding(binding.id);
      if (!current || current.ownerThreadId !== binding.ownerThreadId) {
        return current ?? binding;
      }
      store.updateStatus(binding.id, "orphaned", "The owner thread was deleted");
      const updated = store.getBinding(binding.id) ?? binding;
      bb.realtime.publish("grove-binding-changed", { bindingId: binding.id });
      return updated;
    }

    const current = store.getBinding(binding.id);
    if (!current || current.ownerThreadId !== binding.ownerThreadId) {
      return current ?? binding;
    }
    const next = ownerState(thread, current, preserveWorkingOnIdle);
    if (current.status === next.status && current.lastError === next.error) {
      return current;
    }
    store.updateStatus(binding.id, next.status, next.error);
    const updated = store.getBinding(binding.id) ?? current;
    bb.realtime.publish("grove-binding-changed", { bindingId: binding.id });
    return updated;
  }

  async function reconcileAllBindings(
    preserveWorkingOnIdle = true,
  ): Promise<BindingRecord[]> {
    return Promise.all(
      store
        .listBindings()
        .map((binding) => reconcileBindingOwner(binding, preserveWorkingOnIdle)),
    );
  }

  async function bindDocument(input: z.infer<typeof bindDocumentInput>): Promise<BindingRecord> {
    return withBindingLock(async () => {
      const targetSource = asSource(input.source, input.source.projectId);
      const target = await resolveDocumentTarget(bb, targetSource, input.path);
      const source = sourceForTarget(targetSource, target);
      const canonicalPath = canonicalDocumentPath(source, target);
      const file = await readTarget(bb, target);
      const stored = store.findBySource(source, canonicalPath);
      const existing = stored ? await reconcileBindingOwner(stored) : null;
      if (existing && (existing.status === "ready" || existing.status === "working")) {
        return applyPendingOwnerStatus(existing);
      }

      const projectId = await resolveProjectId(
        bb,
        source.projectId,
        source.environmentId,
      );
      const boundSource: DocumentSource = { ...source, projectId };
      const bindingId = existing?.id ?? randomUUID();
      const owner = await runOwnerThread(bb, {
        id: bindingId,
        path: canonicalPath,
        title: input.title,
        source: boundSource,
      });
      const binding = existing
        ? store.reassignBinding(existing.id, owner.threadId, "ready", file.sha256)
        : store.createBinding({
            id: bindingId,
            path: canonicalPath,
            title: input.title,
            source: boundSource,
            ownerThreadId: owner.threadId,
            status: "ready",
            lastSha256: file.sha256,
          });
      const current = applyPendingOwnerStatus(binding);
      bb.realtime.publish("grove-binding-changed", { bindingId: binding.id });
      return current;
    });
  }

  async function restartBinding(bindingId: string): Promise<BindingRecord> {
    return withBindingLock(async () => {
      const stored = store.getBinding(bindingId);
      const existing = stored ? await reconcileBindingOwner(stored) : null;
      if (!existing) throw new Error("Grove document binding not found");
      if (existing.status === "ready" || existing.status === "working") {
        return applyPendingOwnerStatus(existing);
      }
      const target = await resolveDocumentTarget(bb, existing.source, existing.path);
      const file = await readTarget(bb, target);
      const owner = await runOwnerThread(bb, existing);
      const binding = store.reassignBinding(
        existing.id,
        owner.threadId,
        "ready",
        file.sha256,
      );
      const current = applyPendingOwnerStatus(binding);
      bb.realtime.publish("grove-binding-changed", { bindingId: binding.id });
      return current;
    });
  }

  async function queueDictation(bindingId: string, transcript: string) {
    return withBindingLock(async () => {
      const stored = store.getBinding(bindingId);
      const binding = stored
        ? await reconcileBindingOwner(stored)
        : null;
      if (!binding) throw new Error("Grove document binding not found");
      if (binding.status === "error" || binding.status === "orphaned") {
        throw new Error("Start the document agent again before sending dictation");
      }
      const queueId = randomUUID();
      store.insertDictation(queueId, binding.id, transcript.trim());
      try {
        await bb.sdk.threads.queuedMessages.create({
          threadId: binding.ownerThreadId,
          input: [
            {
              type: "text",
              text: dictationPrompt(binding, transcript.trim()),
              mentions: [],
            },
          ],
        });
        store.markDictationSent(queueId);
        const current = store.getBinding(binding.id);
        if (
          current &&
          current.ownerThreadId === binding.ownerThreadId &&
          current.status !== "error" &&
          current.status !== "orphaned"
        ) {
          store.updateStatus(binding.id, "working", null);
          bb.realtime.publish("grove-binding-changed", { bindingId: binding.id });
        }
        return { queueId, threadId: binding.ownerThreadId, status: "queued" as const };
      } catch (error) {
        const message = errorText(error);
        store.markDictationFailed(queueId, message);
        const current = store.getBinding(binding.id);
        if (
          current?.ownerThreadId === binding.ownerThreadId &&
          current.status !== "error" &&
          current.status !== "orphaned"
        ) {
          store.updateStatus(binding.id, "error", message);
          bb.realtime.publish("grove-binding-changed", { bindingId: binding.id });
        }
        throw error;
      }
    });
  }

  bb.rpc.register(rpcContract, {
    async listBindings() {
      return { bindings: (await reconcileAllBindings()).map(bindingDto) };
    },
    async openDocument(input) {
      return openSourceDocument(
        bb,
        store,
        input.source,
        input.path,
        reconcileBindingOwner,
      );
    },
    async openBinding(input) {
      const stored = store.getBinding(input.bindingId);
      if (stored) await reconcileBindingOwner(stored);
      return openBindingDocument(bb, store, input.bindingId);
    },
    async bindDocument(input) {
      return bindDocument(input);
    },
    async saveDocument(input: SaveInput) {
      let binding: BindingRecord | null = null;
      let target: ResolvedDocumentTarget;
      if (input.kind === "binding") {
        const opened = await openBindingDocument(bb, store, input.bindingId);
        binding = opened.binding;
        target = await resolveDocumentTarget(bb, binding.source, binding.path);
      } else {
        const source = asSource(input.source, input.source.projectId);
        target = await resolveDocumentTarget(bb, source, input.path);
      }
      const result = await writeTarget(
        bb,
        target,
        input.content,
        input.expectedSha256,
        input.force,
      );
      if (result.outcome === "conflict") return result;
      if (binding) {
        store.updateSha(binding.id, result.sha256);
        store.updateStatus(binding.id, "ready", null);
        bb.realtime.publish("grove-document-changed", {
          bindingId: binding.id,
          sha256: result.sha256,
        });
      }
      return {
        outcome: "written" as const,
        sha256: result.sha256,
        sizeBytes: result.sizeBytes,
      };
    },
    async queueDictation(input) {
      return queueDictation(input.bindingId, input.text);
    },
    async bindingForThread(input) {
      const binding = store.getBindingForThread(input.threadId);
      return { binding: binding ? await reconcileBindingOwner(binding) : null };
    },
  });

  bb.agents.registerTool({
    name: "grove_read_document",
    description: "Read the current Markdown document owned by this Grove agent.",
    instructions:
      "Before shaping a dictated passage, call grove_read_document and use its SHA as the base for your edit.",
    parameters: readDocumentToolParameters,
    async execute({ bindingId }, context) {
      const binding = requireOwner(store.getBinding(bindingId), context.threadId);
      const target = await resolveDocumentTarget(bb, binding.source, binding.path);
      const document = await readTarget(bb, target);
      return JSON.stringify({
        bindingId: binding.id,
        title: binding.title,
        path: binding.path,
        sha256: document.sha256,
        content: document.content,
      });
    },
  });

  bb.agents.registerTool({
    name: "grove_apply_document",
    description:
      "Apply a complete Markdown replacement to the Grove document when the base SHA is still current.",
    instructions:
      "Use grove_apply_document only after reading the document. A conflict is a signal to read again; never retry with force.",
    parameters: applyDocumentToolParameters,
    async execute({ bindingId, baseSha256, content, rationale }, context) {
      const binding = requireOwner(store.getBinding(bindingId), context.threadId);
      const target = await resolveDocumentTarget(bb, binding.source, binding.path);
      const current = await readTarget(bb, target);
      if (current.sha256 !== baseSha256) {
        return JSON.stringify({
          outcome: "conflict",
          bindingId,
          currentSha256: current.sha256,
          message: "The document changed after the agent read it. Read it again before editing.",
        });
      }
      const result = await writeTarget(bb, target, content, baseSha256, false);
      if (result.outcome === "conflict") {
        return JSON.stringify({
          outcome: "conflict",
          bindingId,
          currentSha256: result.currentSha256,
          message: "The document changed while the agent was writing. Read it again.",
        });
      }
      store.updateSha(binding.id, result.sha256);
      store.updateStatus(binding.id, "working", null);
      bb.realtime.publish("grove-document-changed", {
        bindingId: binding.id,
        sha256: result.sha256,
      });
      return JSON.stringify({
        outcome: "written",
        bindingId,
        sha256: result.sha256,
        rationale: rationale?.trim() || null,
      });
    },
  });

  bb.agents.configure((context) => {
    if (context.origin.pluginId !== bb.pluginId) {
      return { tools: [], skills: [] };
    }
    return {
      tools: ["grove_read_document", "grove_apply_document"],
      skills: ["grove-document-agent"],
      instructions:
        "This is a Grove document-owner thread. Keep direct edits safe, shape dictation into the bound Markdown document, and preserve the SHA compare-and-swap contract.",
    };
  });

  const updateThreadStatus = (
    threadId: string,
    status: BindingStatus,
    error: string | null,
    rememberIfUnbound: boolean,
  ) => {
    const binding = store.getBindingForThread(threadId);
    if (!binding) {
      if (rememberIfUnbound && (status === "error" || status === "orphaned")) {
        pendingOwnerStatuses.set(threadId, { status, error });
      }
      return;
    }
    store.updateStatus(binding.id, status, error);
    bb.realtime.publish("grove-binding-changed", { bindingId: binding.id });
  };

  bb.events.on("thread.active", ({ thread }) => {
    updateThreadStatus(thread.id, "working", null, thread.originPluginId === bb.pluginId);
  });
  bb.events.on("thread.idle", ({ thread }) => {
    updateThreadStatus(thread.id, "ready", null, thread.originPluginId === bb.pluginId);
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    updateThreadStatus(thread.id, "error", error, thread.originPluginId === bb.pluginId);
  });
  bb.events.on("thread.archived", ({ thread }) => {
    updateThreadStatus(
      thread.id,
      "orphaned",
      "The owner thread was archived",
      thread.originPluginId === bb.pluginId,
    );
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    updateThreadStatus(
      thread.id,
      "orphaned",
      "The owner thread was deleted",
      thread.originPluginId === bb.pluginId,
    );
  });

  bb.cli.register({
    name: "grove",
    summary: "Queue dictation for Grove document agents",
    commands: [
      { name: "list", summary: "List bound Grove documents", usage: "bb grove list [--json]" },
      { name: "status", summary: "Show a document binding", usage: "bb grove status <binding-id> [--json]" },
      { name: "restart", summary: "Restart a failed or orphaned document agent", usage: "bb grove restart <binding-id> [--json]" },
      { name: "dictate", summary: "Queue text as a dictated passage", usage: "bb grove dictate <binding-id> <text> [--json]" },
    ],
    async run(argv) {
      const { args, json } = parseCliArgs(argv);
      const command = args[0] ?? "list";
      if (command === "list") {
        const bindings = await reconcileAllBindings();
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify({ bindings }) : bindings.map((binding) => `${binding.id}  ${binding.title}  ${binding.status}`).join("\n"),
        };
      }
      if (command === "status") {
        const binding = args[1] ? store.getBinding(args[1]) : null;
        if (!binding) return { exitCode: 1, stderr: "Grove binding not found" };
        return { exitCode: 0, stdout: json ? JSON.stringify(binding) : `${binding.title}\n${binding.path}\n${binding.status}\n${binding.ownerThreadId}` };
      }
      if (command === "restart") {
        const bindingId = args[1];
        if (!bindingId) return { exitCode: 2, stderr: "Usage: bb grove restart <binding-id> [--json]" };
        try {
          const binding = await restartBinding(bindingId);
          return { exitCode: 0, stdout: json ? JSON.stringify(binding) : `Restarted ${binding.title} for ${binding.ownerThreadId}` };
        } catch (error) {
          return { exitCode: 1, stderr: errorText(error) };
        }
      }
      if (command === "dictate") {
        const bindingId = args[1];
        const text = args.slice(2).join(" ").trim();
        if (!bindingId || !text) return { exitCode: 2, stderr: "Usage: bb grove dictate <binding-id> <text> [--json]" };
        try {
          const result = await queueDictation(bindingId, text);
          return { exitCode: 0, stdout: json ? JSON.stringify(result) : `Queued ${result.queueId} for ${result.threadId}` };
        } catch (error) {
          return { exitCode: 1, stderr: errorText(error) };
        }
      }
      return { exitCode: 2, stderr: "Usage: bb grove <list|status|restart|dictate> …" };
    },
  });

  await reconcileAllBindings(false);
}
