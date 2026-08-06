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
  let parsedAppState: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.data) as {
      elements?: Array<{ isDeleted?: boolean }>;
      appState?: Record<string, unknown>;
      files?: Record<string, unknown>;
    };
    elements = Array.isArray(parsed.elements)
      ? parsed.elements.filter((el) => !el.isDeleted)
      : [];
    files = parsed.files ?? {};
    parsedAppState = parsed.appState ?? {};
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
  // Point the agent at the live-editing entry points (the mention snapshot
  // is a point-in-time copy). Native excalidraw_* tools are the primary path
  // where available; the bb excalidraw CLI works in every session.
  head.push(
    `To edit this drawing live, prefer the excalidraw_update_drawing tool (drawingId "${row.id}") when available — ` +
      `the user's open editor updates automatically. Otherwise use the bb excalidraw CLI: ` +
      `read the latest scene with 'bb excalidraw show ${row.id}', then ` +
      `'bb excalidraw merge ${row.id} <scene-file.json>' (upsert elements from a JSON file) ` +
      `and 'bb excalidraw remove-elements ${row.id} <element-id…>' to delete. Element JSON must match ` +
      `the shape returned by show.`,
  );
  // Full scene data is the most useful thing for the agent (it can reason
  // about and even rewrite the JSON); cap it so huge scenes degrade to the
  // summary above. Tombstones are filtered out of the inlined copy.
  const cleanScene = JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "bb-plugin-excalidraw",
    elements,
    appState: parsedAppState,
    files,
  });
  if (cleanScene.length <= 150_000) {
    head.push(`Scene data (JSON):\n${cleanScene}`);
  } else {
    head.push(
      `Scene data is ${cleanScene.length} bytes — too large to inline. Use the bb excalidraw show <id> command or the excalidraw_get_drawing tool to read it.`,
    );
  }
  return head.join("\n\n");
}
