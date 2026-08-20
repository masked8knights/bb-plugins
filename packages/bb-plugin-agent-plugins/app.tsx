// bb-plugin-agent-plugins — frontend entry
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

function statusBadge(status: string) {
  const cls =
    status === "active" || status === "ready"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
      : status === "needs-approval" || status === "pending"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30"
        : status === "error" || status === "conflicted"
          ? "bg-destructive/10 text-destructive border-destructive/30"
          : "bg-muted text-muted-foreground border-border";
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>{status}</span>;
}

function InstallCard({ onInstalled, rpc }: { onInstalled: () => void; rpc: ReturnType<typeof useRpc<typeof rpcContract>> }) {
  const [source, setSource] = useState("");
  const [tagPrefix, setTagPrefix] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const doInstall = async () => {
    const s = source.trim();
    if (!s) { setError("Enter a path, git URL, or npm package."); return; }
    try {
      setBusy(true); setError(null); setOk(null);
      const res = await rpc.call("install", { source: s, tagPrefix: tagPrefix.trim() || undefined });
      setOk(`Installed ${res.name ?? res.id}`);
      setSource("");
      setTagPrefix("");
      onInstalled();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Install a plugin</CardTitle>
        <CardDescription>
          Paste a local path, a Git repository, or an npm package. The plugin handles fetching, validation, skill setup, and updates for you.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground">Plugin location</label>
          <Input
            placeholder="path:/Users/you/my-plugin  •  https://github.com/acme/my-plugin  •  npm:my-plugin@^1.0.0"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void doInstall(); }}
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            <span className="font-medium">Examples:</span> <code>path:./my-plugin</code> or <code>/abs/path</code> • <code>git:https://github.com/acme/my-plugin@main</code> • <code>npm:my-plugin</code> or <code>npm:@scope/pkg@1.2.3</code>
          </p>
        </div>
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-xs font-medium text-foreground">Advanced</summary>
          <div className="mt-3 space-y-1.5">
            <label className="text-xs font-medium text-foreground">Tag prefix (for git semver ranges)</label>
            <Input placeholder="my-plugin/  (only if repo uses prefixed tags like my-plugin/v1.2.3)" value={tagPrefix} onChange={(e) => setTagPrefix(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">Leave empty unless your git repo tags releases with a prefix. Most plugins don&apos;t need this.</p>
          </div>
        </details>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void doInstall()} disabled={busy || !source.trim()}>{busy ? "Installing…" : "Install"}</Button>
          <span className="text-xs text-muted-foreground">Skills appear after install; MCP servers need approval.</span>
        </div>
        {error && <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{error}</div>}
        {ok && <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">{ok}</div>}
      </CardContent>
    </Card>
  );
}

function PluginCard({
  plugin,
  skills,
  servers,
  onRemove,
  onApprove,
  onRefresh,
}: {
  plugin: Snapshot["plugins"][number];
  skills: Snapshot["skills"];
  servers: Snapshot["mcpServers"];
  onRemove: (id: string) => void;
  onApprove: (pluginId: string, serverId: string) => void;
  onRefresh: () => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <span className="truncate">{plugin.name}</span>
              {statusBadge(plugin.status)}
              {plugin.approval === "pending" && statusBadge("pending")}
            </CardTitle>
            <CardDescription className="mt-1 flex flex-wrap items-center gap-2 text-xs">
              {plugin.version && <span>v{plugin.version}</span>}
              <span>spec {plugin.specVersion}</span>
              <span>•</span>
              <span className="truncate">{plugin.sourceType}: {plugin.sourceIntent}</span>
            </CardDescription>
            {plugin.sourceResolved && <p className="mt-1 truncate text-[11px] text-muted-foreground">Resolved: {plugin.sourceResolved}</p>}
            {plugin.lastError && <p className="mt-1 text-xs text-destructive">{plugin.lastError}</p>}
          </div>
          <div className="flex shrink-0 gap-1">
            <Button variant="ghost" size="sm" onClick={onRefresh}>Refresh</Button>
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => onRemove(plugin.id)}>Remove</Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <h4 className="text-xs font-medium text-foreground">Skills · {skills.length}</h4>
          {skills.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">No skills in this plugin. Skills are available as slash commands after install.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {skills.map((s) => (
                <li key={s.skillName} className="flex items-center justify-between rounded-md border border-border bg-muted/20 px-3 py-2">
                  <div className="min-w-0">
                    <span className="text-xs font-medium text-foreground">/{s.skillName}</span>
                    {s.lastError && <p className="mt-0.5 line-clamp-2 text-[11px] text-destructive">{s.lastError}</p>}
                  </div>
                  {statusBadge(s.status)}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h4 className="text-xs font-medium text-foreground">MCP servers · {servers.length}</h4>
          {servers.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">No MCP servers. If the plugin provides tools, they appear via the static bridge after approval.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {servers.map((srv) => (
                <li key={srv.serverId} className="rounded-md border border-border px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">{srv.serverId}</span>
                    <span className="flex items-center gap-1.5">
                      {statusBadge(srv.status)}
                      {srv.approved === 1 ? <span className="text-[11px] text-emerald-600 dark:text-emerald-400">approved</span> : <span className="text-[11px] text-amber-600 dark:text-amber-400">needs approval</span>}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">Type: {srv.type}</p>
                  {srv.lastError && <p className="mt-1 text-[11px] text-destructive">{srv.lastError}</p>}
                  {srv.approved !== 1 && srv.status !== "error" && (
                    <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" onClick={() => onApprove(plugin.id, srv.serverId)}>
                      Approve &amp; start
                    </Button>
                  )}
                  {srv.status === "error" && <p className="mt-1 text-[11px] text-muted-foreground">Fix the plugin&apos;s mcp.json and reinstall, or remove the plugin.</p>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground">
          Updates: for <code>git</code> or <code>npm</code> sources, remove and reinstall the same location to fetch the latest version. The plugin keeps your data in <code>pluginData</code> across updates.
        </p>
      </CardContent>
    </Card>
  );
}

function AgentPluginsPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [tools, setTools] = useState<{ opaqueId: string; pluginName: string; name: string; description: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [nextSnap, nextTools] = await Promise.all([rpc.call("snapshot", null) as Promise<Snapshot>, rpc.call("listTools", null) as Promise<{ tools: typeof tools }>]);
      setSnap(nextSnap);
      setTools(nextTools.tools);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [rpc]);

  useEffect(() => { void load(); }, [load]);
  useRealtime("agent-plugins-changed", () => { void load(); });

  const doRemove = async (id: string) => {
    if (!window.confirm("Remove this plugin? Skills will be removed. Plugin data is kept unless you purge.")) return;
    const purge = window.confirm("Also delete its pluginData (caches, stores)? OK = purge, Cancel = keep.");
    try { setBusy(true); await rpc.call("remove", { id, purgeData: purge }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const doApprove = async (pluginId: string, serverId: string) => {
    try { setBusy(true); await rpc.call("approve", { id: pluginId, serverId }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:p-5">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Agent Plugins</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Install once, use everywhere — skills become slash commands and MCP tools flow to Codex, Claude, and Pi.
            Supports local paths, Git, and npm. Updates keep your data.
          </p>
        </div>

        <InstallCard rpc={rpc as unknown as ReturnType<typeof useRpc<typeof rpcContract>>} onInstalled={() => void load()} />

        {error && <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{error}</div>}

        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground">Installed · {snap ? snap.plugins.length : "…"} plugins · {snap ? snap.skills.length : "…"} skills · {tools.length} bridge tools</h2>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={busy}>Refresh</Button>
        </div>

        {!snap ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : snap.plugins.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-10 text-center">
              <p className="text-sm font-medium text-foreground">No plugins yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">Install your first plugin above. Try a local folder with <code>plugin.json</code> + <code>skills/</code>, or a Git URL like <code>https://github.com/acme/my-plugin</code>.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {snap.plugins.map((p) => (
              <PluginCard
                key={p.id}
                plugin={p}
                skills={snap.skills.filter((s) => s.pluginId === p.id)}
                servers={snap.mcpServers.filter((s) => s.pluginId === p.id)}
                onRemove={doRemove}
                onApprove={doApprove}
                onRefresh={() => void load()}
              />
            ))}
          </div>
        )}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">How it works</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs leading-relaxed text-muted-foreground">
            <p><span className="font-medium text-foreground">Skills</span> are copied to your skills folder and appear as <code>/skill-name</code> in the next session. No manual copy needed.</p>
            <p><span className="font-medium text-foreground">MCP</span> uses a static bridge: list with <code>agent_plugins_list_tools</code>, call with <code>agent_plugins_call</code>. Servers start only after you approve them.</p>
            <p><span className="font-medium text-foreground">Updates</span>: reinstall the same source (same path / git URL / npm spec) — the plugin stages the new version, validates it, then swaps atomically while keeping <code>pluginData</code>.</p>
            <p><span className="font-medium text-foreground">CLI</span>: <code>bb agent-plugins list</code> · <code>bb agent-plugins show &lt;id&gt;</code> · <code>bb agent-plugins tools</code> · <code>bb agent-plugins call &lt;opaqueId&gt; {"{…}"}</code></p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "agent-plugins-status",
    title: "Agent Plugins",
    description: "Install once, use everywhere — manage Agent Plugins, skills, and MCP approvals.",
    component: AgentPluginsPanel,
  });
  app.slots.navPanel({
    id: "agent-plugins",
    title: "Agent Plugins",
    icon: "Puzzle",
    path: "agent-plugins",
    component: AgentPluginsPanel,
  });
});
