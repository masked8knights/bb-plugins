// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("../app"));

const source = {
  kind: "host" as const,
  threadId: null,
  environmentId: null,
  projectId: "project-1",
  hostId: null,
};

const binding = {
  id: "binding-1",
  path: "/workspace/notes.md",
  title: "Notes",
  source,
  ownerThreadId: "owner-thread-1",
  status: "ready" as const,
  lastSha256: "sha-1",
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
};

afterEach(cleanup);

describe("Grove app", () => {
  it("registers a document nav panel, Markdown opener, and thread action", () => {
    expect(app.navPanels.map((panel) => panel.id)).toEqual(["grove"]);
    expect(app.fileOpeners[0]).toMatchObject({
      id: "grove",
      extensions: ["md", "mdx", "markdown"],
    });
    expect(app.threadPanelActions.map((action) => action.id)).toEqual([
      "document-agent",
    ]);
  });

  it("renders an empty document list without requiring a host app", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: "project-1", threadId: null },
        rpc: { listBindings: () => ({ bindings: [] }) },
      },
    );

    await slot.findByText("Your documents");
    await slot.findByText(/Nothing bound yet/u);
    await slot.findByText(".md, .mdx, and .markdown files are supported.");
    expect(slot.rpcCalls).toEqual([
      { method: "listBindings", input: null },
    ]);
  });

  it("does not show an empty state when the document list fails", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: "project-1", threadId: null },
        rpc: {
          listBindings: () => {
            throw new Error("storage unavailable");
          },
        },
      },
    );

    await slot.findByText("storage unavailable");
    expect(slot.queryByText(/Nothing bound yet/u)).toBeNull();
  });

  it("opens a bound Markdown document and queues typed dictation", async () => {
    const slot = renderSlot(
      app.fileOpeners[0]!,
      {
        path: "/workspace/notes.md",
        source: {
          kind: "host",
          threadId: null,
          environmentId: null,
          projectId: "project-1",
        },
      },
      {
        rpc: {
          openDocument: () => ({
            document: {
              path: "/workspace/notes.md",
              content: "# Notes\n\nStart here.\n",
              sha256: "sha-1",
              sizeBytes: 22,
            },
            binding,
          }),
          queueDictation: () => ({
            queueId: "queue-1",
            threadId: "owner-thread-1",
            status: "queued",
          }),
        },
      },
    );

    const editor = await slot.findByLabelText("Markdown document");
    if (!(editor instanceof HTMLTextAreaElement)) {
      throw new Error("Expected the Grove editor to be a textarea");
    }
    expect(editor.value).toBe("# Notes\n\nStart here.\n");

    fireEvent.change(slot.getByLabelText("Instruction"), {
      target: { value: "Add the next milestone." },
    });
    fireEvent.click(slot.getByRole("button", { name: "Queue to agent" }));

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "queueDictation",
        input: { bindingId: "binding-1", text: "Add the next milestone." },
      }),
    );
    await slot.findByText("Queued for the document agent");

    fireEvent.change(editor, {
      target: { value: "# Notes\n\nA changed draft.\n" },
    });
    await slot.findByText("Unsaved changes");
    expect(slot.queryByText("Queued for the document agent")).toBeNull();
  });

  it("keeps dictation validation beside the instruction field", async () => {
    const slot = renderSlot(
      app.fileOpeners[0]!,
      {
        path: "/workspace/notes.md",
        source: {
          kind: "host",
          threadId: null,
          environmentId: null,
          projectId: "project-1",
        },
      },
      {
        rpc: {
          openDocument: () => ({
            document: {
              path: "/workspace/notes.md",
              content: "# Notes\n",
              sha256: "sha-1",
              sizeBytes: 8,
            },
            binding,
          }),
        },
      },
    );

    const editor = await slot.findByLabelText("Markdown document");
    fireEvent.change(editor, { target: { value: "# Unsaved notes\n" } });
    const instruction = slot.getByLabelText("Instruction");
    fireEvent.change(instruction, {
      target: { value: "Add a milestone." },
    });
    fireEvent.click(slot.getByRole("button", { name: "Queue to agent" }));

    const validation = await slot.findByRole("alert");
    expect(validation.textContent).toContain(
      "Save your direct edits before sending dictation to the agent",
    );
    expect(instruction.getAttribute("aria-invalid")).toBe("true");
    expect(instruction.getAttribute("aria-describedby")).toBe(
      "grove-dictation-error",
    );
    expect(slot.rpcCalls).not.toContainEqual(
      expect.objectContaining({ method: "queueDictation" }),
    );
  });

  it("offers a restart when the owner thread has been deleted", async () => {
    const orphaned = { ...binding, status: "orphaned" as const };
    const revived = {
      ...binding,
      ownerThreadId: "owner-thread-2",
      status: "ready" as const,
    };
    const slot = renderSlot(
      app.fileOpeners[0]!,
      {
        path: "/workspace/notes.md",
        source: {
          kind: "host",
          threadId: null,
          environmentId: null,
          projectId: "project-1",
        },
      },
      {
        rpc: {
          openDocument: () => ({
            document: {
              path: "/workspace/notes.md",
              content: "# Notes\n",
              sha256: "sha-1",
              sizeBytes: 8,
            },
            binding: orphaned,
          }),
          bindDocument: () => revived,
          openBinding: () => ({
            document: {
              path: "/workspace/notes.md",
              content: "# Notes\n",
              sha256: "sha-1",
              sizeBytes: 8,
            },
            binding: revived,
          }),
        },
      },
    );

    await slot.findByRole("button", { name: "Restart document agent" });
    expect(slot.queryByRole("button", { name: "Queue to agent" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Restart document agent" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "bindDocument",
        input: { path: "/workspace/notes.md", source, title: "Notes" },
      }),
    );
    await slot.findByText("Document agent restarted");
  });

  it("offers recovery instead of dictation when the owner thread failed", async () => {
    const failed = { ...binding, status: "error" as const, lastError: "provider stopped" };
    const slot = renderSlot(
      app.fileOpeners[0]!,
      {
        path: "/workspace/notes.md",
        source: {
          kind: "host",
          threadId: null,
          environmentId: null,
          projectId: "project-1",
        },
      },
      {
        rpc: {
          openDocument: () => ({
            document: {
              path: "/workspace/notes.md",
              content: "# Notes\n",
              sha256: "sha-1",
              sizeBytes: 8,
            },
            binding: failed,
          }),
        },
      },
    );

    await slot.findByRole("button", { name: "Restart document agent" });
    await slot.findByText("Agent issue: provider stopped");
    expect(slot.queryByRole("button", { name: "Queue to agent" })).toBeNull();
  });

  it("offers restart directly from an unavailable owner thread", async () => {
    const orphaned = { ...binding, status: "orphaned" as const };
    const revived = {
      ...binding,
      status: "ready" as const,
      ownerThreadId: "owner-thread-2",
    };
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "owner-thread-1", params: null },
      {
        rpc: {
          bindingForThread: () => ({ binding: orphaned }),
          bindDocument: () => revived,
        },
      },
    );

    fireEvent.click(
      await slot.findByRole("button", { name: "Restart document agent" }),
    );
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "bindDocument",
        input: { path: binding.path, source, title: binding.title },
      }),
    );
    await slot.findByText("Agent ready");
  });
});
