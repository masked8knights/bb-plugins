export type ConversationEvent = {
  type: string;
  kind: string;
  role: string | null;
};

export function isConversationEvent(event: ConversationEvent): boolean {
  const type = event.type.toLowerCase();
  if (type.includes("chunk") || type === "text-chunks") return false;
  return event.role === "user" || event.role === "assistant" || event.kind === "tool";
}

export function conversationLabel(event: ConversationEvent): "User" | "Assistant" | "Tool" | "Event" {
  if (event.kind === "tool") return "Tool";
  if (event.role === "user") return "User";
  if (event.role === "assistant") return "Assistant";
  return "Event";
}
