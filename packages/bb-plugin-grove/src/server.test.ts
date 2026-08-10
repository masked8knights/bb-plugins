import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createFakePluginHost, makeThreadResponse } from "@bb/plugin-sdk/testing";
import plugin from "../server";

const source = {
  kind: "host" as const,
  threadId: null,
  environmentId: null,
  projectId: "project-1",
  hostId: null,
};

const agentDocumentSchema = z
  .object({
    bindingId: z.string(),
    title: z.string(),
    path: z.string(),
    sha256: z.string(),
    content: z.string(),
  })
  .strict();

const agentConflictSchema = z
  .object({
    outcome: z.literal("conflict"),
    bindingId: z.string(),
    currentSha256: z.string(),
    message: z.string(),
  })
  .strict();

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

interface HostOptions {
  spawn?: () => Promise<{ id: string }>;
  spawnIds?: string[];
  queuedCreate?: () => Promise<{ id: string }>;
  threadGet?: () => Promise<ReturnType<typeof makeThreadResponse>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function stringField(value: unknown, field: string): string {
  if (!isRecord(value) || typeof value[field] !== "string") {
    throw new Error(`Expected a string field named ${field}`);
  }
  return value[field];
}

function createHost(initialContent: string, options: HostOptions = {}) {
  let content = initialContent;
  const filePath = "/workspace/notes.md";
  let spawnIndex = 0;
  const host = createFakePluginHost({
    pluginId: "grove",
    sdk: {
      projects: {
        list: async () => [
          { id: "project-1", kind: "standard", name: "Test", gitRemoteUrl: null },
        ],
      },
      files: {
        read: async () => ({
          path: filePath,
          content,
          contentEncoding: "utf8" as const,
          mimeType: "text/markdown",
          sizeBytes: Buffer.byteLength(content),
          modifiedAtMs: 1,
          sha256: sha256(content),
        }),
        write: async (args) => {
          const currentSha256 = sha256(content);
          if (
            args.expectedSha256 !== undefined &&
            args.expectedSha256 !== currentSha256
          ) {
            return { outcome: "conflict" as const, currentSha256 };
          }
          content = args.content;
          return {
            outcome: "written" as const,
            sha256: sha256(content),
            sizeBytes: Buffer.byteLength(content),
          };
        },
      },
      threads: {
        get: options.threadGet ?? (async () => makeThreadResponse({ id: "owner-thread-1" })),
        spawn: options.spawn ?? (async () => ({
          id: options.spawnIds?.[spawnIndex++] ?? "owner-thread-1",
        })),
        queuedMessages: {
          create: options.queuedCreate ?? (async () => ({ id: "queued-message-1" })),
          send: async () => ({ ok: true }),
        },
      },
    },
  });
  hosts.push(host);
  return { host, filePath, readContent: () => content, setContent: (next: string) => { content = next; } };
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

describe("Grove server", () => {
  it("binds a document and queues dictation through the queued-message API", async () => {
    const { host, filePath } = createHost("# Notes\n\nStart here.\n");
    await plugin(host.bb);

    const binding = await host.harness.callRpc("bindDocument", {
      path: filePath,
      title: "Notes",
      source,
    });
    const bindingId = stringField(binding, "id");

    expect(binding).toMatchObject({
      path: filePath,
      title: "Notes",
      ownerThreadId: "owner-thread-1",
      status: "ready",
    });
    expect(host.harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      projectId: "project-1",
      title: "Grove · Notes",
      visibility: "visible",
    });

    const queued = await host.harness.callRpc("queueDictation", {
      bindingId,
      text: "Add a paragraph about the next milestone.",
    });

    expect(queued).toMatchObject({
      threadId: "owner-thread-1",
      status: "queued",
    });
    const createArgs = host.harness.sdk.callsTo(
      "threads.queuedMessages.create",
    )[0]?.[0];
    expect(createArgs).toMatchObject({
      threadId: "owner-thread-1",
      input: [
        expect.objectContaining({
          type: "text",
          mentions: [],
        }),
      ],
    });
    expect(JSON.stringify(createArgs)).toContain(
      "Add a paragraph about the next milestone.",
    );
    expect(host.harness.sdk.callsTo("threads.queuedMessages.send")).toHaveLength(0);

    const listed = await host.harness.callRpc("listBindings", null);
    expect(listed).toMatchObject({
      bindings: [expect.objectContaining({ id: bindingId, status: "working" })],
    });
  });

  it("refuses an agent write when a direct edit changed the document", async () => {
    const { host, filePath, setContent } = createHost("# Notes\n\nStart here.\n");
    await plugin(host.bb);

    const binding = await host.harness.callRpc("bindDocument", {
      path: filePath,
      title: "Notes",
      source,
    });
    const bindingId = stringField(binding, "id");

    const readResult = await host.harness.callAgentTool("grove_read_document", {
      bindingId,
    }, { threadId: "owner-thread-1", projectId: "project-1" });
    if (typeof readResult !== "string") {
      throw new Error("Expected Grove read tool to return JSON text");
    }
    const read = agentDocumentSchema.parse(JSON.parse(readResult));
    setContent(`${read.content}\nA direct edit.\n`);

    const applied = await host.harness.callAgentTool(
      "grove_apply_document",
      {
        bindingId,
        baseSha256: read.sha256,
        content: `${read.content}\nAn agent edit.\n`,
      },
      { threadId: "owner-thread-1", projectId: "project-1" },
    );
    if (typeof applied !== "string") {
      throw new Error("Expected Grove apply tool to return JSON text");
    }
    expect(agentConflictSchema.parse(JSON.parse(applied))).toMatchObject({
      bindingId,
      currentSha256: sha256(`${read.content}\nA direct edit.\n`),
    });
    expect(host.harness.sdk.callsTo("files.write")).toHaveLength(0);
  });

  it("serializes concurrent binds so one document gets one owner", async () => {
    let spawnCount = 0;
    let releaseSpawn!: () => void;
    let markSpawnStarted!: () => void;
    const spawnStarted = new Promise<void>((resolve) => {
      markSpawnStarted = resolve;
    });
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const { host, filePath } = createHost("# Notes\n", {
      spawn: async () => {
        spawnCount += 1;
        markSpawnStarted();
        await spawnGate;
        return { id: `owner-thread-${spawnCount}` };
      },
    });
    await plugin(host.bb);

    const first = host.harness.callRpc("bindDocument", {
      path: filePath,
      title: "Notes",
      source,
    });
    await spawnStarted;
    const second = host.harness.callRpc("bindDocument", {
      path: filePath,
      title: "Notes",
      source,
    });
    await Promise.resolve();
    expect(spawnCount).toBe(1);

    releaseSpawn();
    const [firstBinding, secondBinding] = await Promise.all([first, second]);
    expect(stringField(firstBinding, "id")).toBe(stringField(secondBinding, "id"));
    expect(spawnCount).toBe(1);
    const listed = z
      .object({ bindings: z.array(z.unknown()) })
      .parse(await host.harness.callRpc("listBindings", null));
    expect(listed.bindings).toHaveLength(1);
  });

  it("restarts failed bindings and exposes the recovery through the CLI", async () => {
    const { host, filePath } = createHost("# Notes\n", {
      spawnIds: ["owner-thread-1", "owner-thread-2"],
    });
    await plugin(host.bb);

    const binding = await host.harness.callRpc("bindDocument", {
      path: filePath,
      title: "Notes",
      source,
    });
    const bindingId = stringField(binding, "id");
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "owner-thread-1" }),
      error: "provider stopped",
    });

    await expect(
      host.harness.callRpc("queueDictation", {
        bindingId,
        text: "This must wait for recovery.",
      }),
    ).rejects.toThrow(/Start the document agent again/);

    const restarted = await host.harness.behavior.runCli([
      "restart",
      bindingId,
      "--json",
    ]);
    expect(restarted.exitCode).toBe(0);
    expect(JSON.parse(restarted.stdout ?? "")).toMatchObject({
      id: bindingId,
      ownerThreadId: "owner-thread-2",
      status: "ready",
    });
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(2);
  });

  it("reconciles an archived persisted owner after plugin reload", async () => {
    const { host, filePath } = createHost("# Notes\n", {
      threadGet: async () =>
        makeThreadResponse({ id: "owner-thread-1", archivedAt: 1 }),
    });
    await plugin(host.bb);
    const binding = await host.harness.callRpc("bindDocument", {
      path: filePath,
      title: "Notes",
      source,
    });
    const bindingId = stringField(binding, "id");

    const replacement = await host.harness.lifecycle.reload((bb) => plugin(bb));
    hosts.push(replacement);
    const listed = await replacement.harness.callRpc("listBindings", null);
    expect(listed).toMatchObject({
      bindings: [
        expect.objectContaining({
          id: bindingId,
          status: "orphaned",
          lastError: "The owner thread was archived",
        }),
      ],
    });
    await expect(
      replacement.harness.callRpc("queueDictation", {
        bindingId,
        text: "Do not send this to an archived owner.",
      }),
    ).rejects.toThrow(/Start the document agent again/);
  });

  it("preserves a terminal owner event that arrives before binding persistence", async () => {
    let emitFailure: (() => Promise<unknown>) | null = null;
    const { host, filePath } = createHost("# Notes\n", {
      spawn: async () => {
        await emitFailure?.();
        return { id: "owner-thread-raced" };
      },
    });
    await plugin(host.bb);
    emitFailure = () =>
      host.harness.behavior.emitThreadEvent("thread.failed", {
        thread: makeThreadResponse({
          id: "owner-thread-raced",
          originPluginId: "grove",
        }),
        error: "provider stopped before persistence",
      });

    const binding = await host.harness.callRpc("bindDocument", {
      path: filePath,
      title: "Notes",
      source,
    });

    expect(binding).toMatchObject({
      ownerThreadId: "owner-thread-raced",
      status: "error",
      lastError: "provider stopped before persistence",
    });
  });

  it("marks an archived owner as unavailable so it can be restarted", async () => {
    const { host, filePath } = createHost("# Notes\n");
    await plugin(host.bb);
    const binding = await host.harness.callRpc("bindDocument", {
      path: filePath,
      title: "Notes",
      source,
    });
    const bindingId = stringField(binding, "id");

    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "owner-thread-1" }),
    });
    const listed = z
      .object({ bindings: z.array(z.object({ status: z.string() })) })
      .parse(await host.harness.callRpc("listBindings", null));
    expect(listed.bindings[0]?.status).toBe("orphaned");
    await expect(
      host.harness.callRpc("queueDictation", {
        bindingId,
        text: "Do not send this to an archived owner.",
      }),
    ).rejects.toThrow(/Start the document agent again/);
  });

  it("does not hide a thread failure that races a queued dictation", async () => {
    let releaseQueue!: () => void;
    let markQueueStarted!: () => void;
    const queueStarted = new Promise<void>((resolve) => {
      markQueueStarted = resolve;
    });
    const queueGate = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const { host, filePath } = createHost("# Notes\n", {
      queuedCreate: async () => {
        markQueueStarted();
        await queueGate;
        return { id: "queued-message-1" };
      },
    });
    await plugin(host.bb);
    const binding = await host.harness.callRpc("bindDocument", {
      path: filePath,
      title: "Notes",
      source,
    });
    const bindingId = stringField(binding, "id");

    const queued = host.harness.callRpc("queueDictation", {
      bindingId,
      text: "This is a queued passage.",
    });
    await queueStarted;
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "owner-thread-1" }),
      error: "provider stopped",
    });
    releaseQueue();
    await queued;

    const listed = z
      .object({ bindings: z.array(z.object({ status: z.string() })) })
      .parse(await host.harness.callRpc("listBindings", null));
    expect(listed.bindings[0]?.status).toBe("error");
  });

  it("preserves a lifecycle error when queued-message delivery also fails", async () => {
    let releaseQueue!: () => void;
    let markQueueStarted!: () => void;
    const queueStarted = new Promise<void>((resolve) => {
      markQueueStarted = resolve;
    });
    const queueGate = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const { host, filePath } = createHost("# Notes\n", {
      queuedCreate: async () => {
        markQueueStarted();
        await queueGate;
        throw new Error("queue transport failed");
      },
    });
    await plugin(host.bb);
    const binding = await host.harness.callRpc("bindDocument", {
      path: filePath,
      title: "Notes",
      source,
    });
    const bindingId = stringField(binding, "id");

    const queued = host.harness.callRpc("queueDictation", {
      bindingId,
      text: "This delivery will fail.",
    });
    await queueStarted;
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "owner-thread-1" }),
      error: "provider stopped",
    });
    releaseQueue();
    await expect(queued).rejects.toThrow(/queue transport failed/);

    const listed = z
      .object({ bindings: z.array(z.object({ status: z.string(), lastError: z.string().nullable() })) })
      .parse(await host.harness.callRpc("listBindings", null));
    expect(listed.bindings[0]).toMatchObject({
      status: "error",
      lastError: "provider stopped",
    });
  });

  it("opens thread-storage Markdown through the host file API", async () => {
    const { host } = createHost("# Notes\n", {
      spawnIds: ["owner-thread-1", "owner-thread-2"],
    });
    host.harness.sdk.stub(
      "threads.get",
      async () => ({
        ...makeThreadResponse({ id: "thread-1", environmentId: "environment-1" }),
        environment: { hostId: "host-1" },
      }) as never,
    );
    host.harness.sdk.stub(
      "threads.storageFiles",
      async () => ({
        files: [],
        truncated: false,
        storageRootPath: "/thread-storage/thread-1",
      }),
    );
    await plugin(host.bb);

    const opened = await host.harness.callRpc("openDocument", {
      path: "notes.md",
      source: {
        kind: "thread-storage",
        threadId: "thread-1",
        environmentId: "environment-1",
        projectId: "project-1",
        hostId: null,
      },
    });

    const openedDocument = z
      .object({ document: z.object({ path: z.string() }) })
      .parse(opened);
    expect(openedDocument.document.path).toBe("notes.md");
    expect(host.harness.sdk.callsTo("files.read")[0]?.[0]).toMatchObject({
      path: "/thread-storage/thread-1/notes.md",
      rootPath: "/thread-storage/thread-1",
      hostId: "host-1",
    });

    const binding = await host.harness.callRpc("bindDocument", {
      path: "notes.md",
      title: "Notes",
      source: {
        kind: "thread-storage",
        threadId: "thread-1",
        environmentId: "environment-1",
        projectId: "project-1",
        hostId: null,
      },
    });
    const bindingId = stringField(binding, "id");
    expect(binding).toMatchObject({ path: "notes.md" });
    expect(host.harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      environment: { type: "reuse", environmentId: "environment-1" },
    });
    expect(
      await host.harness.callRpc("openBinding", { bindingId }),
    ).toMatchObject({ document: { path: "notes.md" } });

    const secondBinding = await host.harness.callRpc("bindDocument", {
      path: "notes.md",
      title: "Notes from another thread",
      source: {
        kind: "thread-storage",
        threadId: "thread-2",
        environmentId: "environment-1",
        projectId: "project-1",
        hostId: null,
      },
    });
    expect(stringField(secondBinding, "id")).not.toBe(bindingId);
    const listed = z
      .object({ bindings: z.array(z.unknown()) })
      .parse(await host.harness.callRpc("listBindings", null));
    expect(listed.bindings).toHaveLength(2);
  });

  it("reuses a host document thread environment for its owner", async () => {
    const { host, filePath } = createHost("# Notes\n");
    host.harness.sdk.stub(
      "threads.get",
      async () =>
        ({
          ...makeThreadResponse({
            id: "context-thread",
            environmentId: "environment-1",
          }),
          environment: { hostId: "host-1" },
        }) as never,
    );
    await plugin(host.bb);

    await host.harness.callRpc("bindDocument", {
      path: filePath,
      title: "Notes",
      source: {
        ...source,
        threadId: "context-thread",
      },
    });

    expect(host.harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      environment: { type: "reuse", environmentId: "environment-1" },
    });
  });

  it("rejects workspace traversal before touching the file API", async () => {
    const { host } = createHost("unused");
    await plugin(host.bb);

    await expect(
      host.harness.callRpc("openDocument", {
        path: "../outside.md",
        source: {
          kind: "workspace",
          threadId: null,
          environmentId: "environment-1",
          projectId: "project-1",
          hostId: null,
        },
      }),
    ).rejects.toThrow(/parent segments/);
    expect(host.harness.sdk.callsTo("files.read")).toHaveLength(0);
  });
});
