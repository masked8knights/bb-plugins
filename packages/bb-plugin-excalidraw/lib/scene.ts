// Shared Excalidraw scene helpers, dark-mode detection, and scene→PNG
// rendering (pure data in, image out — no editor mount required).
import { useEffect, useState } from "react";
import { exportToBlob, exportToSvg } from "@excalidraw/excalidraw";

export type StoredScene = {
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
};

export function parseScene(data: string): StoredScene | null {
  try {
    const parsed = JSON.parse(data) as StoredScene;
    if (parsed && Array.isArray(parsed.elements)) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Elements that are not deleted (rendering/reading surfaces). */
export function getNonDeletedElements(scene: StoredScene | null): unknown[] {
  return (scene?.elements ?? []).filter(
    (el) => !(el as { isDeleted?: boolean }).isDeleted,
  );
}

/**
 * Serialize the live scene for storage, KEEPING deleted elements
 * (`isDeleted: true`) as tombstones. The stock `serializeAsJSON` drops
 * deleted elements, which would silently resurrect deletions during
 * multi-writer merges. The server filters tombstones for rendering and
 * reading, so the stored format stays Excalidraw-compatible.
 */
/**
 * Keys Excalidraw's own save format keeps in appState (its
 * `cleanAppStateForExport`). Everything else in the runtime AppState is
 * transient — Maps like `collaborators`/`pointers` (which JSON-serialize to
 * `{}` and crash Excalidraw on load with "collaborators.forEach is not a
 * function"), caches, selection, activeTool, … — and must not be stored.
 */
const EXPORT_APP_STATE_KEYS = [
  "viewBackgroundColor",
  "gridModeEnabled",
  "gridSize",
  "gridStep",
] as const;

/** Keep only the export-safe appState keys (unknowns dropped). */
export function sanitizeAppStateForStorage(
  appState: unknown,
): Record<string, unknown> {
  if (!appState || typeof appState !== "object") return {};
  const src = appState as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of EXPORT_APP_STATE_KEYS) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
}

export function serializeSceneWithTombstones(
  elements: unknown[],
  appState: unknown,
  files: unknown,
): string {
  return JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "bb-plugin-excalidraw",
      elements,
      appState: sanitizeAppStateForStorage(appState),
      files: files ?? {},
    },
    null,
    2,
  );
}

/** Render a stored scene to a PNG blob (runs headless of the editor). */
export async function renderSceneToPng(scene: StoredScene | null): Promise<Blob> {
  const elements = (scene?.elements ?? []).filter(
    (el) => !(el as { isDeleted?: boolean }).isDeleted,
  );
  const appState = sanitizeAppStateForStorage(scene?.appState ?? {});
  const files = scene?.files ?? {};
  return exportToBlob({
    elements: elements as never,
    appState: appState as never,
    files: files as never,
    mimeType: "image/png",
    exportBackground: true,
  });
}

/** Render a stored scene to an SVG element (used for gallery thumbnails). */
export async function renderSceneToSvg(
  scene: StoredScene | null,
): Promise<SVGSVGElement> {
  const elements = (scene?.elements ?? []).filter(
    (el) => !(el as { isDeleted?: boolean }).isDeleted,
  );
  return exportToSvg({
    elements: elements as never,
    appState: sanitizeAppStateForStorage(scene?.appState ?? {}) as never,
    files: (scene?.files ?? null) as never,
    exportBackground: true,
    skipInliningFonts: true,
  });
}

export function svgToDataUrl(svg: SVGSVGElement): string {
  const xml = new XMLSerializer().serializeToString(svg);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
}

export function sceneHasElements(scene: StoredScene | null): boolean {
  return (
    (scene?.elements ?? []).some(
      (el) => !(el as { isDeleted?: boolean }).isDeleted,
    ) ?? false
  );
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Resolve a bb theme CSS variable (--canvas, --ink, --primary, ...) to a
 * concrete `#rrggbb` hex. bb's tokens may be hex, oklch(), or color-mix();
 * a probe element + getComputedStyle resolves them to rgb. Used where
 * Excalidraw needs a concrete scene color (e.g. the canvas background of
 * new drawings) instead of a CSS variable reference.
 */
export function resolveThemeColor(
  varName: string,
  fallback = "#ffffff",
): string {
  if (typeof document === "undefined") return fallback;
  const probe = document.createElement("div");
  probe.style.backgroundColor = `var(${varName})`;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).backgroundColor;
  probe.remove();
  // Unresolvable variables compute to transparent black — use the fallback.
  if (!rgb || rgb === "rgba(0, 0, 0, 0)" || rgb === "transparent") {
    return fallback;
  }
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(rgb);
  if (!match) return fallback;
  return `#${[1, 2, 3]
    .map((i) => Number(match[i]).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Reflects the host app's light/dark mode for the Excalidraw theme prop. */
export function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(() => {
    if (typeof document === "undefined") return false;
    return (
      document.documentElement.classList.contains("dark") ||
      (typeof matchMedia === "function" &&
        matchMedia("(prefers-color-scheme: dark)").matches)
    );
  });

  useEffect(() => {
    const el = document.documentElement;
    const update = () =>
      setIsDark(
        el.classList.contains("dark") ||
          (typeof matchMedia === "function" &&
            matchMedia("(prefers-color-scheme: dark)").matches),
      );
    update();
    const observer = new MutationObserver(update);
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}
