import { describe, expect, it } from "vitest";
import { createExcalidrawComposerCustomization } from "./composer-registration";

describe("Excalidraw composer registration", () => {
  it("is discoverable but disabled until a thread exists", () => {
    const customization = createExcalidrawComposerCustomization(() => undefined);
    expect(customization.scopes).toEqual(["thread", "new-thread"]);

    const item = customization.plusMenu?.[0];
    expect(item?.label).toBe("Excalidraw drawing");
    expect(typeof item?.disabled).toBe("function");
    if (typeof item?.disabled !== "function") return;

    const baseView = {
      layout: "expanded" as const,
      draft: { text: "", isEmpty: true, attachmentCount: 0 },
      run: { isRunning: false, isSubmitting: false },
    };
    expect(item.disabled({ ...baseView, scope: { kind: "new-thread", projectId: null } })).toBe(true);
    expect(item.disabled({ ...baseView, scope: { kind: "thread", threadId: "thread-1" } })).toBe(false);
  });
});
