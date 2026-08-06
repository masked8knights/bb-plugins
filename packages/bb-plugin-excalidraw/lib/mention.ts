// Pure helper: build the agent-visible context for a drawing mention.
// Kept free of bb imports so it can be unit-tested standalone.

export type DrawingRowLike = {
  id: string;
  name: string;
  data: string;
  created_at: number;
  updated_at: number;
};

export function mentionContext(row: DrawingRowLike): string {
  let elements: unknown[] = [];
  let files: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.data) as {
      elements?: unknown[];
      files?: Record<string, unknown>;
    };
    elements = Array.isArray(parsed.elements) ? parsed.elements : [];
    files = parsed.files ?? {};
  } catch {
    // fall through to a minimal summary
  }
  const textLines: string[] = [];
  for (const el of elements) {
    const e = el as { type?: string; text?: string; label?: { text?: string } };
    if (e.type === "text" && typeof e.text === "string" && e.text.trim()) {
      textLines.push(e.text.trim());
    }
    if (e.type === "frame" && e.label?.text) {
      textLines.push(`[frame: ${e.label.text}]`);
    }
  }
  const head = [
    `Excalidraw drawing (id ${row.id}), updated ${new Date(
      row.updated_at,
    ).toISOString()}.`,
    `${elements.length} element(s)${
      Object.keys(files).length
        ? `, ${Object.keys(files).length} embedded image file(s)`
        : ""
    }.`,
  ];
  if (textLines.length) {
    head.push(`Text content:\n${textLines.map((t) => `- ${t}`).join("\n")}`);
  }
  // Full scene data is the most useful thing for the agent (it can reason
  // about and even rewrite the JSON); cap it so huge scenes degrade to the
  // summary above.
  if (row.data.length <= 150_000) {
    head.push(`Scene data (JSON):\n${row.data}`);
  } else {
    head.push(
      `Scene data is ${row.data.length} bytes — too large to inline. Use the bb excalidraw show <id> command to read it.`,
    );
  }
  return head.join("\n\n");
}
