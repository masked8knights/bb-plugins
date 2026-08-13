// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";
import { UPSTREAM_LOOK_AND_FEEL_COOKIE, UPSTREAM_LOOK_AND_FEEL_VERSION } from "./embedded";

const app = await loadPluginApp(() => import("../app"));

afterEach(() => cleanup());

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
    expect(slot.queryByRole("timer")).toBeNull();
    expect(slot.getByText(/stays open until you approve/u)).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Cancel review" }));
    await waitFor(() => expect(cancelled).toBe(true));
  });

});
