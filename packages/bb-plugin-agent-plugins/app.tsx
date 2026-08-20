// bb-plugin-agent-plugins — frontend entry
import { useEffect, useState } from "react";
import { definePluginApp, useRpc, useRealtime } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

function StatusPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [snap, setSnap] = useState<{ plugins: unknown[]; skills: unknown[]; mcpServers: unknown[]; dataDir: string | null } | null>(null);
  const [tools, setTools] = useState<unknown[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => {
    void rpc
      .call("snapshot", null)
      .then((s) => {
        setSnap(s);
        setErr(null);
      })
      .catch((e) => setErr(String(e)));
    void rpc
      .call("listTools", null)
      .then((r) => setTools((r as { tools: unknown[] }).tools))
      .catch(() => {});
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRealtime("agent-plugins-changed", () => refresh());

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-5">
      <Card>
        <CardHeader>
          <CardTitle>Agent Plugins</CardTitle>
          <CardDescription>
            Install Agent Plugins (skills + MCP) once; flow to every provider. Server-host only v0 —
            see PLAN.md. Static bridge: list/call, not per-tool native tools.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={refresh}>
              Refresh
            </Button>
            <span className="text-muted-foreground self-center">dataDir: {snap?.dataDir ?? "—"}</span>
          </div>
          {err && <div className="rounded bg-destructive/10 p-2 text-destructive">Error: {err}</div>}
          <div className="grid gap-2 text-xs">
            <div>Plugins: {snap?.plugins.length ?? "—"}</div>
            <div>Skills: {snap?.skills.length ?? "—"}</div>
            <div>MCP servers: {snap?.mcpServers.length ?? "—"}</div>
            <div>Bridge tools: {tools.length}</div>
          </div>
          <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(snap ?? {}, null, 2)}</pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>CLI</CardTitle>
          <CardDescription>Phase 1 loader demo: try `bb agent-plugins install ./path/to/plugin --json`</CardDescription>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          <code>bb agent-plugins list --json</code> • <code>bb agent-plugins tools --json</code> • <code>bb agent-plugins show &lt;id&gt;</code>
        </CardContent>
      </Card>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "agent-plugins-status",
    title: "Agent Plugins",
    description: "Installed Agent Plugins, materialized skills, and MCP bridge status.",
    component: StatusPanel,
  });

  app.slots.navPanel({
    id: "agent-plugins",
    title: "Agent Plugins",
    icon: "Blocks",
    path: "agent-plugins",
    component: StatusPanel,
  });
});
