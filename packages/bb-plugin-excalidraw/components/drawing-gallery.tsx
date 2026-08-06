// Drawing gallery: image-first card grid with lazy SVG previews. The title
// is just a small caption — the preview is the identity of each card.
// Optionally bound to a thread (thread right-panel "Excalidraw" action) so
// drawings can be attached to that conversation as rendered images.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useComposer, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { blobToBase64, parseScene, renderSceneToPng } from "../lib/scene";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { DrawingPreview } from "./drawing-preview";

export type DrawingMeta = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  elementCount: number;
};

export function DrawingGallery({
  threadId,
  onOpen,
}: {
  threadId?: string | null;
  onOpen: (id: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const [drawings, setDrawings] = useState<DrawingMeta[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [attachingId, setAttachingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await rpc.call("listDrawings");
    setDrawings(result.drawings);
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createDrawing() {
    if (creating) return;
    setCreating(true);
    try {
      const { drawing } = await rpc.call("createDrawing", {
        name: "Untitled drawing",
      });
      await load();
      onOpen(drawing.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create");
    } finally {
      setCreating(false);
    }
  }

  async function deleteDrawing(id: string) {
    if (!window.confirm("Delete this drawing?")) return;
    try {
      await rpc.call("deleteDrawing", { id });
      await load();
      toast.success("Drawing deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete");
    }
  }

  /** Render the drawing to a PNG and send it to the bound thread. */
  async function attachImage(id: string) {
    if (!threadId) return;
    setAttachingId(id);
    try {
      const { drawing } = await rpc.call("getDrawing", { id });
      if (!drawing) throw new Error("Drawing not found");
      const blob = await renderSceneToPng(parseScene(drawing.data));
      const pngBase64 = await blobToBase64(blob);
      await rpc.call("attachDrawingImage", {
        threadId,
        drawingId: id,
        pngBase64,
        caption: "Attached an Excalidraw drawing:",
      });
      toast.success("Drawing attached to the conversation");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Attach failed");
    } finally {
      setAttachingId(null);
    }
  }

  /** Insert a @drawing mention pill (agent gets the scene data at send). */
  function addToDraft(drawing: DrawingMeta) {
    composer.insertMention({
      provider: "drawing",
      id: drawing.id,
      label: "Drawing",
    });
    composer.focus();
    toast.success("Added to the draft");
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4 md:p-5">
      <Button onClick={() => void createDrawing()} disabled={creating}>
        {creating ? (
          <Icon name="Loading" aria-hidden="true" />
        ) : (
          <Icon name="Plus" aria-hidden="true" />
        )}
        New drawing
      </Button>

      {drawings === null ? (
        <p className="text-sm text-muted-foreground">Loading drawings…</p>
      ) : drawings.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No drawings yet — click “New drawing” to start sketching.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {drawings.map((drawing) => (
            <Card
              key={drawing.id}
              className="group overflow-hidden transition-colors hover:bg-accent/40"
            >
              <button
                className="block w-full"
                onClick={() => onOpen(drawing.id)}
                aria-label="Open drawing"
                title="Open drawing"
              >
                <DrawingPreview
                  drawingId={drawing.id}
                  updatedAt={drawing.updatedAt}
                  className="aspect-[4/3] w-full"
                />
              </button>
              <CardContent className="flex items-center justify-end gap-0.5 p-1.5">
                {threadId ? (
                  <span title="Attach to the conversation" className="inline-flex">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label="Attach to the conversation"
                      disabled={attachingId === drawing.id}
                      onClick={() => void attachImage(drawing.id)}
                    >
                      <Icon
                        name={attachingId === drawing.id ? "Loading" : "Paperclip"}
                        aria-hidden="true"
                      />
                    </Button>
                  </span>
                ) : (
                  <span title="Add to the draft" className="inline-flex">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label="Add to the draft"
                      onClick={() => addToDraft(drawing)}
                    >
                      <Icon name="MessageCirclePlus" aria-hidden="true" />
                    </Button>
                  </span>
                )}
                <span title="Delete drawing" className="inline-flex">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 hover:text-destructive"
                    aria-label="Delete drawing"
                    onClick={() => void deleteDrawing(drawing.id)}
                  >
                    <Icon name="Trash2" aria-hidden="true" />
                  </Button>
                </span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
