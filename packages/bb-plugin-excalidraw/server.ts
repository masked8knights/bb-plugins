// bb-plugin-excalidraw — create, edit, and attach Excalidraw drawings.
//
// Backend entry. Drawings live in the plugin's SQLite database as serialized
// Excalidraw scenes (the same JSON shape Excalidraw's "save to file" uses).
// The frontend renders/edits with the real @excalidraw/excalidraw component
// and autosaves through the rpc contract below.
//
// Attaching to conversations is supported two ways:
//   - mention provider `@drawing` — pick a drawing in any composer; at send
//     time the agent receives the drawing's scene as context.
//   - `attachDrawingImage` rpc — the frontend renders the scene to a PNG,
//     the server uploads it as a project prompt attachment and sends it to a
//     thread as a localImage input.
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { mentionContext as buildMentionContext } from "./lib/mention";

const drawingMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  elementCount: z.number(),
});

const drawingFullSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Serialized Excalidraw scene JSON (elements/appState/files). */
  data: z.string(),
});

export const rpcContract = defineRpcContract({
  listDrawings: {
    input: z.null(),
    output: z.object({ drawings: z.array(drawingMetaSchema) }),
  },
  createDrawing: {
    input: z.object({ name: z.string().min(1).max(200) }),
    output: z.object({ drawing: drawingMetaSchema }),
  },
  getDrawing: {
    input: z.object({ id: z.string() }),
    output: z.object({ drawing: drawingFullSchema.nullable() }),
  },
  saveDrawing: {
    input: z.object({
      id: z.string(),
      name: z.string().min(1).max(200).optional(),
      data: z.string(),
    }),
    output: z.object({ ok: z.boolean(), updatedAt: z.number() }),
  },
  deleteDrawing: {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  attachDrawingImage: {
    input: z.object({
      threadId: z.string(),
      drawingId: z.string(),
      /** Base64-encoded PNG, rendered client-side by the editor. */
      pngBase64: z.string(),
      /** Optional caption text sent with the image. */
      caption: z.string().max(500).optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  /**
   * Blocks until the user picks a drawing in the host-rendered picker
   * (pendingInteraction slot "excalidraw-picker"). Returns null on cancel.
   */
  pickDrawing: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ drawingId: z.string().nullable() }),
  },
});

type DrawingRow = {
  id: string;
  name: string;
  data: string;
  created_at: number;
  updated_at: number;
};

function toMeta(row: DrawingRow) {
  let elementCount = 0;
  try {
    const parsed = JSON.parse(row.data) as { elements?: unknown[] };
    elementCount = Array.isArray(parsed.elements) ? parsed.elements.length : 0;
  } catch {
    elementCount = 0;
  }
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    elementCount,
  };
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS drawings (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       data TEXT NOT NULL DEFAULT '{}',
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
  ]);

  const getRow = (id: string): DrawingRow | null =>
    (db.prepare("SELECT * FROM drawings WHERE id = ?").get(id) as
      | DrawingRow
      | undefined) ?? null;

  bb.log.info("loaded");

  bb.rpc.register(rpcContract, {
    listDrawings() {
      const rows = db
        .prepare("SELECT * FROM drawings ORDER BY updated_at DESC")
        .all() as DrawingRow[];
      return { drawings: rows.map(toMeta) };
    },
    createDrawing({ name }) {
      const id = randomUUID();
      const now = Date.now();
      const data = JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: `bb-plugin-excalidraw`,
        elements: [],
        appState: { viewBackgroundColor: "#ffffff" },
        files: {},
      });
      db.prepare(
        "INSERT INTO drawings (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(id, name, data, now, now);
      return { drawing: toMeta(getRow(id)!) };
    },
    getDrawing({ id }) {
      const row = getRow(id);
      if (!row) return { drawing: null };
      return {
        drawing: {
          id: row.id,
          name: row.name,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          data: row.data,
        },
      };
    },
    saveDrawing({ id, name, data }) {
      const row = getRow(id);
      if (!row) throw new Error(`Drawing ${id} not found`);
      const now = Date.now();
      db.prepare(
        "UPDATE drawings SET name = ?, data = ?, updated_at = ? WHERE id = ?",
      ).run(name ?? row.name, data, now, id);
      return { ok: true, updatedAt: now };
    },
    deleteDrawing({ id }) {
      db.prepare("DELETE FROM drawings WHERE id = ?").run(id);
      return { ok: true };
    },
    async attachDrawingImage({ threadId, drawingId, pngBase64, caption }) {
      const row = getRow(drawingId);
      if (!row) throw new Error(`Drawing ${drawingId} not found`);
      const bytes = new Uint8Array(Buffer.from(pngBase64, "base64"));
      if (!bytes.length) throw new Error("Empty image payload");

      const thread = await bb.sdk.threads.get({ threadId });
      const slug = row.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "drawing";

      const attachment = await bb.sdk.projects.attachments.upload({
        projectId: thread.projectId,
        clientFile: bytes,
        filename: `${slug}-${row.id.slice(0, 8)}.png`,
        mimeType: "image/png",
      });

      const text = caption?.trim() || `Here is my Excalidraw drawing “${row.name}”.`;
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [
          { type: "text", text, mentions: [] },
          { type: "localImage", path: attachment.path },
        ],
      });
      return { ok: true };
    },
    async pickDrawing({ threadId }) {
      const rows = db
        .prepare("SELECT * FROM drawings ORDER BY updated_at DESC")
        .all() as DrawingRow[];
      const result = await bb.ui.requestInput({
        threadId,
        rendererId: "excalidraw-picker",
        title: "Attach an Excalidraw drawing",
        payload: { drawings: rows.map(toMeta) },
        timeoutMs: 300_000,
      });
      if (result.outcome === "cancelled") return { drawingId: null };
      const value = result.value as { drawingId?: string };
      return { drawingId: value?.drawingId ?? null };
    },
  });

  // Mention provider: `@drawing` in any composer. Pick a drawing; at send
  // time the agent receives its scene data as context.
  bb.ui.registerMentionProvider({
    id: "drawing",
    label: "Excalidraw",
    search({ query }) {
      const rows = db
        .prepare("SELECT * FROM drawings ORDER BY updated_at DESC LIMIT 50")
        .all() as DrawingRow[];
      const q = query.trim().toLowerCase();
      return rows
        .filter((r) => !q || r.name.toLowerCase().includes(q))
        .map((r) => ({
          id: r.id,
          title: "Excalidraw drawing",
          subtitle: `${toMeta(r).elementCount} elements`,
        }));
    },
    resolve(itemId) {
      const row = getRow(itemId);
      if (!row) throw new Error(`Excalidraw drawing ${itemId} not found`);
      return { context: buildMentionContext(row) };
    },
  });

  // CLI: `bb excalidraw …` — agent-facing management of drawings.
  bb.cli.register({
    name: "excalidraw",
    summary: "Create and manage Excalidraw drawings",
    commands: [
      { name: "list", summary: "List drawings", usage: "bb excalidraw list" },
      {
        name: "create",
        summary: "Create a drawing",
        usage: "bb excalidraw create <name>",
      },
      {
        name: "show",
        summary: "Show a drawing's scene JSON",
        usage: "bb excalidraw show <id>",
      },
      {
        name: "rename",
        summary: "Rename a drawing",
        usage: "bb excalidraw rename <id> <new-name>",
      },
      {
        name: "delete",
        summary: "Delete a drawing",
        usage: "bb excalidraw delete <id>",
      },
    ],
    async run(argv) {
      const [cmd, ...rest] = argv;
      switch (cmd) {
        case "list": {
          const rows = db
            .prepare("SELECT * FROM drawings ORDER BY updated_at DESC")
            .all() as DrawingRow[];
          if (!rows.length) return { exitCode: 0, stdout: "No drawings yet.\n" };
          const lines = rows.map((r) => {
            const meta = toMeta(r);
            return `${meta.id}\t${meta.name}\t${meta.elementCount} elements\t${new Date(meta.updatedAt).toISOString()}`;
          });
          return { exitCode: 0, stdout: lines.join("\n") + "\n" };
        }
        case "create": {
          const name = rest.join(" ");
          if (!name) {
            return {
              exitCode: 1,
              stderr: "usage: bb excalidraw create <name>\n",
            };
          }
          const id = randomUUID();
          const now = Date.now();
          db.prepare(
            "INSERT INTO drawings (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          ).run(
            id,
            name,
            JSON.stringify({
              type: "excalidraw",
              version: 2,
              source: "bb-plugin-excalidraw",
              elements: [],
              appState: { viewBackgroundColor: "#ffffff" },
              files: {},
            }),
            now,
            now,
          );
          return { exitCode: 0, stdout: `${id}\t${name}\n` };
        }
        case "show": {
          const id = rest[0];
          if (!id) {
            return { exitCode: 1, stderr: "usage: bb excalidraw show <id>\n" };
          }
          const row = getRow(id);
          if (!row) {
            return { exitCode: 1, stderr: `Drawing ${id} not found\n` };
          }
          const printed =
            row.data.length > 900_000
              ? row.data.slice(0, 900_000) + "\n…(truncated)\n"
              : row.data + "\n";
          return { exitCode: 0, stdout: printed };
        }
        case "rename": {
          const [id, ...nameParts] = rest;
          const name = nameParts.join(" ");
          if (!id || !name) {
            return {
              exitCode: 1,
              stderr: "usage: bb excalidraw rename <id> <new-name>\n",
            };
          }
          const row = getRow(id);
          if (!row) {
            return { exitCode: 1, stderr: `Drawing ${id} not found\n` };
          }
          db.prepare(
            "UPDATE drawings SET name = ?, updated_at = ? WHERE id = ?",
          ).run(name, Date.now(), id);
          return { exitCode: 0, stdout: `renamed ${id} → ${name}\n` };
        }
        case "delete": {
          const id = rest[0];
          if (!id) {
            return { exitCode: 1, stderr: "usage: bb excalidraw delete <id>\n" };
          }
          db.prepare("DELETE FROM drawings WHERE id = ?").run(id);
          return { exitCode: 0, stdout: `deleted ${id}\n` };
        }
        default:
          return {
            exitCode: 1,
            stderr:
              "unknown command — try: list | create <name> | show <id> | rename <id> <name> | delete <id>\n",
          };
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
