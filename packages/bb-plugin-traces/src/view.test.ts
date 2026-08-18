import { describe, expect, it } from "vitest";
import { conversationLabel, isConversationEvent } from "./view";

describe("conversation event view", () => {
  it("keeps complete user, assistant, and tool events", () => {
    expect(isConversationEvent({ type: "user/message", kind: "message", role: "user" })).toBe(true);
    expect(isConversationEvent({ type: "assistant/message", kind: "message", role: "assistant" })).toBe(true);
    expect(isConversationEvent({ type: "tool/call", kind: "tool", role: "tool" })).toBe(true);
  });

  it("hides streaming chunks from the conversation view", () => {
    expect(isConversationEvent({ type: "assistant/chunk", kind: "message", role: "assistant" })).toBe(false);
    expect(isConversationEvent({ type: "tool-call-chunks", kind: "tool", role: "tool" })).toBe(false);
    expect(conversationLabel({ type: "tool/result", kind: "tool", role: "user" })).toBe("Tool");
  });
});
