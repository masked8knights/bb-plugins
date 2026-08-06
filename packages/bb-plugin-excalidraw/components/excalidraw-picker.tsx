// Composer picker shown while "Excalidraw drawing" is selected from the
// composer's `+` menu. Rendered by the host in place of the composer
// (pendingInteraction); picking a drawing submits its id to the waiting
// backend call, which then attaches the rendered image to the thread.
// No titles — drawings are identified by their thumbnail.
import type { PluginPendingInteractionProps } from "@bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="text-sm text-muted-foreground">
        Attach a drawing to this conversation as an image.
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {drawings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No drawings yet — create one in the Excalidraw panel.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {drawings.map((drawing) => (
              <Card
                key={drawing.id}
                className="group cursor-pointer overflow-hidden transition-colors hover:bg-accent/40"
              >
                <button
                  className="block w-full"
                  onClick={() => void submit({ drawingId: drawing.id })}
                  aria-label="Attach this drawing"
                  title="Attach this drawing"
                >
                  <DrawingPreview
                    drawingId={drawing.id}
                    updatedAt={drawing.updatedAt}
                    className="aspect-[4/3] w-full"
                  />
                </button>
                <div className="flex items-center justify-between p-1.5">
                  <span className="px-1 text-xs text-muted-foreground">
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
      </div>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => void cancel()}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
