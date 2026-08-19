// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { TraceEvent, TraceSession, TraceStatus } from "../server";

const app = await loadPluginApp(() => import("../app"));
const panel = app.navPanels[0]!;
const settingsPanel = app.settingsSections[0]!;

const status: TraceStatus = {
  localOnly: true,
  state: "idle",
  sessions: 2,
  events: 4,
  bytes: 4_096,
  lastScanAt: 1_000,
  lastError: null,
  sources: [
    {
      id: "dsh-sessions",
      source: "dsh",
      label: "DeepSeek Harness sessions",
      path: "/tmp/dsh",
      kind: "session",
      format: "zstd",
      exists: true,
      fileCount: 1,
      byteCount: 2_048,
      lastScanAt: 1_000,
      error: null,
    },
    {
      id: "codex-sessions",
      source: "codex",
      label: "Codex sessions",
      path: "/tmp/codex",
      kind: "session",
      format: "jsonl",
      exists: true,
      fileCount: 1,
      byteCount: 2_048,
      lastScanAt: 1_000,
      error: null,
    },
  ],
};

const session: TraceSession = {
  id: "dsh:session/one",
  source: "dsh",
  title: "Inspect trace",
  filePath: "/tmp/dsh/session.jsonl.zstd",
  model: "deepseek-v4-flash",
  cwd: "/tmp/workspace",
  startedAt: 1_000,
  updatedAt: 2_000,
  eventCount: 4,
  userCount: 1,
  assistantCount: 1,
  toolCount: 1,
  errorCount: 0,
  inputTokens: 120,
  outputTokens: 80,
  durationMs: 2_000,
  status: "completed",
  fileSizeBytes: 2_048,
};

const event = (value: Partial<TraceEvent> & Pick<TraceEvent, "id" | "line" | "type" | "kind" | "title" | "summary">): TraceEvent => ({
  sessionId: session.id,
  role: null,
  timestamp: 1_000,
  durationMs: null,
  inputTokens: null,
  outputTokens: null,
  usageIsTotal: false,
  turn: 1,
  step: null,
  depth: 0,
  model: session.model,
  cwd: session.cwd,
  rawJson: JSON.stringify({ type: value.type, text: value.summary }),
  rawTruncated: false,
  ...value,
});

const userEvent = event({ id: "event-user", line: 1, type: "user/message", kind: "message", role: "user", title: "User", summary: "Inspect the local trace" });
const assistantEvent = event({ id: "event-assistant", line: 2, type: "assistant/message", kind: "message", role: "assistant", title: "Assistant", summary: "I found the trace." });
const toolEvent = event({ id: "event-tool", line: 3, type: "tool/call", kind: "tool", title: "bash", summary: "pwd", depth: 1 });
const errorToolEvent = event({ id: "event-error-tool", line: 4, type: "tool/result", kind: "tool", title: "bash", summary: "pwd: permission denied", depth: 1 });

function commonRpc(overrides: Record<string, unknown> = {}) {
  return {
    status: () => status,
    listSessions: () => ({ sessions: [session], total: 1 }),
    getSession: () => ({ session, events: [userEvent, assistantEvent, toolEvent], totalEvents: 3 }),
    getSessionFacets: () => ({
      categories: [
        { value: "user", count: 1 },
        { value: "assistant", count: 1 },
        { value: "tool", count: 1 },
      ],
      toolTypes: [{ value: "bash", count: 1 }],
      errorCount: 0,
      totalEvents: 3,
    }),
    getEventRaw: ({ id }: { id: string }) => ({ raw: `raw:${id}`, truncated: false }),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Traces app interactions", () => {
  it("filters, sorts, loads another session page, and encodes a session deep link", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const slot = renderSlot(panel, { subPath: "" }, {
      rpc: commonRpc({
        listSessions: (input: Record<string, unknown>) => {
          calls.push(input);
          return { sessions: [session], total: input.offset === 0 ? 2 : 2 };
        },
      }) as never,
    });

    await slot.findByRole("button", { name: /Inspect trace/ });
    expect(slot.getByRole("textbox", { name: "Search local sessions" })).toHaveProperty("maxLength", 500);

    fireEvent.change(slot.getByRole("textbox", { name: "Search local sessions" }), { target: { value: "local trace" } });
    await waitFor(() => expect(calls.some((input) => input.query === "local trace")).toBe(true));

    fireEvent.click(slot.getByRole("button", { name: "DeepSeek" }));
    await waitFor(() => expect(calls.some((input) => input.source === "dsh")).toBe(true));

    fireEvent.change(slot.getByRole("combobox", { name: "Sort sessions" }), { target: { value: "events" } });
    await waitFor(() => expect(calls.some((input) => input.sort === "events")).toBe(true));

    fireEvent.click(slot.getByRole("button", { name: /Load more/ }));
    await waitFor(() => expect(calls.some((input) => input.offset === 1)).toBe(true));

    fireEvent.click(slot.getByRole("button", { name: /Inspect trace/ }));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "traces",
      options: { subPath: "session/dsh%3Asession%2Fone" },
    });
  });

  it("sends collection filter state to the server", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const slot = renderSlot(panel, { subPath: "" }, {
      rpc: commonRpc({
        listSessions: (input: Record<string, unknown>) => {
          calls.push(input);
          return { sessions: [session], total: 1 };
        },
      }) as never,
    });

    await slot.findByRole("button", { name: /Inspect trace/ });
    fireEvent.click(slot.getByRole("button", { name: "Filters" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Errors only" }));
    await waitFor(() => expect(calls.some((input) => input.errorFilter === "only")).toBe(true));

    fireEvent.click(slot.getByRole("checkbox", { name: "Active sessions" }));
    await waitFor(() => expect(calls.some((input) => input.status === "active" && input.errorFilter === "only")).toBe(true));

    fireEvent.click(slot.getByRole("checkbox", { name: "Has tool calls" }));
    await waitFor(() => expect(calls.some((input) => input.hasTools === true && input.status === "active")).toBe(true));

    fireEvent.change(slot.getByRole("combobox", { name: "Sort sessions" }), { target: { value: "errors" } });
    await waitFor(() => expect(calls.some((input) => input.sort === "errors")).toBe(true));
  });

  it("renders the trajectory, selects events, switches inspector tabs, and appends event pages", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const collectionCalls: string[] = [];
    const slot = renderSlot(panel, { subPath: "session/dsh%3Asession%2Fone" }, {
      rpc: commonRpc({
        status: () => {
          collectionCalls.push("status");
          return status;
        },
        listSessions: () => {
          collectionCalls.push("listSessions");
          return { sessions: [session], total: 1 };
        },
        getSession: (input: Record<string, unknown>) => {
          calls.push(input);
          return input.offset === 0
            ? { session, events: [userEvent, assistantEvent], totalEvents: 3 }
            : { session, events: [toolEvent], totalEvents: 3 };
        },
      }) as never,
    });

    await slot.findByLabelText("Trajectory event ledger");
    expect(calls[0]).toMatchObject({ id: session.id, limit: 2_000, offset: 0 });
    const roleSeparator = slot.getByRole("separator", { name: "Resize role column" });
    expect(roleSeparator.getAttribute("aria-valuenow")).toBe("156");
    fireEvent.keyDown(roleSeparator, { key: "ArrowRight" });
    expect(roleSeparator.getAttribute("aria-valuenow")).toBe("164");
    fireEvent.keyDown(roleSeparator, { key: "Home" });
    expect(roleSeparator.getAttribute("aria-valuenow")).toBe("128");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(collectionCalls).toEqual([]);
    expect(slot.getAllByRole("button", { name: "Select USER event 1" }).length).toBeGreaterThan(0);
    expect(slot.getByLabelText("Trajectory event ledger").contains(slot.getByRole("button", { name: "Load more events" }))).toBe(true);
    expect(slot.getByText("2 of 3 events loaded · 1 remaining")).toBeTruthy();

    fireEvent.click(slot.getAllByRole("button", { name: "Select USER event 1" })[0]!);
    await slot.findByRole("complementary", { name: "Selected event inspector" });
    fireEvent.click(slot.getByRole("button", { name: "Raw" }));
    await slot.findByText("raw:event-user");

    fireEvent.click(slot.getByRole("button", { name: "Load more events" }));
    await waitFor(() => expect(calls.some((input) => input.offset === 2 && input.limit === 2_000)).toBe(true));
    await slot.findByText(/pwd/);

    const timeline = slot.getByLabelText("Trajectory timeline");
    const timelineTool = timeline.querySelector<HTMLButtonElement>('button[aria-label="Select TOOL event 3"]');
    expect(timelineTool).not.toBeNull();
    fireEvent.mouseEnter(timelineTool!);
    expect(slot.getByRole("tooltip").textContent).toContain("TOOL");
    expect(timeline.querySelector('[data-testid="timeline-hover-guide"]')).toBeTruthy();
    fireEvent.mouseLeave(timeline);
    expect(slot.queryByRole("tooltip")).toBeNull();

    fireEvent.click(slot.getAllByRole("button", { name: "Select TOOL event 3" })[0]!);
    await slot.findByRole("button", { name: "JSON" });
    expect(slot.queryByRole("button", { name: "Summary" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Payload" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Result" })).toBeNull();
    expect(slot.getByRole("complementary", { name: "Selected event inspector" })).toBeTruthy();
  });

  it("sends trajectory category, tool, error, and text filters to the server", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const slot = renderSlot(panel, { subPath: "session/dsh%3Asession%2Fone" }, {
      rpc: commonRpc({
        getSession: (input: Record<string, unknown>) => {
          calls.push(input);
          let filteredEvents = [userEvent, assistantEvent, toolEvent, errorToolEvent];
          if (input.errorFilter === "only") filteredEvents = [errorToolEvent];
          if (Array.isArray(input.categories) && input.categories.includes("tool")) filteredEvents = filteredEvents.filter((item) => item.kind === "tool");
          if (Array.isArray(input.toolTypes) && input.toolTypes.includes("bash")) filteredEvents = filteredEvents.filter((item) => item.title === "bash");
          if (input.query === "pwd") filteredEvents = filteredEvents.filter((item) => item.summary.includes("pwd"));
          return { session, events: filteredEvents, totalEvents: filteredEvents.length };
        },
      }) as never,
    });

    await slot.findByLabelText("Trajectory event ledger");
    fireEvent.click(slot.getByRole("button", { name: "Event filters" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Errors only" }));
    await waitFor(() => expect(calls.some((input) => input.errorFilter === "only")).toBe(true));
    expect(slot.queryByRole("button", { name: "Select USER event 1" })).toBeNull();
    expect(slot.getAllByRole("button", { name: "Select TOOL event 4" }).length).toBeGreaterThan(0);

    fireEvent.click(slot.getByRole("checkbox", { name: "Tools" }));
    await waitFor(() => expect(calls.some((input) => Array.isArray(input.categories) && input.categories.includes("tool"))).toBe(true));

    fireEvent.click(slot.getByRole("checkbox", { name: "bash" }));
    await waitFor(() => expect(calls.some((input) => Array.isArray(input.toolTypes) && input.toolTypes.includes("bash"))).toBe(true));

    fireEvent.change(slot.getByRole("textbox", { name: "Search trajectory" }), { target: { value: "pwd" } });
    await waitFor(() => expect(calls.some((input) => input.query === "pwd")).toBe(true));
  });

  it("renders structured JSON fields in the event inspector", async () => {
    const systemEvent = event({ id: "event-system", line: 0, type: "session_meta", kind: "system", title: "Session Meta", summary: "Session Meta" });
    const slot = renderSlot(panel, { subPath: "session/dsh%3Asession%2Fone" }, {
      rpc: commonRpc({
        getSession: () => ({ session, events: [systemEvent], totalEvents: 1 }),
        getEventRaw: () => ({
          raw: JSON.stringify({
            timestamp: "2026-08-18T12:00:00.000Z",
            type: "session_meta",
            payload: { base_instructions: { text: "You are an agent with a readable system prompt." }, context_window: 258400 },
          }),
          truncated: false,
        }),
      }) as never,
    });

    await slot.findByLabelText("Trajectory event ledger");
    fireEvent.click(slot.getByRole("button", { name: "Select SYSTEM event 0" }));
    expect(slot.getByRole("button", { name: "JSON" })).toBeTruthy();
    const prettyPayload = await slot.findByLabelText("Pretty-printed JSON");
    expect(prettyPayload.textContent).toContain('"base_instructions"');
    expect(prettyPayload.textContent).toContain('"text": "You are an agent with a readable system prompt."');
    expect(prettyPayload.textContent).toContain('"context_window": 258400');
    expect(prettyPayload.querySelector("dl")).toBeNull();
  });

  it("accepts decoded session IDs that contain path separators", async () => {
    const slot = renderSlot(panel, { subPath: "session/dsh:session/one" }, { rpc: commonRpc() as never });
    await slot.findByLabelText("Trajectory event ledger");
    expect(slot.getByText("Inspect the local trace")).toBeTruthy();
  });

  it("accepts a session ID that the host encoded twice during navigation", async () => {
    const doubleEncoded = encodeURIComponent(encodeURIComponent(session.id));
    const slot = renderSlot(panel, { subPath: `session/${doubleEncoded}` }, { rpc: commonRpc() as never });
    await slot.findByLabelText("Trajectory event ledger");
    expect(slot.getByText("Inspect the local trace")).toBeTruthy();
  });

  it("accepts a panel subpath encoded as one URL segment", async () => {
    const encodedSubPath = encodeURIComponent(`session/${session.id}`);
    const slot = renderSlot(panel, { subPath: encodedSubPath }, { rpc: commonRpc() as never });
    await slot.findByLabelText("Trajectory event ledger");
    expect(slot.getByText("Inspect the local trace")).toBeTruthy();
  });

  it("shows a useful missing-session state and keeps the collection focused on sessions", async () => {
    const missing = renderSlot(panel, { subPath: "session/missing" }, {
      rpc: commonRpc({ getSession: () => ({ session: null, events: [], totalEvents: 0 }) }) as never,
    });
    await missing.findByText("Session not found");
    expect(missing.getByRole("button", { name: /Back to sessions/ })).toBeTruthy();
    missing.unmount();

    const collection = renderSlot(panel, { subPath: "" }, { rpc: commonRpc() as never });
    await collection.findByRole("button", { name: /Inspect trace/ });
  });

  it("turns a hung trajectory request into a retryable error", async () => {
    vi.useFakeTimers();
    try {
      const slot = renderSlot(panel, { subPath: "session/dsh%3Asession%2Fone" }, {
        rpc: commonRpc({ getSession: () => new Promise(() => undefined) }) as never,
      });
      await act(async () => {
        vi.advanceTimersByTime(15_000);
      });
      expect(slot.getByText("Unable to load trace")).toBeTruthy();
      expect(slot.getByRole("button", { name: "Retry" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Traces settings", () => {
  it("lists detected roots and persists add/remove custom directory edits", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const settingsStatus: TraceStatus = {
      ...status,
      sources: [
        ...status.sources,
        {
          id: "custom-session-root",
          source: "custom",
          label: "Custom session root",
          path: "/tmp/custom",
          configuredPath: "/tmp/custom",
          kind: "session",
          format: "jsonl",
          exists: true,
          fileCount: 3,
          byteCount: 1_024,
          lastScanAt: 1_000,
          error: null,
        },
      ],
    };
    const slot = renderSlot(settingsPanel, {}, {
      settings: { additionalSessionRoots: "/tmp/custom" },
      rpc: { status: () => settingsStatus } as never,
    });

    await slot.findByText("/tmp/custom");
    expect(slot.getByText("/tmp/dsh")).toBeTruthy();
    expect(slot.getAllByRole("button", { name: "Remove" })).toHaveLength(1);

    fireEvent.change(slot.getByRole("textbox", { name: "New session directory" }), {
      target: { value: "/tmp/another" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Add directory" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/plugins/traces/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ values: { additionalSessionRoots: "/tmp/custom\n/tmp/another" } }),
      }),
    ));

    fireEvent.click(slot.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/plugins/traces/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ values: { additionalSessionRoots: "/tmp/another" } }),
      }),
    ));
  });

  it("keeps a new directory in the form when saving fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: "settings unavailable" }),
    }));
    const slot = renderSlot(settingsPanel, {}, {
      settings: { additionalSessionRoots: "" },
      rpc: { status: () => status } as never,
    });

    const input = await slot.findByRole("textbox", { name: "New session directory" });
    fireEvent.change(input, { target: { value: "/tmp/keep-this" } });
    fireEvent.click(slot.getByRole("button", { name: "Add directory" }));

    await slot.findByRole("alert");
    expect(input).toHaveProperty("value", "/tmp/keep-this");
    expect(slot.getByText("settings unavailable")).toBeTruthy();
  });
});
