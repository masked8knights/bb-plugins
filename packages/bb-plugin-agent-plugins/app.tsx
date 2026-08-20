// bb-plugin-agent-plugins — frontend entry
// Design thesis: calm operational manager for a repeated workflow (install once, use everywhere).
// One dominant job per region: install at top, installed list below, no nested cards.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Snapshot = {
  plugins: {
    id: string;
    name: string;
    version: string | null;
    description: string | null;
    specVersion: string;
    sourceType: string;
    sourceIntent: string;
    sourceResolved: string | null;
    status: string;
    approval: string;
    lastError: string | null;
  }[];
  skills: {
    pluginId: string;
    skillName: string;
    status: string;
    lastError: string | null;
    materializedPath: string | null;
  }[];
  mcpServers: {
    pluginId: string;
    serverId: string;
    type: string;
    status: string;
    lastError: string | null;
    approved: number;
    configJson: string;
  }[];
  dataDir: string | null;
};

function StatusDot({ status }: { status: string }) {
  const color =
    status === "active" || status === "ready"
      ? "bg-emerald-500"
      : status === "needs-approval" || status === "pending"
        ? "bg-amber-500"
        : status === "error" || status === "conflicted"
          ? "bg-destructive"
          : "bg-muted-foreground";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} aria-hidden="true" />;
}

function InstallForm({ onDone, rpc }: { onDone: () => void; rpc: ReturnType<typeof useRpc<typeof rpcContract>> }) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const s = source.trim();
    if (!s) { setErr("Enter a location."); return; }
    try {
      setBusy(true); setErr(null);
      await rpc.call("install", { source: s });
      setSource("");
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [source, rpc, onDone]);

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="p-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">Install</h2>
          <span className="text-xs text-muted-foreground">Local path, Git, or npm — we handle the rest</span>
        </div>

        <div className="mt-3 flex gap-2">
          <Input
            className="h-9 flex-1 font-mono text-xs"
            placeholder="path:./my-plugin  •  https://github.com/acme/my-plugin  •  npm:my-plugin"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            aria-label="Plugin location"
          />
          <Button size="sm" className="h-9 shrink-0" onClick={() => void submit()} disabled={busy || !source.trim()}>
            {busy ? "Installing…" : "Install"}
          </Button>
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono">/abs/path</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono">https://github.com/…</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono">npm:my-plugin@^1.0</span>
          <span className="ml-auto">Updates keep your data — just reinstall the same location.</span>
        </div>

        {err && <p className="mt-2 text-xs text-destructive" role="alert">{err}</p>}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "agent-plugins-status",
    title: "Agent Plugins",
    description: "Install once, use everywhere.",
    component: () => {
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

      const remove = async (id: string) => {
        if (!window.confirm("Remove this plugin? Its skills will be removed. Data is kept unless you purge.")) return;
        const purge = window.confirm("Also delete its stored data? OK = delete, Cancel = keep.");
        try {
          await rpc.call("remove", { id, purgeData: purge });
          await load();
        } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
      };

      const approve = async (pluginId: string, serverId: string) => {
        try {
          await rpc.call("approve", { id: pluginId, serverId });
          await load();
        } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
      };

      return (
        <div className="min-h-0 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-5 md:px-5 space-y-4">
            <div className="space-y-1">
              <h1 className="text-base font-semibold tracking-tight">Agent Plugins</h1>
              <p className="text-sm leading-5 text-muted-foreground">
                Install a plugin once. Its skills become <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">/skill</code> commands and its MCP tools flow to every provider.
              </p>
            </div>

            <InstallForm rpc={rpc} onDone={() => void load()} />
            {err && <p className="text-xs text-destructive" role="alert">{err}</p>}

            {!snap ? (
              <p className="py-6 text-sm text-muted-foreground">Loading…</p>
            ) : snap.plugins.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="py-8 text-center">
                  <p className="text-sm font-medium">No plugins yet</p>
                  <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">Paste a location above. A local folder needs <code className="font-mono text-xs">plugin.json</code> and <code className="font-mono text-xs">skills/</code>. Git and npm are fetched and validated before activation.</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {snap.plugins.map((p) => {
                  const skills = snap.skills.filter((s) => s.pluginId === p.id);
                  const servers = snap.mcpServers.filter((s) => s.pluginId === p.id);
                  const isPending = p.status === "needs-approval" || p.approval === "pending";
                  return (
                    <div key={p.id} className="rounded-lg border border-border bg-card">
                      <div className="flex items-start justify-between gap-3 p-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium">{p.name}</span>
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px]">
                              <StatusDot status={p.status} />{p.status}
                            </span>
                            {isPending && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">needs approval</span>}
                            {p.version && <span className="text-xs text-muted-foreground">v{p.version}</span>}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            <span className="truncate">{p.sourceType} · {p.sourceIntent}</span>
                            <span className="hidden sm:inline">·</span>
                            <span>spec {p.specVersion}</span>
                          </div>
                          {p.lastError && <p className="mt-1 text-xs text-destructive">{p.lastError}</p>}
                        </div>
                        <Button variant="ghost" size="sm" className="h-7 shrink-0 text-xs text-muted-foreground hover:text-destructive" onClick={() => void remove(p.id)}>Remove</Button>
                      </div>

                      {(skills.length > 0 || servers.length > 0) && <div className="border-t border-border" />}

                      {skills.length > 0 && (
                        <div className="px-4 py-3">
                          <div className="text-xs font-medium">Skills</div>
                          <ul className="mt-2 divide-y divide-border rounded-md border border-border">
                            {skills.map((s) => (
                              <li key={s.skillName} className="flex items-center justify-between gap-3 px-3 py-2">
                                <span className="font-mono text-xs">/{s.skillName}</span>
                                <span className="inline-flex items-center gap-1.5 text-[11px]">
                                  <StatusDot status={s.status} />
                                  <span className={s.status === "error" || s.status === "conflicted" ? "text-destructive" : "text-muted-foreground"}>{s.status}</span>
                                </span>
                              </li>
                            ))}
                          </ul>
                          {skills.some((s) => s.lastError) && (
                            <p className="mt-1.5 text-[11px] leading-snug text-destructive">
                              {skills.find((s) => s.lastError)?.lastError}
                            </p>
                          )}
                        </div>
                      )}

                      {servers.length > 0 && (
                        <div className="px-4 pb-4">
                          <div className="text-xs font-medium">MCP servers</div>
                          <ul className="mt-2 space-y-2">
                            {servers.map((srv) => (
                              <li key={srv.serverId} className="rounded-md border border-border bg-muted/20 px-3 py-2.5">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-xs font-medium">{srv.serverId}</span>
                                  <span className="inline-flex items-center gap-1.5 text-[11px]">
                                    <StatusDot status={srv.status} />
                                    <span className="text-muted-foreground">{srv.status}</span>
                                    <span className={srv.approved ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
                                      {srv.approved ? "approved" : "needs approval"}
                                    </span>
                                  </span>
                                </div>
                                <div className="mt-1 text-[11px] text-muted-foreground">Type: {srv.type}</div>
                                {srv.lastError && <p className="mt-1 text-[11px] leading-snug text-destructive">{srv.lastError}</p>}
                                {srv.approved !== 1 && srv.status !== "error" && (
                                  <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" onClick={() => void approve(p.id, srv.serverId)}>Approve</Button>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <p className="pb-2 text-center text-[11px] text-muted-foreground">Server-host only v0 · Skills appear in the next session · <code className="font-mono">bb agent-plugins list</code></p>
          </div>
        </div>
      );
    },
  });

  app.slots.navPanel({
    id: "agent-plugins",
    title: "Agent Plugins",
    icon: "Puzzle",
    path: "agent-plugins",
    component: () => {
      const rpc = useRpc<typeof rpcContract>();
      const [snap, setSnap] = useState<Snapshot | null>(null);
      const [err, setErr] = useState<string | null>(null);
      const load = useCallback(async () => {
        try {
          const s = (await rpc.call("snapshot", null)) as unknown as Snapshot;
          setSnap(s);
        } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
      }, [rpc]);
      useEffect(() => { void load(); }, [load]);
      useRealtime("agent-plugins-changed", () => { void load(); });
      const remove = async (id: string) => {
        if (!window.confirm("Remove this plugin?")) return;
        const purge = window.confirm("Also delete its stored data? OK = delete, Cancel = keep.");
        try { await rpc.call("remove", { id, purgeData: purge }); await load(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
      };
      const approve = async (pluginId: string, serverId: string) => {
        try { await rpc.call("approve", { id: pluginId, serverId }); await load(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
      };
      return (
        <div className="h-full overflow-y-auto bg-background">
          <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-5">
            <div className="rounded-lg border border-border bg-card p-4">
              <h2 className="text-sm font-medium">Install</h2>
              <p className="mt-1 text-xs text-muted-foreground">Local path, Git, or npm — we handle fetch, validation, and updates.</p>
              <InstallFormInner rpc={rpc} onDone={() => void load()} />
              {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
            </div>
            {!snap ? <p className="text-sm text-muted-foreground">Loading…</p> : snap.plugins.length === 0 ? (
              <div className="rounded-lg border border-dashed p-8 text-center">
                <p className="text-sm font-medium">No plugins yet</p>
                <p className="mt-1 text-sm text-muted-foreground">Install one above to get started.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {snap.plugins.map((p) => {
                  const skills = snap.skills.filter((s) => s.pluginId === p.id);
                  const servers = snap.mcpServers.filter((s) => s.pluginId === p.id);
                  return (
                    <div key={p.id} className="rounded-lg border border-border bg-card p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{p.name}</span>
                            <span className={`h-1.5 w-1.5 rounded-full ${p.status === "active" ? "bg-emerald-500" : p.status === "needs-approval" ? "bg-amber-500" : "bg-destructive"}`} />
                            <span className="text-xs text-muted-foreground">{p.status}</span>
                          </div>
                          <p className="mt-1 truncate text-xs text-muted-foreground">{p.sourceType}: {p.sourceIntent}</p>
                        </div>
                        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void remove(p.id)}>Remove</Button>
                      </div>
                      {skills.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{skills.length} skill{skills.length === 1 ? "" : "s"} · {skills.map((s) => `/${s.skillName} (${s.status})`).join(" · ")}</p>}
                      {servers.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {servers.map((s) => (
                            <span key={s.serverId} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/30 px-2 py-0.5 text-[11px]">
                              {s.serverId} · {s.status} {s.approved ? "· approved" : "· needs approval"}
                              {s.approved !== 1 && s.status !== "error" && <button className="ml-1 underline" onClick={() => void approve(p.id, s.serverId)}>approve</button>}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      );
    },
  });
});

function InstallFormInner({ onDone, rpc }: { onDone: () => void; rpc: ReturnType<typeof useRpc<typeof rpcContract>> }) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!source.trim()) { setErr("Enter a location."); return; }
    try { setBusy(true); setErr(null); await rpc.call("install", { source: source.trim() }); setSource(""); onDone(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="mt-3 flex gap-2">
      <Input className="h-9 flex-1 font-mono text-xs" placeholder="path:./my-plugin  •  https://github.com/acme/my-plugin  •  npm:my-plugin" value={source} onChange={(e) => setSource(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
      <Button size="sm" className="h-9" onClick={() => void submit()} disabled={busy || !source.trim()}>{busy ? "Installing…" : "Install"}</Button>
      {err && <span className="sr-only" role="alert">{err}</span>}
    </div>
  );
}
