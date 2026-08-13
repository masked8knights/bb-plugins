// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";
import { UPSTREAM_LOOK_AND_FEEL_COOKIE, UPSTREAM_LOOK_AND_FEEL_VERSION } from "./embedded";

const app = await loadPluginApp(() => import("../app"));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const payload = {
  kind: "plannotator" as const,
  sessionId: "session-1",
  threadId: "thread-1",
  sessionUrl: "http://127.0.0.1:43210",
  title: "Upstream plan review",
};

describe("Plannotator BB shell", () => {
  it("registers only the upstream panel and pending bridge renderer", () => {
    expect(app.navPanels).toHaveLength(0);
    expect(app.threadPanelActions.map((action) => action.id)).toEqual([
      "plannotator-review",
    ]);
    expect(app.pendingInteractions.map((interaction) => interaction.id)).toEqual([
      "plannotator-upstream-review",
    ]);
  });

  it("renders the real upstream URL in the right-panel iframe", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: payload },
    );

    const iframe = await slot.findByTitle("Plannotator review");
    expect(iframe.getAttribute("src")).toBe(
      `http://${window.location.hostname}:43210`,
    );
    expect(iframe.getAttribute("allow")).toBe("clipboard-read; clipboard-write");
    expect(document.cookie).toContain(
      `${UPSTREAM_LOOK_AND_FEEL_COOKIE}=${UPSTREAM_LOOK_AND_FEEL_VERSION}`,
    );
  });

  it("opens the right panel from the pending interaction and exposes cancellation", async () => {
    let cancelled = false;
    const slot = renderSlot(
      app.pendingInteractions[0]!,
      {
        interaction: {
          id: "interaction-1",
          threadId: "thread-1",
          title: payload.title,
          payload,
          createdAt: 1,
          expiresAt: null,
        },
        submit: async () => undefined,
        cancel: async () => {
          cancelled = true;
        },
      },
    );

    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "openThreadPanel",
        options: {
          actionId: "plannotator-review",
          title: payload.title,
          params: payload,
        },
      });
    });
    fireEvent.click(slot.getByRole("button", { name: "Cancel review" }));
    await waitFor(() => expect(cancelled).toBe(true));
  });

  it("shows and updates the pending review timeout", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const slot = renderSlot(
      app.pendingInteractions[0]!,
      {
        interaction: {
          id: "interaction-timeout",
          threadId: "thread-1",
          title: payload.title,
          payload,
          createdAt: 1,
          expiresAt: 66_000,
        },
        submit: async () => undefined,
        cancel: async () => undefined,
      },
    );

    const timer = slot.getByRole("timer");
    expect(timer.getAttribute("aria-live")).toBe("polite");
    expect(timer.getAttribute("aria-label")).toBe("Review expires in 1m 05s");
    expect(timer.textContent).toContain("1m 05s");
    act(() => vi.advanceTimersByTime(1_000));
    expect(timer.getAttribute("aria-label")).toBe("Review expires in 1m 04s");
    expect(timer.textContent).toContain("1m 04s");
  });

  it("shows an expired review as zero seconds and omits the timer without an expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const renderPending = (expiresAt: number | null) =>
      renderSlot(
        app.pendingInteractions[0]!,
        {
          interaction: {
            id: `interaction-${expiresAt ?? "none"}`,
            threadId: "thread-1",
            title: payload.title,
            payload,
            createdAt: 1,
            expiresAt,
          },
          submit: async () => undefined,
          cancel: async () => undefined,
        },
      );

    const expired = renderPending(9_999);
    const timer = expired.getByRole("timer");
    expect(timer.getAttribute("aria-label")).toBe("Review expires in 0s");
    expect(timer.textContent).toContain("0s");
    expired.lifecycle.unmount();

    const withoutExpiry = renderPending(null);
    expect(withoutExpiry.queryByRole("timer")).toBeNull();
  });
});
