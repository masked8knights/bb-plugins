// Live drawing sync for the editor: the open editor picks up changes made by
// other writers (an agent's excalidraw_update_drawing tool, the CLI, or
// another open editor tab) so the human and the agent work on the same
// canvas together.
//
// Two channels:
//   - realtime: the server publishes `{ type: "drawing:updated", drawingId,
//     updatedAt }` on the "excalidraw" channel after every successful write.
//   - polling fallback (every 5s, cheap updatedAt check) in case a signal is
//     missed while the tab is backgrounded or the socket reconnects.
//
// Remote scenes are reconciled with the live local scene using Excalidraw's
// own `reconcileElements`, so in-progress local edits (and any local element
// with a newer `version`) win over the remote copy — exactly like Excalidraw
// multiplayer. The reconciled scene is applied with updateScene; the editor
// does NOT autosave it (the server already has it) which avoids save
// ping-pong between writers.
import { useCallback, useEffect, useRef } from "react";
import { reconcileElements } from "@excalidraw/excalidraw";
import { useRealtime } from "@bb/plugin-sdk/app";
import { parseScene } from "./scene";

type SyncRpc = {
  call: (
    method: "getDrawing" | "getDrawingUpdatedAt",
    input: { id: string },
  ) => Promise<{
    drawing?: { updatedAt: number; data: string } | null;
    updatedAt?: number;
  }>;
};

type SyncApi = {
  getSceneElementsIncludingDeleted(): unknown;
  getAppState(): unknown;
  updateScene(opts: { elements: unknown }): void;
};

export function useDrawingSync(
  drawingId: string,
  rpc: SyncRpc,
  getApi: () => SyncApi | null,
  onRemoteApplied?: (updatedAt: number) => void,
  onBeforeApply?: () => void,
) {
  const serverRevRef = useRef(0);
  const busyRef = useRef(false);
  const onRemoteAppliedRef = useRef(onRemoteApplied);
  onRemoteAppliedRef.current = onRemoteApplied;
  const onBeforeApplyRef = useRef(onBeforeApply);
  onBeforeApplyRef.current = onBeforeApply;

  const applyRemote = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const api = getApi();
      if (!api) return;
      const res = await rpc.call("getDrawing", { id: drawingId });
      const drawing = res?.drawing;
      if (!drawing) return;
      if (drawing.updatedAt <= serverRevRef.current) return;
      const scene = parseScene(drawing.data);
      if (!scene) return;
      // Apply only after confirming the scene actually differs from the rev
      // we last saw (protects against applying our own just-saved scene).
      serverRevRef.current = drawing.updatedAt;
      const localElements = api.getSceneElementsIncludingDeleted();
      const remoteElements = scene.elements;
      const appState = api.getAppState();
      const reconciled = reconcileElements(
        localElements as never,
        remoteElements as never,
        appState as never,
      );
      onBeforeApplyRef.current?.();
      api.updateScene({ elements: reconciled as never });
      onRemoteAppliedRef.current?.(drawing.updatedAt);
    } catch {
      // transient failure — the poll / next signal retries
    } finally {
      busyRef.current = false;
    }
  }, [drawingId, rpc, getApi]);

  // Realtime push: the server publishes after every successful write.
  useRealtime("excalidraw", (payload) => {
    const p = payload as { type?: string; drawingId?: string };
    if (p.type === "drawing:updated" && p.drawingId === drawingId) {
      void applyRemote();
    }
  });

  // Polling fallback (cheap updatedAt check; full scene only on change).
  useEffect(() => {
    let cancelled = false;
    const timer = setInterval(async () => {
      if (cancelled || busyRef.current) return;
      try {
        const res = await rpc.call("getDrawingUpdatedAt", { id: drawingId });
        const updatedAt = res?.updatedAt ?? 0;
        if (updatedAt > serverRevRef.current) void applyRemote();
      } catch {
        // ignore — next tick retries
      }
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [drawingId, rpc, applyRemote]);

  return {
    /** Track the server revision after a load or a successful local save. */
    setServerRev(rev: number) {
      serverRevRef.current = rev;
    },
    /** Current known server revision (for status display). */
    getServerRev() {
      return serverRevRef.current;
    },
  };
}
