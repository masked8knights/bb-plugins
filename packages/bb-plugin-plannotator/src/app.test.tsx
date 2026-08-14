// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";
import {
  PLANNOTATOR_RELAY_PATH,
  UPSTREAM_LOOK_AND_FEEL_COOKIE,
  UPSTREAM_LOOK_AND_FEEL_VERSION,
} from "./embedded";

const app = await loadPluginApp(() => import("../app"));

afterEach(() => cleanup());

const payload = {
  kind: "plannotator" as const,
  sessionId: "session-1",
  threadId: "thread-1",
  sessionUrl: "http://127.0.0.1:43210",
  relayPath: PLANNOTATOR_RELAY_PATH,
  title: "Upstream plan review",
};

describe("Plannotator BB shell", () => {
  it("registers only the upstream panel", () => {
    expect(app.navPanels).toHaveLength(0);
    expect(app.threadPanelActions.map((action) => action.id)).toEqual([
      "plannotator-review",
    ]);
    expect(app.pendingInteractions).toHaveLength(0);
  });

  it("renders the real upstream URL in the right-panel iframe", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: payload },
    );

    const iframe = await slot.findByTitle("Plannotator review");
    expect(iframe.getAttribute("src")).toBe(
      `http://${window.location.host}${PLANNOTATOR_RELAY_PATH}?sessionId=session-1&path=%2F`,
    );
    expect(iframe.getAttribute("allow")).toBe("clipboard-read; clipboard-write");
    expect(document.cookie).toContain(
      `${UPSTREAM_LOOK_AND_FEEL_COOKIE}=${UPSTREAM_LOOK_AND_FEEL_VERSION}`,
    );
  });

  it("exposes explicit cancellation without a host interaction deadline", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: payload },
      { rpc: { cancelReview: () => ({ cancelled: true }) } },
    );

    await slot.findByRole("button", { name: "Cancel review" });
    expect(slot.queryByRole("timer")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Cancel review" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "cancelReview",
        input: { threadId: "thread-1", sessionId: "session-1" },
      }),
    );
  });

});
