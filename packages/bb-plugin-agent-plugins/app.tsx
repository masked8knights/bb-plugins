// bb-plugin-agent-plugins — frontend
// Visual thesis: quiet system setting, not a dashboard. One install bar + one list. No nested cards.
import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Snapshot = {
  plugins: {
    id: string;
    name: string;
    version: string | null;
    specVersion: string;
    sourceType: string;
    sourceIntent: string;
    sourceResolved: string | null;
    status: string;
    approval: string;
    lastError: string | null;
  }[];
  skills: { pluginId: string; skillName: string; status: string; lastError: string | null; enabled: boolean }[];
  mcpServers: { pluginId: string; serverId: string; type: string; status: string; lastError: string | null; approved: number; enabled: boolean; configJson: string }[];
  dataDir: string | null;
};

function Dot({ status }: { status: string }) {
  const c =
    status === "active" || status === "ready"
      ? "bg-success"
      : status === "needs-approval" || status === "pending"
        ? "bg-warning"
        : status === "error" || status === "conflicted"
          ? "bg-destructive"
          : "bg-muted-foreground";
  return <span className={`h-1.5 w-1.5 rounded-full ${c}`} aria-hidden="true" />;
}

function Toggle({
  checked,
  disabled,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-primary" : "bg-muted"}`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none block h-4 w-4 rounded-full shadow-sm transition-transform ${checked ? "translate-x-4 bg-primary-foreground" : "translate-x-0.5 bg-muted-foreground"}`}
      />
    </button>
  );
}

function useSnapshot() {
  const rpc = useRpc<typeof rpcContract>();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const s = (await rpc.call("snapshot", null)) as unknown as Snapshot;
      if (requestId !== requestRef.current) return;
      setSnap(s);
      setErr(null);
    } catch (e) {
      if (requestId !== requestRef.current) return;
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [rpc]);
  useEffect(() => { void load(); }, [load]);
  useRealtime("agent-plugins-changed", () => { void load(); });
  return { snap, err, load, rpc };
}

function InstallBar({ onDone }: { onDone: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [value, setValue] = useState("");
  const [state, setState] = useState<"idle" | "installing" | "success" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const timerRef = useRef<number | null>(null);

  const handleBrowse = async () => {
    try {
      setPicking(true);
      const res = await rpc.call("pickFolder", null);
      if (res.path) setValue(res.path);
    } catch (e) {
      setState("error");
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
  };

  const submit = async () => {
    const v = value.trim();
    if (!v) { setState("error"); setMsg("Enter a path, git URL, or npm spec."); return; }
    try {
      setState("installing"); setMsg(null);
      const res = await rpc.call("install", { source: v });
      setState("success");
      setMsg(`Installed ${res.name ?? v} — skills will appear next session.`);
      setValue("");
      onDone();
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => { setState("idle"); setMsg(null); }, 3000) as unknown as number;
    } catch (e) {
      setState("error");
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current); }, []);

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && state !== "installing") void submit(); }}
          placeholder="path:/Users/you/my-plugin  •  https://github.com/acme/my-plugin  •  npm:my-plugin@^1.0"
          className="h-9 flex-1 font-mono text-xs"
          aria-label="Plugin location"
          disabled={state === "installing"}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-9 shrink-0"
          onClick={() => void handleBrowse()}
          disabled={state === "installing" || picking}
          aria-label="Browse for folder"
        >
          {picking ? "…" : "Browse…"}
        </Button>
        <Button
          size="sm"
          className="h-9 min-w-[84px] shrink-0"
          onClick={() => void submit()}
          disabled={state === "installing" || !value.trim()}
        >
          {state === "installing" ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
              Installing
            </span>
          ) : (
            "Install"
          )}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px] leading-none">
        <span className="text-muted-foreground">Local path, Git, or npm — updates keep your data.</span>
        <span className="hidden sm:inline text-muted-foreground">·</span>
        <span className="font-mono text-muted-foreground">/abs/path</span>
        <span className="font-mono text-muted-foreground">npm:…</span>
      </div>

      {state !== "idle" && msg && (
        <div
          className={`rounded-md border px-3 py-2 text-xs leading-snug ${
            state === "success"
              ? "border-success/30 bg-success/10 text-success"
              : state === "error"
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : "border-border bg-muted/40 text-muted-foreground"
          }`}
          role={state === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {msg}
        </div>
      )}
    </div>
  );
}

function PluginRow({
  plugin,
  skills,
  servers,
  onRemove,
  onApprove,
  onSkillEnabledChange,
  onMcpEnabledChange,
  pendingToggle,
}: {
  plugin: Snapshot["plugins"][number];
  skills: Snapshot["skills"];
  servers: Snapshot["mcpServers"];
  onRemove: (id: string) => void;
  onApprove: (p: string, s: string) => void;
  onSkillEnabledChange: (pluginId: string, skillName: string, enabled: boolean) => void;
  onMcpEnabledChange: (pluginId: string, serverId: string, enabled: boolean) => void;
  pendingToggle: string | null;
}) {
  const [open, setOpen] = useState(false);
  const hasIssues = skills.some((s) => s.enabled && (s.status === "error" || s.status === "conflicted")) || servers.some((s) => s.enabled && s.status === "error");
  const issueMessage = skills.find((s) => s.enabled && s.lastError)?.lastError ?? servers.find((s) => s.enabled && s.lastError)?.lastError;
  const enabledSkillCount = skills.filter((s) => s.enabled).length;
  const enabledServerCount = servers.filter((s) => s.enabled).length;

  return (
    <div className="group">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:bg-muted/30"
        aria-expanded={open}
      >
        <Dot status={plugin.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="truncate text-sm font-medium leading-none">{plugin.name}</span>
            {plugin.version && <span className="text-xs text-muted-foreground">v{plugin.version}</span>}
            <span className="text-xs text-muted-foreground">· {plugin.sourceType}</span>
            <span className={`text-xs ${plugin.status === "active" ? "text-muted-foreground" : plugin.status === "needs-approval" ? "text-warning" : "text-destructive"}`}>
              {plugin.status}
            </span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] leading-none text-muted-foreground">{plugin.sourceIntent}</div>
        </div>

        <div className="hidden shrink-0 items-center gap-3 sm:flex">
          <span className="text-xs tabular-nums text-muted-foreground">
            {skills.length} skill{skills.length === 1 ? "" : "s"}
            {servers.length ? ` · ${servers.length} MCP` : ""}
          </span>
          <span className="text-xs text-muted-foreground">{open ? "▴" : "▾"}</span>
        </div>

        <span className="shrink-0 text-xs text-muted-foreground sm:hidden">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="border-t border-border bg-muted/[0.03] px-4 py-3">
          {skills.length > 0 && (
            <section aria-label="Skills">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <h3 className="text-xs font-medium">Skills</h3>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {enabledSkillCount}/{skills.length} enabled
                </span>
              </div>
              <div className="overflow-hidden rounded-md border border-border bg-background">
                <div className="divide-y divide-border">
                  {skills.map((s) => {
                    const toggleKey = `skill:${plugin.id}:${s.skillName}`;
                    const displayStatus = s.enabled ? s.status : "disabled";
                    return (
                      <div key={s.skillName} className="flex items-start gap-3 px-3 py-3">
                        <Dot status={displayStatus} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs">/{s.skillName}</span>
                            <span className="text-[11px] text-muted-foreground">{displayStatus}</span>
                          </div>
                          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                            {s.enabled ? "Available to agents in the next session." : "Disabled; it will not be materialized for agents."}
                          </p>
                          {s.lastError && (
                            <p className="mt-1 text-[11px] leading-snug text-destructive">{s.lastError}</p>
                          )}
                        </div>
                        <Toggle
                          checked={s.enabled}
                          disabled={pendingToggle === toggleKey}
                          label={`${s.enabled ? "Disable" : "Enable"} skill ${s.skillName}`}
                          onCheckedChange={(enabled) => onSkillEnabledChange(plugin.id, s.skillName, enabled)}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          )}

          {hasIssues && (
            <p className="mt-3 text-xs leading-snug text-destructive">{issueMessage}</p>
          )}

          {servers.length > 0 && (
            <section className="mt-4" aria-label="MCP servers">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <h3 className="text-xs font-medium">MCP servers</h3>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {enabledServerCount}/{servers.length} enabled
                </span>
              </div>
              <p className="mb-2 text-[11px] leading-snug text-muted-foreground">
                Servers stay off until enabled and approved. Configuration values are redacted where sensitive.
              </p>
              <div className="overflow-hidden rounded-md border border-border bg-background">
                <div className="divide-y divide-border">
                  {servers.map((srv) => {
                    let cfg: Record<string, unknown> | null = null;
                    try { cfg = JSON.parse(srv.configJson) as Record<string, unknown>; } catch {}
                    const isStdio = srv.type === "stdio";
                    const toggleKey = `mcp:${plugin.id}:${srv.serverId}`;
                    const displayStatus = srv.enabled ? srv.status : "disabled";
                    return (
                      <div key={srv.serverId} className="px-3 py-3">
                        <div className="flex items-start gap-3">
                          <Dot status={displayStatus} />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs font-medium">MCP: <span className="font-mono">{srv.serverId}</span></span>
                              <span className="text-[11px] text-muted-foreground">{displayStatus}</span>
                              <span className={srv.approved ? "text-[11px] text-success" : "text-[11px] text-warning"}>
                                {srv.approved ? "approved" : "needs approval"}
                              </span>
                            </div>
                            <div className="mt-1.5 space-y-1 font-mono text-[11px] leading-snug text-muted-foreground">
                              {isStdio ? (
                                <>
                                  <div>Command: {(cfg?.command as string) ?? "—"}</div>
                                  {cfg?.args !== undefined && <div>Args: {JSON.stringify(cfg.args)}</div>}
                                  {cfg?.cwd !== undefined && <div>Cwd: {String(cfg.cwd)}</div>}
                                  {cfg?.env !== undefined && <div>Env keys: {Object.keys(cfg.env as Record<string, unknown>).join(", ") || "—"} (values redacted)</div>}
                                </>
                              ) : (
                                <>
                                  <div>URL: {(cfg?.url as string) ?? "—"}</div>
                                  {cfg?.headers !== undefined && <div>Headers: {Object.keys(cfg.headers as Record<string, unknown>).join(", ") || "—"} (values redacted)</div>}
                                </>
                              )}
                            </div>
                            {srv.lastError && <p className="mt-1.5 text-[11px] leading-snug text-destructive">{srv.lastError}</p>}
                            {srv.enabled && srv.approved !== 1 && srv.status !== "error" && (
                              <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" onClick={() => onApprove(plugin.id, srv.serverId)}>
                                Approve &amp; start {srv.serverId}
                              </Button>
                            )}
                            {!srv.enabled && srv.approved !== 1 && (
                              <p className="mt-1.5 text-[11px] text-muted-foreground">Enable this server before approving it.</p>
                            )}
                          </div>
                          <Toggle
                            checked={srv.enabled}
                            disabled={pendingToggle === toggleKey}
                            label={`${srv.enabled ? "Disable" : "Enable"} MCP server ${srv.serverId}`}
                            onCheckedChange={(enabled) => onMcpEnabledChange(plugin.id, srv.serverId, enabled)}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          )}

          <div className="mt-3 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={() => onRemove(plugin.id)}
            >
              Remove
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AgentPluginsView() {
  const { snap, err, load } = useSnapshot();
  const rpc = useRpc<typeof rpcContract>();
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [pendingToggle, setPendingToggle] = useState<string | null>(null);

  const runToggle = async (key: string, action: () => Promise<unknown>) => {
    setPendingToggle(key);
    setLocalErr(null);
    try {
      await action();
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingToggle(null);
      await load();
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Remove this plugin? Skills will be removed. Data is kept unless you purge.")) return;
    const purge = window.confirm("Also delete its stored data? OK = delete, Cancel = keep.");
    try {
      await rpc.call("remove", { id, purgeData: purge });
      await load();
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : String(e));
    }
  };

  const approve = async (p: string, s: string) => {
    try {
      await rpc.call("approve", { id: p, serverId: s });
      await load();
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : String(e));
    }
  };

  const setSkillEnabled = (pluginId: string, skillName: string, enabled: boolean) => {
    void runToggle(`skill:${pluginId}:${skillName}`, () =>
      rpc.call("setSkillEnabled", { id: pluginId, skillName, enabled }),
    );
  };

  const setMcpEnabled = (pluginId: string, serverId: string, enabled: boolean) => {
    void runToggle(`mcp:${pluginId}:${serverId}`, () =>
      rpc.call("setMcpEnabled", { id: pluginId, serverId, enabled }),
    );
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="space-y-4 p-4 md:p-6">
        <div className="space-y-1">
          <h1 className="text-base font-semibold tracking-tight">Agent Plugins</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Install once from a path, Git, or npm. Skills become <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">/skill</code> and MCP tools flow to every provider.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <InstallBar onDone={() => void load()} />
          {(err || localErr) && (
            <p className="mt-3 text-xs leading-snug text-destructive" role="alert">
              {localErr ?? err}
            </p>
          )}
        </div>

        <div className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium">Installed</h2>
            <span className="text-xs tabular-nums text-muted-foreground">
              {snap ? `${snap.plugins.length} plugin${snap.plugins.length === 1 ? "" : "s"}` : "…"}
            </span>
          </div>

          {!snap ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : snap.plugins.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-medium">No plugins yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Paste a location above. A folder needs <code className="font-mono text-xs">plugin.json</code> and may include <code className="font-mono text-xs">skills/</code> and/or <code className="font-mono text-xs">mcp.json</code>. Git and npm are validated before they go live.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {snap.plugins.map((p) => (
                <PluginRow
                  key={p.id}
                  plugin={p}
                  skills={snap.skills.filter((s) => s.pluginId === p.id)}
                  servers={snap.mcpServers.filter((s) => s.pluginId === p.id)}
                  onRemove={remove}
                  onApprove={approve}
                  onSkillEnabledChange={setSkillEnabled}
                  onMcpEnabledChange={setMcpEnabled}
                  pendingToggle={pendingToggle}
                />
              ))}
            </div>
          )}
        </div>

        <p className="px-1 text-center text-[11px] leading-relaxed text-muted-foreground">
          Server-host only v0 · Skills appear next session · Updates: reinstall the same location and we swap atomically.
        </p>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "agent-plugins-status",
    title: "Agent Plugins",
    description: "Install once, use everywhere.",
    component: AgentPluginsView,
  });
  app.slots.navPanel({
    id: "agent-plugins",
    title: "Agent Plugins",
    icon: "Puzzle",
    path: "agent-plugins",
    component: AgentPluginsView,
  });
});
