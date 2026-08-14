import { describe, it } from "vitest";
import { callRpc } from "./rpc";

describe("typed RPC client", () => {
  it("keeps method input types from the RPC contract", () => {
    if (false) {
      // @ts-expect-error attach requires its structured input object
      void callRpc("attach", null);
      void callRpc("attach", {
        threadId: "thread-1",
        templateId: "template-1",
        continuationMode: "automatic",
      });
    }
  });
});
