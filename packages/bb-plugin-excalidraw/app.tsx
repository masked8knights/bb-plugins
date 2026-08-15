// bb-plugin-excalidraw — frontend entry.
//
// Surfaces:
//   - navPanel "Excalidraw": full drawing gallery + editor (create/edit).
//   - threadPanelAction "Excalidraw": the same gallery/editor inside a
//     thread's right panel, where "Attach image" attaches the rendered
//     drawing to that conversation.
//   - composer `+` menu → "Excalidraw drawing": pick a drawing (host picker)
//     and upload it as a rendered image attachment for the current conversation.
//   - mention provider (server): `@drawing` works in every composer.
import { useState } from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  type PluginComposerScope,
} from "@bb/plugin-sdk/app";
import { DrawingGallery } from "./components/drawing-gallery";
import { DrawingEditor } from "./components/drawing-editor";
import { ExcalidrawPicker } from "./components/excalidraw-picker";
import { createExcalidrawComposerCustomization } from "./lib/composer-registration";
import { blobToBase64, parseScene, renderSceneToPng } from "./lib/scene";
import { callRpc } from "./lib/rpc";

function DrawingsSurface({ threadId }: { threadId?: string | null }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (openId) {
    return (
      <DrawingEditor
        drawingId={openId}
        threadId={threadId}
        onBack={() => setOpenId(null)}
      />
    );
  }
  return <DrawingGallery threadId={threadId} onOpen={setOpenId} />;
}

/** `+` menu flow: pick a drawing, render it to a PNG, and attach it. */
async function attachFromComposer(scope: PluginComposerScope) {
  if (scope.kind !== "thread") return;
  try {
    const { drawingId } = await callRpc("pickDrawing", {
      threadId: scope.threadId,
    });
    if (!drawingId) return; // cancelled
    const { drawing } = await callRpc("getDrawing", { id: drawingId });
    if (!drawing) throw new Error("Drawing not found");
    const blob = await renderSceneToPng(parseScene(drawing.data));
    const pngBase64 = await blobToBase64(blob);
    await callRpc("attachDrawingImage", {
      threadId: scope.threadId,
      drawingId,
      pngBase64,
    });
    toast.success("Drawing PNG attached");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Attach failed");
  }
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "drawings",
    title: "Excalidraw",
    icon: "PenTool",
    path: "drawings",
    component: () => <DrawingsSurface />,
  });

  app.slots.threadPanelAction({
    id: "excalidraw",
    title: "Excalidraw",
    icon: "PenTool",
    layout: "flush",
    run: async ({ openPanel }) => openPanel({ title: "Excalidraw" }),
    component: ({ threadId }) => <DrawingsSurface threadId={threadId} />,
  });

  app.slots.pendingInteraction({
    id: "excalidraw-picker",
    component: ExcalidrawPicker,
  });

  app.composer.customize(
    createExcalidrawComposerCustomization((scope) => {
      void attachFromComposer(scope);
    }),
  );
});
