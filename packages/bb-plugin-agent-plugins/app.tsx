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
  skills: { pluginId: string; skillName: string; status: string; lastError: string | null }[];
  mcpServers: { pluginId: string; serverId: string; type: string; status: string; lastError: string | null; approved: number }[];
  dataDir: string | null;
};

function Dot({ status }: { status: string }) {
  const c =
    status === "active" || status === "ready"
      ? "bg-emerald-500"
      : status === "needs-approval" || status === "pending"
        ? "bg-amber-500"
        : status === "error" || status === "conflicted"
          ? "bg-red-500"
          : "bg-zinc-400";
  return <span className={`h-1.5 w-1.5 rounded-full ${c}`} aria-hidden="true" />;
}

function useSnapshot() {
  const rpc = useRpc<typeof rpcContract>();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const s = (await rpc.call("snapshot", null)) as unknown as Snapshot;
      setSnap(s);
      setErr(null);
    } catch (e) {
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
  const timerRef = useRef<number | null>(null);

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
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
              : state === "error"
                ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
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
}: {
  plugin: Snapshot["plugins"][number];
  skills: Snapshot["skills"];
  servers: Snapshot["mcpServers"];
  onRemove: (id: string) => void;
  onApprove: (p: string, s: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasIssues = skills.some((s) => s.status === "error" || s.status === "conflicted") || servers.some((s) => s.status === "error");

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
            <span className={`text-xs ${plugin.status === "active" ? "text-muted-foreground" : plugin.status === "needs-approval" ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400"}`}>
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
          <div className="flex flex-wrap gap-1.5">
            {skills.length === 0 ? (
              <span className="text-xs text-muted-foreground">No skills</span>
            ) : (
              skills.map((s) => (
                <span
                  key={s.skillName}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs leading-none ${
                    s.status === "active" ? "border-border bg-background" : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
                  }`}
                  title={s.lastError ?? undefined}
                >
                  <span className="font-mono">/{s.skillName}</span>
                  <span className="text-[11px] opacity-70">{s.status}</span>
                </span>
              ))
            )}
          </div>

          {hasIssues && (
            <p className="mt-2 text-xs leading-snug text-red-600 dark:text-red-400">
              {skills.find((s) => s.lastError)?.lastError ?? servers.find((s) => s.lastError)?.lastError}
            </p>
          )}

          {servers.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {servers.map((srv) => (
                <div key={srv.serverId} className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-xs">{srv.serverId}</span>
                      <span className="text-[11px] text-muted-foreground">· {srv.type}</span>
                      <Dot status={srv.status} />
                      <span className="text-[11px] text-muted-foreground">{srv.status}</span>
                    </div>
                    {srv.lastError && <p className="mt-0.5 text-[11px] leading-snug text-red-600 dark:text-red-400">{srv.lastError}</p>}
                  </div>
                  {srv.approved !== 1 && srv.status !== "error" && (
                    <Button size="sm" variant="outline" className="h-7 shrink-0 text-xs" onClick={() => onApprove(plugin.id, srv.serverId)}>
                      Approve
                    </Button>
                  )}
                  {srv.approved === 1 && <span className="shrink-0 text-[11px] text-emerald-600 dark:text-emerald-400">approved</span>}
                </div>
              ))}
            </div>
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

  const remove = async (id: string) => {
    if (!window.confirm("Remove this plugin? Skills will be removed. Data is kept unless you purge.")) return;
    const purge = window.confirm("Also delete its stored data? OK = delete, Cancel = keep.");
    try {
      await rpc.call("remove", { id, purgeData: purge });
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : String(e));
    }
  };

  const approve = async (p: string, s: string) => {
    try {
      await rpc.call("approve", { id: p, serverId: s });
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : String(e));
    }
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
                Paste a location above. A folder needs <code className="font-mono text-xs">plugin.json</code> and <code className="font-mono text-xs">skills/</code>. Git and npm are validated before they go live.
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
