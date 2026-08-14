import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useRpc,
  type JsonValue,
  type PluginThreadPanelProps,
} from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { PANEL_ACTION_ID } from "./src/constants";
import {
  PLANNOTATOR_RELAY_PATH,
  embeddedSessionUrl,
  upstreamOnboardingCookie,
} from "./src/embedded";

type PlannotatorPayload = {
  kind: "plannotator";
  sessionId: string;
  threadId: string;
  sessionUrl: string;
  relayPath: typeof PLANNOTATOR_RELAY_PATH;
  title: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(value: JsonValue | null | undefined): PlannotatorPayload | null {
  if (!isRecord(value)) return null;
  if (
    value.kind !== "plannotator" ||
    typeof value.sessionId !== "string" ||
    typeof value.threadId !== "string" ||
    typeof value.sessionUrl !== "string" ||
    (value.relayPath !== undefined && value.relayPath !== PLANNOTATOR_RELAY_PATH) ||
    typeof value.title !== "string"
  ) {
    return null;
  }
  try {
    const url = new URL(value.sessionUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return {
    kind: "plannotator",
    sessionId: value.sessionId,
    threadId: value.threadId,
    sessionUrl: value.sessionUrl,
    relayPath: PLANNOTATOR_RELAY_PATH,
    title: value.title,
  };
}

function EmptyPanel() {
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-background p-6 text-sm text-muted-foreground">
      Start a plan review from the agent. The upstream Plannotator app will open
      here when the review is ready.
    </div>
  );
}

function PlannotatorPanel({ threadId, params }: PluginThreadPanelProps) {
  const payload = parsePayload(params);
  const rpc = useRpc<typeof rpcContract>();
  const [reloadKey, setReloadKey] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [embeddedUrl, setEmbeddedUrl] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLoaded(false);
    setLoadError(false);
    if (loadTimer.current) clearTimeout(loadTimer.current);
    if (!embeddedUrl) return;
    loadTimer.current = setTimeout(() => setLoadError(true), 15_000);
    return () => {
      if (loadTimer.current) clearTimeout(loadTimer.current);
    };
  }, [embeddedUrl, reloadKey]);

  // The upstream runtime stores its one-time announcement dismissal in a
  // cookie. Prime that cookie from BB before mounting the iframe. HTTPS pages
  // use the same-origin relay; plain HTTP pages rewrite loopback URLs to the
  // browser-facing hostname. This keeps the real upstream UI while removing
  // standalone-browser onboarding from the embedded workflow.
  useLayoutEffect(() => {
    if (!payload) {
      setEmbeddedUrl(null);
      return;
    }

    document.cookie = upstreamOnboardingCookie();
    setEmbeddedUrl(
      embeddedSessionUrl(payload.sessionUrl, payload.sessionId, {
        hostname: window.location.hostname,
        protocol: window.location.protocol,
        origin: window.location.origin,
      }),
    );
  }, [payload?.sessionId, payload?.sessionUrl]);

  if (!payload) return <EmptyPanel />;

  if (!embeddedUrl) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-background text-xs text-muted-foreground">
        Loading Plannotator…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs">
        <div className="min-w-0 truncate text-muted-foreground" title={embeddedUrl}>
          {payload.title}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
            onClick={() => {
              setLoaded(false);
              setReloadKey((value) => value + 1);
            }}
          >
            Reload
          </button>
          <a
            className="rounded border border-border px-2 py-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
            href={embeddedUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open externally
          </a>
          <button
            type="button"
            disabled={canceling}
            className="rounded border border-destructive/40 px-2 py-1 text-destructive hover:bg-destructive/10 disabled:opacity-60"
            onClick={() => {
              if (!payload) return;
              setCanceling(true);
              void rpc
                .call("cancelReview", { threadId, sessionId: payload.sessionId })
                .catch(() => setCanceling(false));
            }}
          >
            {canceling ? "Cancelling…" : "Cancel review"}
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {!loaded && !loadError ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background text-xs text-muted-foreground">
            Loading Plannotator…
          </div>
        ) : null}
        {loadError ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background p-6 text-center text-xs text-muted-foreground">
            <div>Plannotator did not load through the current connection.</div>
            <div>Try Reload or Open externally.</div>
          </div>
        ) : null}
        <iframe
          key={reloadKey}
          title="Plannotator review"
          src={embeddedUrl}
          className="h-full w-full border-0"
          referrerPolicy="no-referrer"
          allow="clipboard-read; clipboard-write"
          onLoad={() => {
            if (loadTimer.current) clearTimeout(loadTimer.current);
            setLoadError(false);
            setLoaded(true);
          }}
          onError={() => {
            if (loadTimer.current) clearTimeout(loadTimer.current);
            setLoaded(false);
            setLoadError(true);
          }}
        />
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Plannotator",
    icon: "ClipboardCheck",
    layout: "flush",
    component: PlannotatorPanel,
  });
});
