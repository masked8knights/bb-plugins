import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { LapdogStatus, rpcContract } from "./server";

const buttonClass =
  "inline-flex min-h-8 items-center justify-center rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const primaryButtonClass =
  "inline-flex min-h-8 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

function stateLabel(state: LapdogStatus["state"]): string {
  if (state === "running") return "Running";
  if (state === "starting") return "Starting";
  if (state === "not-installed") return "Not installed";
  if (state === "error") return "Needs attention";
  return "Stopped";
}

function stateClass(state: LapdogStatus["state"]): string {
  if (state === "running") return "text-success";
  if (state === "starting") return "text-warning";
  if (state === "error" || state === "not-installed") return "text-destructive";
  return "text-muted-foreground";
}

function formatCheckedAt(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function AgentStatus({ status }: { status: LapdogStatus | null }) {
  if (!status) return <span className="text-sm text-muted-foreground">Checking local agent…</span>;
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <span aria-hidden="true" className={`inline-block size-2 rounded-full bg-current ${stateClass(status.state)}`} />
      <span className={stateClass(status.state)}>{stateLabel(status.state)}</span>
      <span className="truncate text-muted-foreground">{status.agentUrl}</span>
    </div>
  );
}

function captureLabel(status: LapdogStatus | null): string {
  if (!status) return "Checking Codex capture…";
  if (status.capture.state === "running") return "Capturing Codex sessions locally";
  if (status.capture.state === "starting") return "Starting Codex capture…";
  if (status.capture.state === "disabled") return "Codex capture disabled";
  if (status.capture.state === "unavailable") return "Codex capture unavailable";
  if (status.capture.state === "error") return "Codex capture needs attention";
  return "Codex capture stopped";
}

function captureClass(status: LapdogStatus | null): string {
  if (!status) return "text-muted-foreground";
  if (status.capture.state === "running") return "text-success";
  if (status.capture.state === "starting") return "text-warning";
  if (status.capture.state === "error" || status.capture.state === "unavailable") return "text-destructive";
  return "text-muted-foreground";
}

function LapdogPanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<LapdogStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | "restart" | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await rpc.call("status", null));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc]);

  useRealtime("lapdog", () => {
    void refresh();
  });

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (action: "start" | "stop" | "restart") => {
    setBusy(action);
    try {
      setStatus(await rpc.call(action, null));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const dashboard = status?.dashboardUrl ?? "https://lapdog.datadoghq.com/";
  const running = status?.state === "running";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-base font-semibold">Lapdog</h1>
            <AgentStatus status={status} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Official Datadog LLM Observability UI backed by your local Lapdog agent.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void refresh()}>
            Refresh
          </button>
          {running ? (
            <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void run("stop")}>
              {busy === "stop" ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <button type="button" className={primaryButtonClass} disabled={busy !== null} onClick={() => void run("start")}>
              {busy === "start" ? "Starting…" : "Start Lapdog"}
            </button>
          )}
          <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void run("restart")}>
            {busy === "restart" ? "Restarting…" : "Restart"}
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-5 py-2 text-xs">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
          <span>{status?.forwardToDatadog ? "Forwarding enabled" : "Local-only capture"}</span>
          <span className={captureClass(status)}>{captureLabel(status)}</span>
          <span>Last check: {status ? formatCheckedAt(status.checkedAt) : "—"}</span>
        </div>
        <a
          className="font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          href={dashboard}
          target="_blank"
          rel="noreferrer"
        >
          Open official dashboard in a new tab
        </a>
      </div>

      {error ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-5 py-2 text-sm text-destructive" role="alert">
          {error}
        </div>
      ) : null}
      {status?.state === "not-installed" ? (
        <div className="border-b border-border px-5 py-2 text-sm text-muted-foreground">
          Install the official CLI with <code className="rounded bg-muted px-1 py-0.5">pipx install ddapm-test-agent</code>, then refresh.
        </div>
      ) : null}
      {status?.state === "error" && status.error ? (
        <div className="border-b border-border px-5 py-2 text-sm text-destructive">{status.error}</div>
      ) : null}
      {status?.capture.error ? (
        <div className="border-b border-border px-5 py-2 text-sm text-destructive">
          {status.capture.error} Hook: <code>{status.capture.hookUrl}</code>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto overscroll-contain bg-background p-2 sm:p-3">
        <iframe
          title="Official Lapdog dashboard"
          src={dashboard}
          className="block h-full min-h-[720px] min-w-[1024px] w-full rounded-md border border-border bg-background"
          referrerPolicy="no-referrer"
        />
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "lapdog",
    title: "Lapdog",
    icon: "Activity",
    path: "lapdog",
    component: LapdogPanel,
  });
});
