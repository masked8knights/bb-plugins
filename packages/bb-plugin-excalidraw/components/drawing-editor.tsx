// Full Excalidraw editor: loads a drawing, autosaves (debounced, ordered),
// and offers attach actions — "Attach image" renders the live scene to a
// PNG and sends it to the bound thread as an image attachment; outside a
// thread, "Add to draft" inserts a @drawing mention pill instead.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Excalidraw,
  exportToBlob,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import "../assets/excalidraw/excalidraw.css";
import { useComposer, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  blobToBase64,
  parseScene,
  useIsDark,
} from "../lib/scene";

export function DrawingEditor({
  drawingId,
  threadId,
  onBack,
}: {
  drawingId: string;
  threadId?: string | null;
  onBack?: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const isDark = useIsDark();

  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const loadedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef<string | null>(null);

  // Load the drawing scene once (component is keyed by drawingId).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void rpc
      .call("getDrawing", { id: drawingId })
      .then(({ drawing }) => {
        if (cancelled) return;
        if (!drawing) {
          toast.error("Drawing not found");
          onBack?.();
          return;
        }
        const scene = parseScene(drawing.data);
        setInitialData(
          scene ? (scene as unknown as ExcalidrawInitialDataState) : null,
        );
        loadedRef.current = true;
        setLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        toast.error(error instanceof Error ? error.message : "Failed to load");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawingId]);

  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    setSaving(true);
    const payload = { id: drawingId, data: pending };
    saveChainRef.current = saveChainRef.current
      .then(() => rpc.call("saveDrawing", payload))
      .then(() => {
        setSaving(false);
      })
      .catch((error) => {
        setSaving(false);
        toast.error(
          error instanceof Error ? `Save failed: ${error.message}` : "Save failed",
        );
      });
  }, [drawingId, rpc]);

  const scheduleSave = useCallback(
    (data: string) => {
      pendingRef.current = data;
      setSaving(true);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => flushSave(), 1200);
    },
    [flushSave],
  );

  // Save any pending changes when leaving the editor.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const pending = pendingRef.current;
      if (pending) {
        saveChainRef.current = saveChainRef.current.then(() =>
          rpc
            .call("saveDrawing", { id: drawingId, data: pending })
            .then(() => undefined),
        );
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawingId]);

  const handleChange = useCallback(
    (elements: readonly unknown[], appState: unknown, files: unknown) => {
      if (!loadedRef.current) return;
      try {
        const serialized = serializeAsJSON(
          elements as never,
          appState as never,
          files as never,
          "local",
        );
        scheduleSave(serialized);
      } catch (error) {
        console.error("serialize failed", error);
      }
    },
    [scheduleSave],
  );

  async function renderPng(): Promise<Blob> {
    const api = apiRef.current;
    if (!api) throw new Error("Editor not ready");
    const elements = api
      .getSceneElements()
      .filter((el) => !el.isDeleted);
    const appState = api.getAppState();
    const files = api.getFiles();
    return exportToBlob({
      elements,
      appState,
      files,
      mimeType: "image/png",
      exportBackground: true,
    });
  }

  async function downloadPng() {
    try {
      const blob = await renderPng();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "drawing.png";
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed");
    }
  }

  async function copyImage() {
    try {
      const blob = await renderPng();
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        throw new Error("Clipboard image writing is not supported here");
      }
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      toast.success("Image copied to clipboard");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Copy failed",
      );
    }
  }

  function addToDraft() {
    composer.insertMention({ provider: "drawing", id: drawingId, label: "Drawing" });
    composer.focus();
    toast.success("Added to the draft");
  }

  async function attachAsImage() {
    if (!threadId) return;
    setSending(true);
    try {
      const blob = await renderPng();
      const pngBase64 = await blobToBase64(blob);
      await rpc.call("attachDrawingImage", {
        threadId,
        drawingId,
        pngBase64,
        caption: "Attached an Excalidraw drawing:",
      });
      toast.success("Drawing attached to the conversation");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Attach failed");
    } finally {
      setSending(false);
    }
  }

  async function deleteDrawing() {
    if (!window.confirm("Delete this drawing?")) return;
    try {
      await rpc.call("deleteDrawing", { id: drawingId });
      toast.success("Drawing deleted");
      onBack?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete");
    }
  }

  if (loading) {
    return (
      <div className="flex h-full min-h-[300px] items-center justify-center text-sm text-muted-foreground">
        Loading drawing…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b p-2">
        {onBack && (
          <span title="Back to drawings" className="inline-flex">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Back to drawings"
              onClick={onBack}
            >
              <Icon name="ChevronLeft" aria-hidden="true" />
            </Button>
          </span>
        )}
        <span className="px-1 text-xs text-muted-foreground">
          {saving ? "Saving…" : "Saved"}
        </span>
        <div className="flex-1" />
        {threadId ? (
          <span title="Attach to conversation" className="inline-flex">
            <Button
              size="icon"
              variant="outline"
              aria-label="Attach to conversation"
              disabled={sending}
              onClick={() => void attachAsImage()}
            >
              <Icon
                name={sending ? "Loading" : "Paperclip"}
                aria-hidden="true"
              />
            </Button>
          </span>
        ) : (
          <span title="Add to draft" className="inline-flex">
            <Button
              size="icon"
              variant="outline"
              aria-label="Add to draft"
              onClick={addToDraft}
            >
              <Icon name="MessageCirclePlus" aria-hidden="true" />
            </Button>
          </span>
        )}
        <span title="Copy image to clipboard" className="inline-flex">
          <Button
            size="icon"
            variant="outline"
            aria-label="Copy image to clipboard"
            onClick={() => void copyImage()}
          >
            <Icon name="Copy" aria-hidden="true" />
          </Button>
        </span>
        <span title="Download PNG" className="inline-flex">
          <Button
            size="icon"
            variant="outline"
            aria-label="Download PNG"
            onClick={() => void downloadPng()}
          >
            <Icon name="Download" aria-hidden="true" />
          </Button>
        </span>
        <span title="Delete drawing" className="inline-flex">
          <Button
            size="icon"
            variant="ghost"
            className="hover:text-destructive"
            aria-label="Delete drawing"
            onClick={() => void deleteDrawing()}
          >
            <Icon name="Trash2" aria-hidden="true" />
          </Button>
        </span>
      </div>

      <div className="min-h-0 flex-1">
        <Excalidraw
          key={drawingId}
          initialData={initialData}
          onChange={handleChange}
          excalidrawAPI={(api) => {
            apiRef.current = api;
          }}
          theme={isDark ? "dark" : "light"}
          UIOptions={{
            canvasActions: {
              toggleTheme: true,
              export: false,
              saveToActiveFile: false,
              loadScene: false,
            },
          }}
        />
      </div>
    </div>
  );
}
