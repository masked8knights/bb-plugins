// bb-plugin-ds4 — frontend: a DS4 Admin panel (status, start/stop/restart,
// live logs, agent configs) plus quick actions on the plugin settings page.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
  useSettings,
} from "@bb/plugin-sdk/app";
import type { rpcContract, StatusDto } from "./server";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type LogLine = {
  seq: number;
  ts: number;
  stream: "stdout" | "stderr";
  text: string;
};
type AgentTarget = {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  configured: boolean;
  detail: string;
};
type LogsPayload = { cleared?: boolean; lines: LogLine[] };

const AGENT_IDS = ["pi", "opencode", "codex"] as const;

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}h ${m}m`
    : `${m}m ${String(ss).padStart(2, "0")}s`;
}

function stateColor(state: string): string {
  switch (state) {
    case "ready":
      return "bg-emerald-500/15 text-emerald-500 border-emerald-500/30";
    case "running":
    case "loading model…":
    case "starting":
    case "stopping":
      return "bg-amber-500/15 text-amber-500 border-amber-500/30";
    case "crashed":
      return "bg-red-500/15 text-red-500 border-red-500/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function StateBadge({ state }: { state: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${stateColor(state)}`}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {state}
    </span>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="truncate font-mono text-xs">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------

function StatusCard({
  status,
  busy,
  onAction,
}: {
  status: StatusDto | null;
  busy: string | null;
  onAction: (kind: "start" | "stop" | "restart") => void;
}) {
  const running =
    status?.state === "running" || status?.state === "starting";
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">Server</CardTitle>
        {status && <StateBadge state={status.displayState} />}
      </CardHeader>
      <CardContent className="space-y-3">
        {!status ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Detail label="PID" value={status.pid ? String(status.pid) : "—"} />
              <Detail
                label="Uptime"
                value={status.startedAt ? fmtUptime(status.uptimeMs) : "—"}
              />
              <Detail label="Port" value={String(status.config.port)} />
              <Detail label="Context" value={`${status.config.ctx} tok`} />
              <Detail label="Max out" value={`${status.config.maxTokens} tok`} />
              <Detail label="Backend" value={status.config.backend} />
              <Detail
                label="Endpoint"
                value={`http://${status.config.host}:${status.config.port}/v1`}
              />
            </div>
            <div className="rounded-lg border border-border bg-muted/40 p-2.5">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Model
                </span>
                {status.health?.ok && (
                  <span className="text-[11px] text-emerald-500">
                    /v1/models ok ({status.health.latencyMs} ms)
                  </span>
                )}
              </div>
              <p className="break-all font-mono text-xs">
                {status.config.modelPath ?? "(none configured)"}
              </p>
              {status.health?.ok && status.health.models.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Serving: {status.health.models.join(", ")}
                </p>
              )}
              {status.health && !status.health.ok && (
                <p className="mt-1 text-xs text-amber-500">
                  HTTP not answering yet (
                  {status.health.error ?? `status ${status.health.status ?? "—"}`}) — model
                  still loading?
                </p>
              )}
            </div>
            {status.lastError && (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-xs text-red-500">
                {status.lastError}
              </p>
            )}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={running || busy !== null}
                onClick={() => onAction("start")}
              >
                Start
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!running || busy !== null}
                onClick={() => onAction("stop")}
              >
                Stop
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!running || busy !== null}
                onClick={() => onAction("restart")}
              >
                Restart
              </Button>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {status.settings.autoStart
                  ? "auto-start on"
                  : "auto-start off"}
                {" · "}
                {status.settings.restartOnCrash
                  ? "restart-on-crash on"
                  : "restart-on-crash off"}
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function LogsCard({
  logs,
  follow,
  setFollow,
  onClear,
}: {
  logs: LogLine[];
  follow: boolean;
  setFollow: (v: boolean) => void;
  onClear: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [logs, follow]);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">Process log</CardTitle>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {logs.length} lines
          </span>
          <Button
            size="sm"
            variant={follow ? "default" : "outline"}
            onClick={() => setFollow(!follow)}
          >
            {follow ? "Following" : "Follow"}
          </Button>
          <Button size="sm" variant="outline" onClick={onClear}>
            Clear
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div
          ref={ref}
          className="h-72 overflow-auto rounded-lg border border-border bg-black/60 p-2 font-mono text-[11px] leading-relaxed"
        >
          {logs.length === 0 ? (
            <p className="text-muted-foreground">
              No output yet. Start the server to see logs.
            </p>
          ) : (
            logs.map((l) => (
              <div
                key={l.seq}
                className={l.stream === "stderr" ? "text-amber-400" : "text-slate-200"}
              >
                <span className="mr-2 text-slate-500">{fmtTime(l.ts)}</span>
                {l.text || " "}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function AgentsCard({
  targets,
  sel,
  setSel,
  busy,
  onApply,
}: {
  targets: AgentTarget[];
  sel: Record<string, boolean>;
  setSel: (s: Record<string, boolean>) => void;
  busy: string | null;
  onApply: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">Agent connections</CardTitle>
        <Button size="sm" disabled={busy !== null} onClick={onApply}>
          Apply selected
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Point local coding agents at the running ds4-server. Existing config
          is merged (never overwritten) and backed up before writing.
        </p>
        {targets.map((t) => (
          <label
            key={t.id}
            className="flex items-start gap-2.5 rounded-lg border border-border p-2.5"
          >
            <input
              type="checkbox"
              className="mt-0.5 accent-current"
              checked={Boolean(sel[t.id])}
              onChange={(e) =>
                setSel({ ...sel, [t.id]: e.target.checked })
              }
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{t.label}</span>
                <span
                  className={`rounded-full border px-1.5 py-0.5 text-[10px] ${
                    t.configured
                      ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-500"
                      : "border-border bg-muted text-muted-foreground"
                  }`}
                >
                  {t.configured ? "configured" : "not configured"}
                </span>
              </div>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {t.path}
              </p>
              <p className="text-[11px] text-muted-foreground">{t.detail}</p>
            </div>
          </label>
        ))}
        <p className="text-[11px] text-muted-foreground">
          Pi:{" "}
          <code className="font-mono">bb ds4 agents apply pi</code> · opencode:{" "}
          <code className="font-mono">bb ds4 agents apply opencode</code> ·
          Codex CLI: <code className="font-mono">bb ds4 agents apply codex</code>
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function Dashboard() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<StatusDto | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [follow, setFollow] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [targets, setTargets] = useState<AgentTarget[]>([]);
  const [sel, setSel] = useState<Record<string, boolean>>({
    pi: true,
    opencode: false,
    codex: false,
  });

  useRealtime("state", (payload) => {
    setStatus(payload as StatusDto);
  });
  useRealtime("logs", (payload) => {
    const p = payload as LogsPayload;
    if (p.cleared) {
      setLogs([]);
      return;
    }
    setLogs((prev) => [...prev, ...p.lines].slice(-3000));
  });

  const refresh = useCallback(async () => {
    try {
      const [st, agent] = await Promise.all([
        rpc.call("status"),
        rpc.call("agentConfigs"),
      ]);
      setStatus(st);
      setTargets(agent.targets);
    } catch {
      // transient
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
    rpc.call("logs", { limit: 400 }).then((r) => setLogs(r.lines)).catch(() => {});
    const iv = setInterval(() => void refresh(), 5000);
    return () => clearInterval(iv);
  }, [refresh, rpc]);

  const action = async (kind: "start" | "stop" | "restart") => {
    setBusy(kind);
    try {
      const st = await rpc.call(kind);
      setStatus(st);
      toast.success(
        kind === "start"
          ? "ds4-server starting"
          : kind === "stop"
            ? "ds4-server stopped"
            : "ds4-server restarted",
      );
    } catch (err) {
      toast.error(`Failed to ${kind}: ${String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const applyAgents = async () => {
    const targetsToApply = AGENT_IDS.filter((id) => sel[id]);
    if (!targetsToApply.length) {
      toast.error("Select at least one agent");
      return;
    }
    setBusy("agents");
    try {
      const { results } = await rpc.call("applyAgentConfigs", {
        targets: targetsToApply,
      });
      for (const r of results) {
        if (r.ok) toast.success(r.message);
        else toast.error(r.message);
      }
      const agent = await rpc.call("agentConfigs");
      setTargets(agent.targets);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(null);
    }
  };

  const launchAgent = async () => {
    setBusy("agent");
    try {
      const { terminalId, title } = await rpc.call("launchAgent");
      toast.success(`Opened "${title}" (${terminalId}) in the terminal area`);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4 md:p-5">
      {status?.config.ds4Dir === null && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-500">
          DS4 checkout directory not found. Set it in Settings →
          Extensions → DS4 Admin (<code>ds4Dir</code>), or clone{" "}
          <code className="font-mono">github.com/antirez/ds4</code> to{" "}
          <code className="font-mono">~/workingdir/ds4</code>.
        </div>
      )}
      <StatusCard status={status} busy={busy} onAction={action} />
      <LogsCard
        logs={logs}
        follow={follow}
        setFollow={setFollow}
        onClear={() => {
          rpc.call("clearLogs").catch(() => {});
          setLogs([]);
        }}
      />
      <AgentsCard
        targets={targets}
        sel={sel}
        setSel={setSel}
        busy={busy}
        onApply={() => void applyAgents()}
      />
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base">Interactive ds4-agent</CardTitle>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void launchAgent()}
          >
            Launch in terminal
          </Button>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Runs DS4's native terminal coding agent (TUI) in a BB terminal on
            this host — sessions saved under <code>~/.ds4/kvcache</code> via{" "}
            <code>/save</code>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SettingsActions() {
  const rpc = useRpc<typeof rpcContract>();
  const { values, isLoading } = useSettings();
  const [busy, setBusy] = useState<string | null>(null);

  const applyFromSettings = async () => {
    const targets = AGENT_IDS.filter((id) => Boolean(values?.[`configure${id[0].toUpperCase()}${id.slice(1)}`]));
    if (!targets.length) {
      toast.error("Enable at least one agent toggle in settings first");
      return;
    }
    setBusy("agents");
    try {
      const { results } = await rpc.call("applyAgentConfigs", { targets });
      for (const r of results) {
        if (r.ok) toast.success(r.message);
        else toast.error(r.message);
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(null);
    }
  };

  const launch = async () => {
    setBusy("agent");
    try {
      const { title } = await rpc.call("launchAgent");
      toast.success(`Opened "${title}" in the terminal area`);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy !== null || isLoading}
        onClick={() => void applyFromSettings()}
      >
        Apply agent configs
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={busy !== null}
        onClick={() => void launch()}
      >
        Launch interactive ds4-agent
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "dashboard",
    title: "DS4 Admin",
    icon: "Server",
    path: "dashboard",
    component: Dashboard,
  });
  app.slots.settingsSection({
    id: "actions",
    title: "Actions",
    description: "Write agent provider configs or launch the interactive agent.",
    component: SettingsActions,
  });
});
