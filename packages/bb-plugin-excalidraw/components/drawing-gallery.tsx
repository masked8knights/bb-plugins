// Drawing gallery: image-first card grid with lazy SVG previews. The title
// is just a small caption — the preview is the identity of each card.
// Optionally bound to a thread (thread right-panel "Excalidraw" action) so
// drawings can be uploaded for that conversation as rendered images.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useComposer, useRealtime, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { blobToBase64, parseScene, renderSceneToPng } from "../lib/scene";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { PanelContent } from "@/components/ui/panel-content";
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

  // Live refresh: any write to any drawing (agent tool, CLI, another open
  // editor) reloads the gallery so thumbnails/order stay current.
  useRealtime("excalidraw", () => {
    void load();
  });

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

  /** Render the drawing to a PNG and attach it to the bound thread's project. */
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
      });
      toast.success("Drawing PNG attached");
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
    <div className="h-full min-h-0 overflow-y-auto bg-background">
      <PanelContent className="flex flex-col gap-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h1 className="text-sm font-semibold text-foreground">Drawings</h1>
            <p className="text-xs text-muted-foreground">
              Sketch diagrams and attach them to conversations when they are ready.
            </p>
          </div>
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => void createDrawing()}
            disabled={creating}
          >
            {creating ? (
              <Icon name="Loading" aria-hidden="true" />
            ) : (
              <Icon name="Plus" aria-hidden="true" />
            )}
            New drawing
          </Button>
        </header>

        {drawings === null ? (
          <div
            role="status"
            className="flex min-h-24 items-center justify-center gap-2 text-xs text-muted-foreground"
          >
            <Icon name="Loading" aria-hidden="true" className="size-4" />
            Loading drawings…
          </div>
        ) : drawings.length === 0 ? (
          <Card className="border-dashed bg-muted/20">
            <CardContent className="flex items-center gap-3 px-3 py-3">
              <Icon name="File" aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <h2 className="text-xs font-medium text-foreground">No drawings yet</h2>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Start with a blank canvas and sketch your first diagram.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {drawings.map((drawing) => (
              <Card
                key={drawing.id}
                className="group overflow-hidden border-border/90 transition-colors hover:border-foreground/25 hover:bg-accent/30"
              >
                <button
                  className="block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  onClick={() => onOpen(drawing.id)}
                  aria-label={`Open ${drawing.name}`}
                  title={`Open ${drawing.name}`}
                >
                  <DrawingPreview
                    drawingId={drawing.id}
                    updatedAt={drawing.updatedAt}
                    className="aspect-[4/3] w-full bg-muted/40 transition-colors group-hover:bg-muted/60"
                  />
                </button>
                <CardContent className="flex items-center justify-end gap-0.5 border-t border-border/70 p-1.5">
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
                      aria-label={`Delete ${drawing.name}`}
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
      </PanelContent>
    </div>
  );
}
