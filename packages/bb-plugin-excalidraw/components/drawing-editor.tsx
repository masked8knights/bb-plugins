// Full Excalidraw editor: loads a drawing, autosaves (debounced, ordered),
// and offers attach actions — "Attach image" renders the live scene to a
// PNG and uploads it as an image attachment; outside a thread, "Add to draft"
// inserts a @drawing mention pill instead.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Excalidraw,
  exportToBlob,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import "../assets/excalidraw/excalidraw.css";
// Re-maps Excalidraw's palette to bb's live theme tokens; must load after
// the vendored css so the overrides win at equal specificity.
import "../assets/excalidraw-theme.css";
import {
  useComposer,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  blobToBase64,
  parseScene,
  resolveThemeColor,
  sanitizeAppStateForStorage,
  serializeSceneWithTombstones,
  useIsDark,
} from "../lib/scene";
import { useDrawingSync } from "../lib/sync";

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
  const [attaching, setAttaching] = useState(false);

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const loadedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef<string | null>(null);
  // Set while a scene change was caused by applying a remote (agent/other
  // editor) update, so handleChange skips autosaving it back.
  const applyingRemoteRef = useRef(false);
  // Latest server revision (updated_at) — used to ignore our own writes.
  const serverRevSetterRef = useRef<(rev: number) => void>(() => {});
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const realtimeState = useRealtimeConnectionState();

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
        if (scene) {
          // Scenes stored before the appState fix carry the full runtime
          // AppState (JSON'd Maps like `collaborators: {}`), which crashes
          // Excalidraw on load ("collaborators.forEach is not a function").
          // Strip it to the export-safe keys Excalidraw itself persists.
          scene.appState = sanitizeAppStateForStorage(scene.appState);
          // Brand-new drawings (empty scene, stock white canvas) start on
          // the active bb theme's canvas color. Drawings with content keep
          // their saved background so exports stay scene-faithful.
          if (
            scene.elements.length === 0 &&
            (scene.appState.viewBackgroundColor === undefined ||
              scene.appState.viewBackgroundColor === "#ffffff")
          ) {
            scene.appState = {
              ...scene.appState,
              viewBackgroundColor: resolveThemeColor("--canvas", "#ffffff"),
            };
          }
        }
        setInitialData(
          scene ? (scene as unknown as ExcalidrawInitialDataState) : null,
        );
        loadedRef.current = true;
        serverRevSetterRef.current(drawing.updatedAt);
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

  // Live sync with other writers (agent edits via excalidraw_update_drawing,
  // the CLI, or another open editor): apply remote scenes into this editor
  // and notify when one lands. Local in-progress edits win via
  // reconcileElements inside the hook.
  const sync = useDrawingSync(
    drawingId,
    rpc as never,
    () => {
      const api = apiRef.current;
      return api
        ? {
            getSceneElementsIncludingDeleted: () =>
              api.getSceneElementsIncludingDeleted(),
            getAppState: () => api.getAppState(),
            updateScene: (opts: { elements: unknown }) =>
              api.updateScene({ elements: opts.elements as never }),
          }
        : null;
    },
    (updatedAt) => setSyncedAt(updatedAt),
    () => {
      applyingRemoteRef.current = true;
    },
  );
  serverRevSetterRef.current = sync.setServerRev;

  // Briefly show "Synced" after a remote update lands.
  useEffect(() => {
    if (syncedAt === null) return;
    const t = setTimeout(() => setSyncedAt(null), 3000);
    return () => clearTimeout(t);
  }, [syncedAt]);

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
      .then((result) => {
        setSaving(false);
        if (result?.ok && typeof result.updatedAt === "number") {
          serverRevSetterRef.current(result.updatedAt);
        }
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
      if (applyingRemoteRef.current) {
        // Change came from applying a remote (agent) update — the server
        // already has that scene, so don't autosave it back (avoids write
        // ping-pong between writers).
        applyingRemoteRef.current = false;
        return;
      }
      try {
        // Serialize WITH tombstones (deleted elements) so deletions propagate
        // through the server-side merge instead of silently resurrecting.
        const api = apiRef.current;
        const allElements = api
          ? [...api.getSceneElementsIncludingDeleted()]
          : [...elements];
        const serialized = serializeSceneWithTombstones(
          allElements,
          appState,
          files,
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
    setAttaching(true);
    try {
      const blob = await renderPng();
      const pngBase64 = await blobToBase64(blob);
      await rpc.call("attachDrawingImage", {
        threadId,
        drawingId,
        pngBase64,
      });
      toast.success("Drawing PNG attached");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Attach failed");
    } finally {
      setAttaching(false);
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
      <div
        role="status"
        className="flex h-full min-h-[300px] items-center justify-center gap-2 bg-background text-sm text-muted-foreground"
      >
        <Icon name="Loading" aria-hidden="true" className="h-4 w-4" />
        Loading drawing…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-background px-2.5 py-2 md:px-3">
        {onBack && (
          <span title="Back to drawings" className="mr-1 inline-flex">
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              aria-label="Back to drawings"
              onClick={onBack}
            >
              <Icon name="ChevronLeft" aria-hidden="true" />
            </Button>
          </span>
        )}
        <span
          title={
            realtimeState === "connected"
              ? "Live — agent edits appear here automatically"
              : "Reconnecting to live sync…"
          }
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground"
        >
          <span
            className={
              realtimeState === "connected"
                ? "h-1.5 w-1.5 rounded-full bg-emerald-500"
                : "h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500"
            }
            aria-hidden="true"
          />
          {saving ? "Saving…" : syncedAt ? "Synced" : "Saved"}
        </span>
        <div className="ml-auto flex items-center gap-0.5 rounded-md border border-border p-0.5">
          {threadId ? (
            <span title="Attach to conversation" className="inline-flex">
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                aria-label="Attach to conversation"
                disabled={attaching}
                onClick={() => void attachAsImage()}
              >
                <Icon
                  name={attaching ? "Loading" : "Paperclip"}
                  aria-hidden="true"
                />
              </Button>
            </span>
          ) : (
            <span title="Add to draft" className="inline-flex">
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8"
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
              variant="ghost"
              className="h-8 w-8"
              aria-label="Copy image to clipboard"
              onClick={() => void copyImage()}
            >
              <Icon name="Copy" aria-hidden="true" />
            </Button>
          </span>
          <span title="Download PNG" className="inline-flex">
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
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
              className="h-8 w-8 hover:text-destructive"
              aria-label="Delete drawing"
              onClick={() => void deleteDrawing()}
            >
              <Icon name="Trash2" aria-hidden="true" />
            </Button>
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden bg-background">
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
