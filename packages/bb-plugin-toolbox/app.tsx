import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
} from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { McpTransportKind, ToolboxSnapshot } from "./src/types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Tab = "mcp" | "cli";

interface McpFormState {
  id: string | null;
  name: string;
  description: string;
  transport: McpTransportKind;
  url: string;
  command: string;
  argsJson: string;
  cwd: string;
  headersJson: string;
  envJson: string;
  enabled: boolean;
}

interface CliFormState {
  id: string | null;
  name: string;
  description: string;
  command: string;
  argsTemplateJson: string;
  inputSchemaJson: string;
  cwd: string;
  envJson: string;
  enabled: boolean;
}

const fieldClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring";
const textareaClass = `${fieldClass} h-auto min-h-20 py-2 font-mono text-xs`;
const buttonClass = "inline-flex min-h-8 items-center justify-center rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyMcpForm(): McpFormState {
  return {
    id: null,
    name: "",
    description: "",
    transport: "http",
    url: "",
    command: "",
    argsJson: "[]",
    cwd: "",
    headersJson: "",
    envJson: "",
    enabled: true,
  };
}

function emptyCliForm(): CliFormState {
  return {
    id: null,
    name: "",
    description: "",
    command: "",
    argsTemplateJson: "[]",
    inputSchemaJson: '{\n  "type": "object",\n  "properties": {},\n  "additionalProperties": false\n}',
    cwd: "",
    envJson: "",
    enabled: true,
  };
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${errorText(error)}`);
  }
}

function parseOptionalMap(value: string, label: string): Record<string, string> | undefined {
  if (!value.trim() || value.trim().startsWith("//")) return undefined;
  const parsed = parseJson<unknown>(value, label);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]));
}

function statusTone(status: string): string {
  if (status === "ready") return "text-emerald-600 dark:text-emerald-400";
  if (status === "error") return "text-destructive";
  if (status === "disabled") return "text-muted-foreground";
  return "text-amber-700 dark:text-amber-300";
}

function FormLabel({ children }: { children: ReactNode }) {
  return <label className="flex flex-col gap-1 text-xs font-medium text-foreground">{children}</label>;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      Enabled
    </label>
  );
}

function McpForm({
  form,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: McpFormState;
  busy: boolean;
  onChange: (next: McpFormState) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{form.id ? "Edit MCP server" : "Add MCP server"}</CardTitle>
        <CardDescription>Connect over Streamable HTTP or launch a local stdio server.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={onSubmit}>
          <div className="grid gap-3 md:grid-cols-2">
            <FormLabel>
              Name
              <input className={fieldClass} value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} required />
            </FormLabel>
            <FormLabel>
              Transport
              <select className={fieldClass} value={form.transport} onChange={(event) => onChange({ ...form, transport: event.target.value as McpTransportKind })}>
                <option value="http">Streamable HTTP</option>
                <option value="stdio">Local stdio</option>
              </select>
            </FormLabel>
          </div>
          <FormLabel>
            Description
            <input className={fieldClass} value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} placeholder="What this server provides" />
          </FormLabel>
          {form.transport === "http" ? (
            <FormLabel>
              MCP URL
              <input className={fieldClass} value={form.url} onChange={(event) => onChange({ ...form, url: event.target.value })} placeholder="https://example.com/mcp" required />
            </FormLabel>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              <FormLabel>
                Command
                <input className={fieldClass} value={form.command} onChange={(event) => onChange({ ...form, command: event.target.value })} placeholder="npx" required />
              </FormLabel>
              <FormLabel>
                Working directory
                <input className={fieldClass} value={form.cwd} onChange={(event) => onChange({ ...form, cwd: event.target.value })} placeholder="/path/to/project" />
              </FormLabel>
            </div>
          )}
          {form.transport === "stdio" ? (
            <FormLabel>
              Arguments JSON array
              <textarea className={textareaClass} value={form.argsJson} onChange={(event) => onChange({ ...form, argsJson: event.target.value })} placeholder='["-y", "@acme/server"]' />
            </FormLabel>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            <FormLabel>
              HTTP headers JSON object
              <textarea className={textareaClass} value={form.headersJson} onChange={(event) => onChange({ ...form, headersJson: event.target.value })} placeholder='{"Authorization":"Bearer …"}' />
            </FormLabel>
            <FormLabel>
              Environment JSON object
              <textarea className={textareaClass} value={form.envJson} onChange={(event) => onChange({ ...form, envJson: event.target.value })} placeholder='{"API_KEY":"…"}' />
            </FormLabel>
          </div>
          {form.id && (form.headersJson.trim() === "" || form.envJson.trim() === "") ? (
            <p className="text-xs text-muted-foreground">Leave credentials blank to keep the existing values.</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Toggle checked={form.enabled} onChange={(enabled) => onChange({ ...form, enabled })} />
            <span className="flex-1" />
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
            <Button type="submit" size="sm" disabled={busy}>{busy ? "Saving…" : "Save MCP server"}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function CliForm({
  form,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: CliFormState;
  busy: boolean;
  onChange: (next: CliFormState) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{form.id ? "Edit CLI tool" : "Add CLI tool"}</CardTitle>
        <CardDescription>Declare one safe, named operation. Toolbox validates inputs and never invokes a shell.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={onSubmit}>
          <div className="grid gap-3 md:grid-cols-2">
            <FormLabel>
              Name
              <input className={fieldClass} value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} placeholder="github_pr_view" required />
            </FormLabel>
            <FormLabel>
              Command
              <input className={fieldClass} value={form.command} onChange={(event) => onChange({ ...form, command: event.target.value })} placeholder="gh" required />
            </FormLabel>
          </div>
          <FormLabel>
            Description
            <input className={fieldClass} value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} placeholder="View a GitHub pull request" />
          </FormLabel>
          <div className="grid gap-3 md:grid-cols-2">
            <FormLabel>
              Arguments template JSON array
              <textarea className={textareaClass} value={form.argsTemplateJson} onChange={(event) => onChange({ ...form, argsTemplateJson: event.target.value })} placeholder='["pr", "view", "{{number}}", "--json", "title"]' />
            </FormLabel>
            <FormLabel>
              Input schema JSON object
              <textarea className={`${textareaClass} min-h-32`} value={form.inputSchemaJson} onChange={(event) => onChange({ ...form, inputSchemaJson: event.target.value })} />
            </FormLabel>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <FormLabel>
              Working directory
              <input className={fieldClass} value={form.cwd} onChange={(event) => onChange({ ...form, cwd: event.target.value })} placeholder="/path/to/project" />
            </FormLabel>
            <FormLabel>
              Environment JSON object
              <textarea className={textareaClass} value={form.envJson} onChange={(event) => onChange({ ...form, envJson: event.target.value })} placeholder='{"GH_TOKEN":"…"}' />
            </FormLabel>
          </div>
          {form.id && form.envJson.trim() === "" ? <p className="text-xs text-muted-foreground">Leave environment blank to keep the existing values.</p> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Toggle checked={form.enabled} onChange={(enabled) => onChange({ ...form, enabled })} />
            <span className="flex-1" />
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
            <Button type="submit" size="sm" disabled={busy}>{busy ? "Saving…" : "Save CLI tool"}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function ToolboxPanel({}: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [tab, setTab] = useState<Tab>("mcp");
  const [snapshot, setSnapshot] = useState<ToolboxSnapshot | null>(null);
  const [mcpForm, setMcpForm] = useState<McpFormState | null>(null);
  const [cliForm, setCliForm] = useState<CliFormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState("");
  const [toolArguments, setToolArguments] = useState("{}");
  const [toolResult, setToolResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const next = await rpc.call("snapshot");
      setSnapshot(next);
      setSelectedTool((current) => current || next.tools[0]?.exposedName || "");
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime("toolbox-catalog-changed", () => {
    void load();
  });

  const saveMcp = async (event: FormEvent) => {
    event.preventDefault();
    if (!mcpForm) return;
    try {
      setBusy(true);
      setError(null);
      const next = await rpc.call("saveMcp", {
        id: mcpForm.id,
        name: mcpForm.name,
        description: mcpForm.description,
        transport: mcpForm.transport,
        url: mcpForm.transport === "http" ? mcpForm.url || null : null,
        command: mcpForm.transport === "stdio" ? mcpForm.command || null : null,
        args: parseJson<string[]>(mcpForm.argsJson, "Arguments"),
        cwd: mcpForm.cwd || null,
        headers: parseOptionalMap(mcpForm.headersJson, "Headers"),
        env: parseOptionalMap(mcpForm.envJson, "Environment"),
        enabled: mcpForm.enabled,
      });
      setSnapshot(next);
      setMcpForm(null);
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setBusy(false);
    }
  };

  const saveCli = async (event: FormEvent) => {
    event.preventDefault();
    if (!cliForm) return;
    try {
      setBusy(true);
      setError(null);
      const next = await rpc.call("saveCli", {
        id: cliForm.id,
        name: cliForm.name,
        description: cliForm.description,
        command: cliForm.command,
        argsTemplate: parseJson<string[]>(cliForm.argsTemplateJson, "Arguments template"),
        inputSchema: parseJson<Record<string, unknown>>(cliForm.inputSchemaJson, "Input schema"),
        cwd: cliForm.cwd || null,
        env: parseOptionalMap(cliForm.envJson, "Environment"),
        enabled: cliForm.enabled,
      });
      setSnapshot(next);
      setCliForm(null);
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setBusy(false);
    }
  };

  const invoke = async () => {
    if (!selectedTool) return;
    try {
      setBusy(true);
      setToolResult(null);
      const args = parseJson<Record<string, unknown>>(toolArguments, "Tool arguments");
      const result = await rpc.call("invoke", { toolName: selectedTool, arguments: args });
      setToolResult(result.text);
    } catch (invokeError) {
      setToolResult(errorText(invokeError));
    } finally {
      setBusy(false);
    }
  };

  const toolsBySource = useMemo(() => {
    const groups = new Map<string, number>();
    for (const tool of snapshot?.tools ?? []) groups.set(tool.sourceName, (groups.get(tool.sourceName) ?? 0) + 1);
    return groups;
  }, [snapshot]);

  if (loading && !snapshot) return <div className="p-5 text-sm text-muted-foreground">Loading Toolbox…</div>;

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-background p-4 text-foreground md:p-5">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Toolbox</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">One repository for MCP servers and safe, named CLI operations. BB agents use the same catalog through native tools.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()}>Refresh</Button>
            <Button size="sm" onClick={() => { setTab("mcp"); setMcpForm(emptyMcpForm()); setCliForm(null); }}>Add MCP</Button>
            <Button variant="outline" size="sm" onClick={() => { setTab("cli"); setCliForm(emptyCliForm()); setMcpForm(null); }}>Add CLI</Button>
          </div>
        </div>

        {error ? <div className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</div> : null}

        <Card>
          <CardContent className="flex flex-col gap-2 py-4 text-xs text-muted-foreground">
            <div><span className="font-medium text-foreground">MCP proxy:</span> <code>{snapshot?.mcpEndpoint}</code></div>
            <div>Authenticate clients with <code>bb plugin token toolbox</code>. The proxy exposes tools from enabled MCP and CLI entries.</div>
          </CardContent>
        </Card>

        <div className="flex gap-1 border-b border-border">
          <button className={`${buttonClass} rounded-b-none ${tab === "mcp" ? "border-b-2 border-foreground text-foreground" : "text-muted-foreground"}`} onClick={() => setTab("mcp")}>MCP servers ({snapshot?.mcpServers.length ?? 0})</button>
          <button className={`${buttonClass} rounded-b-none ${tab === "cli" ? "border-b-2 border-foreground text-foreground" : "text-muted-foreground"}`} onClick={() => setTab("cli")}>CLI tools ({snapshot?.cliTools.length ?? 0})</button>
        </div>

        {tab === "mcp" && mcpForm ? <McpForm form={mcpForm} busy={busy} onChange={setMcpForm} onCancel={() => setMcpForm(null)} onSubmit={(event) => void saveMcp(event)} /> : null}
        {tab === "cli" && cliForm ? <CliForm form={cliForm} busy={busy} onChange={setCliForm} onCancel={() => setCliForm(null)} onSubmit={(event) => void saveCli(event)} /> : null}

        {tab === "mcp" ? (
          <div className="grid gap-3">
            {snapshot?.mcpServers.length ? snapshot.mcpServers.map((source) => (
              <Card key={source.id}>
                <CardContent className="flex flex-wrap items-start gap-3 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{source.name}</span><span className={`text-xs ${statusTone(source.status)}`}>{source.status}</span></div>
                    <p className="mt-1 text-sm text-muted-foreground">{source.description || (source.transport === "http" ? source.endpoint : source.command)}</p>
                    <p className="mt-2 text-xs text-muted-foreground">{source.toolCount} tools · {source.transport === "http" ? source.endpoint : `${source.command}${source.cwd ? ` · ${source.cwd}` : ""}`}{source.hasHeaders ? " · headers configured" : ""}{source.hasEnv ? " · environment configured" : ""}</p>
                    {source.lastError ? <p className="mt-2 text-xs text-destructive">{source.lastError}</p> : null}
                  </div>
              <div className="flex gap-1"><Button variant="ghost" size="sm" onClick={() => void rpc.call("refreshMcp", { id: source.id }).then(setSnapshot).catch((refreshError) => setError(errorText(refreshError)))}>Refresh</Button><Button variant="ghost" size="sm" onClick={() => { setMcpForm({ ...emptyMcpForm(), id: source.id, name: source.name, description: source.description, transport: source.transport, url: source.endpoint ?? "", command: source.command ?? "", argsJson: JSON.stringify(source.args, null, 2), cwd: source.cwd ?? "", enabled: source.enabled, headersJson: source.hasHeaders ? "// existing headers kept when blank" : "", envJson: source.hasEnv ? "// existing environment kept when blank" : "" }); setCliForm(null); }}>Edit</Button><Button variant="ghost" size="sm" className="text-destructive" onClick={() => { if (window.confirm(`Delete ${source.name}?`)) void rpc.call("deleteMcp", { id: source.id }).then(setSnapshot).catch((deleteError) => setError(errorText(deleteError))); }}>Delete</Button></div>
                </CardContent>
              </Card>
            )) : <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No MCP servers yet. Add a URL or a local stdio command.</CardContent></Card>}
          </div>
        ) : (
          <div className="grid gap-3">
            {snapshot?.cliTools.length ? snapshot.cliTools.map((tool) => (
              <Card key={tool.id}>
                <CardContent className="flex flex-wrap items-start gap-3 py-4">
                  <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{tool.name}</span><span className={`text-xs ${statusTone(tool.status)}`}>{tool.status}</span></div><p className="mt-1 text-sm text-muted-foreground">{tool.description || tool.command}</p><p className="mt-2 font-mono text-xs text-muted-foreground">{tool.command} {tool.argsTemplate.join(" ")}{tool.cwd ? ` · ${tool.cwd}` : ""}{tool.hasEnv ? " · environment configured" : ""}</p></div>
                  <div className="flex gap-1"><Button variant="ghost" size="sm" onClick={() => { setCliForm({ ...emptyCliForm(), id: tool.id, name: tool.name, description: tool.description, command: tool.command, argsTemplateJson: JSON.stringify(tool.argsTemplate, null, 2), inputSchemaJson: JSON.stringify(tool.inputSchema, null, 2), cwd: tool.cwd ?? "", enabled: tool.enabled, envJson: tool.hasEnv ? "// existing environment kept when blank" : "" }); setMcpForm(null); }}>Edit</Button><Button variant="ghost" size="sm" className="text-destructive" onClick={() => { if (window.confirm(`Delete ${tool.name}?`)) void rpc.call("deleteCli", { id: tool.id }).then(setSnapshot).catch((deleteError) => setError(errorText(deleteError))); }}>Delete</Button></div>
                </CardContent>
              </Card>
            )) : <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No CLI tools yet. Define a named operation with a JSON input schema.</CardContent></Card>}
          </div>
        )}

        <Card>
          <CardHeader><CardTitle>Exposed catalog</CardTitle><CardDescription>{snapshot?.tools.length ?? 0} enabled tools are available to the native agent bridge and MCP proxy.</CardDescription></CardHeader>
          <CardContent className="grid gap-3">
            {snapshot?.tools.length ? <div className="divide-y divide-border border-y border-border">{snapshot.tools.map((tool) => <button key={tool.exposedName} className="flex w-full items-start gap-3 py-3 text-left hover:bg-state-hover" onClick={() => setSelectedTool(tool.exposedName)}><span className="min-w-0 flex-1"><span className="block truncate font-mono text-xs text-foreground">{tool.exposedName}</span><span className="mt-1 block text-xs text-muted-foreground">{tool.description}</span></span><span className="shrink-0 text-xs text-muted-foreground">{tool.sourceName}</span></button>)}</div> : <p className="text-sm text-muted-foreground">Add a source to populate the catalog.</p>}
            <p className="text-xs text-muted-foreground">{[...toolsBySource.entries()].map(([name, count]) => `${name}: ${count}`).join(" · ")}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Try a tool</CardTitle><CardDescription>Run one catalog entry from the server and inspect its result.</CardDescription></CardHeader>
          <CardContent className="grid gap-3"><select className={fieldClass} value={selectedTool} onChange={(event) => setSelectedTool(event.target.value)}><option value="">Choose a tool</option>{snapshot?.tools.map((tool) => <option key={tool.exposedName} value={tool.exposedName}>{tool.exposedName}</option>)}</select><textarea className={`${textareaClass} min-h-24`} value={toolArguments} onChange={(event) => setToolArguments(event.target.value)} /><div><Button size="sm" disabled={!selectedTool || busy} onClick={() => void invoke()}>{busy ? "Running…" : "Run tool"}</Button></div>{toolResult ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs text-foreground">{toolResult}</pre> : null}</CardContent>
        </Card>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "toolbox",
    title: "Toolbox",
    icon: "Wrench",
    path: "tools",
    component: ToolboxPanel,
  });
});
