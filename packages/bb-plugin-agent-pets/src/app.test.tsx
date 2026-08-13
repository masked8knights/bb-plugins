// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("../app"));

afterEach(cleanup);

describe("Agent Pets app", () => {
  it("registers a single navigation panel", () => {
    expect(app.navPanels.map((panel) => panel.id)).toEqual(["agent-pets"]);
    expect(app.navPanels[0]?.path).toBe("pets");
  });

  it("explains first-run creation when no pet exists", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          getState: () => ({ pet: null, events: [] }),
        },
      },
    );

    await slot.findByRole("heading", { name: "Meet your companion" });
    expect(slot.getByText("Create a capybara named Momo.")).toBeTruthy();
  });

  it("renders the pet room and sends a user interaction", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          getState: () => ({
            pet: {
              id: "shared-pet",
              name: "Momo",
              species: "capybara" as const,
              hunger: 18,
              energy: 84,
              happiness: 78,
              mood: "playful" as const,
              createdAt: 1,
              updatedAt: 1,
              lastDecayAt: 1,
            },
            events: [],
          }),
          userInteract: (input) => ({
            state: {
              pet: {
                id: "shared-pet",
                name: "Momo",
                species: "capybara" as const,
                hunger: input.action === "feed" ? 0 : 18,
                energy: 84,
                happiness: 86,
                mood: "playful" as const,
                createdAt: 1,
                updatedAt: 2,
                lastDecayAt: 2,
              },
              events: [],
            },
            event: {
              id: "event-1",
              petId: "shared-pet",
              action: input.action,
              actor: "user" as const,
              threadId: null,
              message: input.action === "talk" ? input.message : null,
              reply: "That sounds nice. Let us take it slowly.",
              createdAt: 2,
            },
          }),
        },
      },
    );

    await slot.findByRole("heading", { name: "Momo" });
    fireEvent.click(slot.getByRole("button", { name: "Feed" }));
    await slot.findAllByText("That sounds nice. Let us take it slowly.");
    expect(slot.rpcCalls).toContainEqual({ method: "userInteract", input: { action: "feed" } });
  });
});
