// Lazy, cached SVG thumbnail of a stored drawing. Renders only when the
// card scrolls into view; results are cached by (drawingId, updatedAt) so
// revisits and re-renders are free.
import { useEffect, useRef, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import {
  parseScene,
  renderSceneToSvg,
  sceneHasElements,
  svgToDataUrl,
} from "../lib/scene";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";

const previewCache = new Map<string, string>();

export function DrawingPreview({
  drawingId,
  updatedAt,
  className,
}: {
  drawingId: string;
  updatedAt: number;
  className?: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const cacheKey = `${drawingId}:${updatedAt}`;
  const [url, setUrl] = useState<string | null>(() => previewCache.get(cacheKey) ?? null);
  const [empty, setEmpty] = useState(false);
  const [pending, setPending] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (previewCache.has(cacheKey)) {
      setUrl(previewCache.get(cacheKey)!);
      return;
    }
    let cancelled = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (cancelled || startedRef.current) return;
        if (!entries.some((entry) => entry.isIntersecting)) return;
        io.disconnect();
        startedRef.current = true;
        setPending(true);
        void (async () => {
          try {
            const { drawing } = await rpc.call("getDrawing", { id: drawingId });
            if (cancelled || !drawing) return;
            const scene = parseScene(drawing.data);
            if (!sceneHasElements(scene)) {
              setEmpty(true);
              return;
            }
            const svg = await renderSceneToSvg(scene);
            const dataUrl = svgToDataUrl(svg);
            previewCache.set(cacheKey, dataUrl);
            if (!cancelled) setUrl(dataUrl);
          } catch {
            // keep the placeholder
          } finally {
            if (!cancelled) setPending(false);
          }
        })();
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [cacheKey, drawingId, rpc]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative overflow-hidden bg-muted",
        pending && "animate-pulse",
        className,
      )}
    >
      {url ? (
        <img
          src={url}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-contain p-1.5"
        />
      ) : empty ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <Icon
            name="File"
            aria-hidden="true"
            className="h-8 w-8 text-muted-foreground/60"
          />
        </div>
      ) : null}
    </div>
  );
}
