import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  type JsonValue,
  type PluginPendingInteractionProps,
  type PluginThreadPanelProps,
} from "@bb/plugin-sdk/app";
import { PANEL_ACTION_ID, RENDERER_ID } from "./src/constants";
import {
  normalizeEmbeddedSessionUrl,
  upstreamOnboardingCookie,
} from "./src/embedded";
import { formatReviewCountdown, remainingReviewMs } from "./src/countdown";

type PlannotatorPayload = {
  kind: "plannotator";
  sessionId: string;
  threadId: string;
  sessionUrl: string;
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

function PlannotatorPanel({ params }: PluginThreadPanelProps) {
  const payload = parsePayload(params);
  const [reloadKey, setReloadKey] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [embeddedUrl, setEmbeddedUrl] = useState<string | null>(null);

  useEffect(() => {
    setLoaded(false);
  }, [embeddedUrl]);

  // The upstream runtime stores its one-time announcement dismissal in a
  // cookie. Prime that cookie from BB before mounting the iframe, and rewrite
  // loopback URLs to the browser-facing hostname so the cookie belongs to the
  // same host as the child UI. This keeps the real upstream UI while removing
  // standalone-browser onboarding from the embedded workflow.
  useLayoutEffect(() => {
    if (!payload) {
      setEmbeddedUrl(null);
      return;
    }

    document.cookie = upstreamOnboardingCookie();
    setEmbeddedUrl(
      normalizeEmbeddedSessionUrl(payload.sessionUrl, window.location.hostname),
    );
  }, [payload?.sessionUrl]);

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
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {!loaded ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background text-xs text-muted-foreground">
            Loading Plannotator…
          </div>
        ) : null}
        <iframe
          key={reloadKey}
          title="Plannotator review"
          src={embeddedUrl}
          className="h-full w-full border-0"
          referrerPolicy="no-referrer"
          allow="clipboard-read; clipboard-write"
          onLoad={() => setLoaded(true)}
        />
      </div>
    </div>
  );
}

function PendingPlannotatorReview({
  interaction,
  submit: _submit,
  cancel,
}: PluginPendingInteractionProps) {
  const navigate = useBbNavigate();
  const openedSession = useRef<string | null>(null);
  const payload = parsePayload(interaction.payload);
  const [remainingMs, setRemainingMs] = useState(() =>
    remainingReviewMs(interaction.expiresAt),
  );

  useEffect(() => {
    const update = () => {
      setRemainingMs(remainingReviewMs(interaction.expiresAt));
    };
    update();
    if (interaction.expiresAt === null) return;
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [interaction.expiresAt]);

  useEffect(() => {
    if (!payload || openedSession.current === payload.sessionId) return;
    openedSession.current = payload.sessionId;
    navigate.openThreadPanel({
      actionId: PANEL_ACTION_ID,
      title: payload.title,
      params: payload,
    });
  }, [navigate, payload]);

  if (!payload) {
    return (
      <div className="border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
        Plannotator returned an invalid session payload.
        <button
          type="button"
          className="ml-2 underline"
          onClick={() => void cancel()}
        >
          Cancel review
        </button>
      </div>
    );
  }

  return (
    <div className="border border-border bg-surface-recessed p-3 text-sm">
      <div className="font-medium">Plannotator is open in the right panel</div>
      <div className="mt-1 text-xs text-muted-foreground">
        Approve or annotate the plan in the upstream review surface. BB will
        return its decision to the agent when you finish.
      </div>
      {remainingMs !== null ? (
        <div
          className="mt-3 flex items-center justify-between gap-3 rounded border border-border bg-background px-2 py-1.5 text-xs"
          role="timer"
          aria-live="polite"
          aria-label={`Review expires in ${formatReviewCountdown(remainingMs)}`}
        >
          <span className="text-muted-foreground">Review expires in</span>
          <span className="font-medium tabular-nums text-foreground">
            {formatReviewCountdown(remainingMs)}
          </span>
        </div>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="rounded border border-border px-2 py-1 text-xs hover:bg-state-hover"
          onClick={() => {
            navigate.openThreadPanel({
              actionId: PANEL_ACTION_ID,
              title: payload.title,
              params: payload,
            });
          }}
        >
          Focus review
        </button>
        <button
          type="button"
          className="rounded border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
          onClick={() => void cancel()}
        >
          Cancel review
        </button>
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

  app.slots.pendingInteraction({
    id: RENDERER_ID,
    component: PendingPlannotatorReview,
  });
});
