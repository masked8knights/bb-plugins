// Composer picker shown while "Excalidraw drawing" is selected from the
// composer's `+` menu. Rendered by the host in place of the composer
// (pendingInteraction); picking a drawing submits its id to the waiting
// backend call, which then uploads the rendered image for the thread.
// No titles — drawings are identified by their thumbnail.
import type { PluginPendingInteractionProps } from "@bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PanelContent } from "@/components/ui/panel-content";
import { DrawingPreview } from "./drawing-preview";

type PickerDrawing = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  elementCount: number;
};

export function ExcalidrawPicker({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const payload = interaction.payload as
    | { drawings?: PickerDrawing[] }
    | null;
  const drawings = payload?.drawings ?? [];

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PanelContent className="flex flex-col gap-4">
          <header>
            <h1 className="text-sm font-semibold text-foreground">Attach a drawing</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Choose a drawing to attach as a PNG.
            </p>
          </header>
          {drawings.length === 0 ? (
            <Card className="border-dashed bg-muted/20">
              <CardContent className="flex items-center gap-3 px-3 py-3 text-xs text-muted-foreground">
                No drawings yet — create one in the Excalidraw panel.
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {drawings.map((drawing) => (
                <Card
                  key={drawing.id}
                  className="group overflow-hidden border-border/90 transition-colors hover:border-foreground/25 hover:bg-accent/30"
                >
                  <button
                    className="block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    onClick={() => void submit({ drawingId: drawing.id })}
                    aria-label={`Attach ${drawing.name}`}
                    title={`Attach ${drawing.name}`}
                  >
                    <DrawingPreview
                      drawingId={drawing.id}
                      updatedAt={drawing.updatedAt}
                      className="aspect-[4/3] w-full bg-muted/40 transition-colors group-hover:bg-muted/60"
                    />
                  </button>
                  <div className="flex items-center justify-between border-t border-border/70 p-1.5">
                    <span className="px-1 text-[11px] text-muted-foreground">
                      {drawing.elementCount} element
                      {drawing.elementCount === 1 ? "" : "s"}
                    </span>
                    <Button
                      size="sm"
                      onClick={() => void submit({ drawingId: drawing.id })}
                    >
                      Attach
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </PanelContent>
      </div>
      <div className="flex shrink-0 justify-end border-t border-border px-5 py-2.5 md:px-6">
        <Button variant="ghost" size="sm" onClick={() => void cancel()}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
