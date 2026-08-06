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

/** Render a stored scene to a PNG blob (runs headless of the editor). */
export async function renderSceneToPng(scene: StoredScene | null): Promise<Blob> {
  const elements = (scene?.elements ?? []).filter(
    (el) => !(el as { isDeleted?: boolean }).isDeleted,
  );
  const appState = scene?.appState ?? {};
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
    appState: (scene?.appState ?? {}) as never,
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
