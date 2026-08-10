// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";
import type { DashboardResult, SourceStatusRecord } from "./src/types";

const dashboardFixture: DashboardResult = {
  view: "provider",
  range: "7d",
  generatedAt: 1,
  stale: false,
  totals: {
    sessions: 1,
    active: 0,
    failed: 0,
    turns: 1,
    messages: 1,
    toolCalls: 0,
    toolErrors: 0,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    costUsd: null,
    costEstimated: false,
    contextPeak: null,
    compactions: 0,
    sampleSize: 1,
  },
  providers: [],
  findings: [],
  sessions: [],
  tools: [],
  daily: [],
  models: [],
  coverage: [],
};

const sourceFixture: SourceStatusRecord = {
  id: "codex-local",
  provider: "codex",
  label: "Codex",
  hostId: "local",
  storeKind: "jsonl",
  pathLabel: ".codex/sessions",
  enabled: true,
  detected: true,
  supported: true,
  count: 1,
  capabilities: {
    metadata: "complete",
    turns: "complete",
    tools: "complete",
    tokens: "complete",
    context: "complete",
    errors: "complete",
    latency: "complete",
    models: "complete",
  },
  cursor: null,
  lastSuccessAt: 1,
  lastError: null,
  lastWarning: null,
  remoteDatabaseUnsupported: false,
};

const statusFixture = {
  generatedAt: 1,
  sources: [sourceFixture],
  providers: [],
  defaultView: "provider" as const,
  defaultRange: "7d" as const,
  totalSessions: 1,
  lastIndexedAt: 1,
  error: null,
  indexing: { active: false, phase: "idle", provider: null, done: 1, total: 1 },
};

function hasInputAfter(
  inputs: unknown[],
  start: number,
  expected: Record<string, unknown>,
): boolean {
  return inputs.slice(start).some((input) => {
    try {
      expect(input).toEqual(expected);
      return true;
    } catch {
      return false;
    }
  });
}

describe("Telemetry dashboard RPC flow", () => {
  it("sends strict-JSON inputs while changing filters and refreshing", async () => {
    const dashboardInputs: unknown[] = [];
    const statusInputs: unknown[] = [];
    const reindexInputs: unknown[] = [];

    const app = await loadPluginApp(() => import("./app"));
    expect(app.navPanels.map((panel) => panel.id)).toContain("telemetry");

    const panel = app.navPanels.find((candidate) => candidate.id === "telemetry");
    if (!panel) throw new Error("telemetry nav panel was not registered");

    const slot = renderSlot(
      panel,
      { subPath: "" },
      {
        rpc: {
          dashboard: (input) => {
            dashboardInputs.push(input);
            return dashboardFixture;
          },
          status: (input) => {
            statusInputs.push(input);
            return statusFixture;
          },
          reindex: (input) => {
            reindexInputs.push(input);
            return null;
          },
        },
      },
    );

    await slot.findByText("Harness breakdown");
    expect(dashboardInputs).toContainEqual({ view: "provider", range: "7d" });
    expect(statusInputs.every((input) => input === null)).toBe(true);
    const scrollRoot = slot.container.firstElementChild;
    expect(scrollRoot?.classList.contains("h-full")).toBe(true);
    expect(scrollRoot?.classList.contains("min-h-0")).toBe(true);
    expect(scrollRoot?.classList.contains("overflow-y-auto")).toBe(true);

    const providerSelect = await slot.findByRole("combobox", { name: "Harness" });
    const archivedCheckbox = slot.getByRole("checkbox", { name: "Include archived" });

    let callStart = dashboardInputs.length;
    fireEvent.change(providerSelect, { target: { value: "codex" } });
    await waitFor(() => {
      expect(hasInputAfter(dashboardInputs, callStart, { view: "provider", range: "7d", providers: ["codex"] })).toBe(true);
    });

    callStart = dashboardInputs.length;
    fireEvent.change(providerSelect, { target: { value: "all" } });
    await waitFor(() => {
      expect(hasInputAfter(dashboardInputs, callStart, { view: "provider", range: "7d" })).toBe(true);
    });

    callStart = dashboardInputs.length;
    fireEvent.click(archivedCheckbox);
    await waitFor(() => {
      expect(hasInputAfter(dashboardInputs, callStart, { view: "provider", range: "7d", archived: false })).toBe(true);
    });

    callStart = dashboardInputs.length;
    fireEvent.click(archivedCheckbox);
    await waitFor(() => {
      expect(hasInputAfter(dashboardInputs, callStart, { view: "provider", range: "7d" })).toBe(true);
    });

    callStart = dashboardInputs.length;
    fireEvent.change(providerSelect, { target: { value: "codex" } });
    await waitFor(() => {
      expect(hasInputAfter(dashboardInputs, callStart, { view: "provider", range: "7d", providers: ["codex"] })).toBe(true);
    });

    const refreshButton = slot.getByRole("button", { name: "Refresh" });
    fireEvent.click(refreshButton);
    await waitFor(() => {
      expect(reindexInputs).toContainEqual({ full: false, providers: ["codex"] });
    });

    slot.lifecycle.unmount();
  });

  it("keeps chart and breakdown modes keyboard-addressable", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const panel = app.navPanels.find((candidate) => candidate.id === "telemetry");
    if (!panel) throw new Error("telemetry nav panel was not registered");

    const slot = renderSlot(
      panel,
      { subPath: "" },
      {
        rpc: {
          dashboard: () => dashboardFixture,
          status: () => statusFixture,
        },
      },
    );

    await slot.findByText("Harness breakdown");
    const sessionsMetric = slot.getByRole("button", { name: "Sessions", exact: true });
    expect(sessionsMetric.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(sessionsMetric);
    expect(sessionsMetric.getAttribute("aria-pressed")).toBe("true");

    const dayBreakdown = slot.getByRole("button", { name: "Day", exact: true });
    fireEvent.click(dayBreakdown);
    expect(dayBreakdown.getAttribute("aria-pressed")).toBe("true");

    slot.lifecycle.unmount();
  });
});
