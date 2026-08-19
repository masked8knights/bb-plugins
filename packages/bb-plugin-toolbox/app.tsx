import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
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
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@/components/ui/drawer";

type Tab = "mcp" | "cli-source";

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

interface CliSourceFormState {
  id: string | null;
  name: string;
  description: string;
  command: string;
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

function emptyCliSourceForm(): CliSourceFormState {
  return {
    id: null,
    name: "",
    description: "",
    command: "",
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

function toolLabel(tool: ToolboxSnapshot["tools"][number]): string {
  return tool.sourceName !== tool.name ? `${tool.name} · ${tool.sourceName}` : tool.name;
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

function CliSourceForm({
  form,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: CliSourceFormState;
  busy: boolean;
  onChange: (next: CliSourceFormState) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{form.id ? "Edit CLI source" : "Add CLI source"}</CardTitle>
        <CardDescription>Expose the CLI itself. Agents pass direct argv arguments; Toolbox never invokes a shell.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={onSubmit}>
          <div className="grid gap-3 md:grid-cols-2">
            <FormLabel>
              Name
              <input className={fieldClass} value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} placeholder="Bird" required />
            </FormLabel>
            <FormLabel>
              Executable
              <input className={fieldClass} value={form.command} onChange={(event) => onChange({ ...form, command: event.target.value })} placeholder="bird" required />
            </FormLabel>
          </div>
          <FormLabel>
            Description
            <input className={fieldClass} value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} placeholder="Twitter CLI for reading and posting" />
          </FormLabel>
          <div className="grid gap-3 md:grid-cols-2">
            <FormLabel>
              Working directory
              <input className={fieldClass} value={form.cwd} onChange={(event) => onChange({ ...form, cwd: event.target.value })} placeholder="Optional" />
            </FormLabel>
            <FormLabel>
              Environment JSON object
              <textarea className={textareaClass} value={form.envJson} onChange={(event) => onChange({ ...form, envJson: event.target.value })} placeholder='{"NO_COLOR":"1"}' />
            </FormLabel>
          </div>
          {form.id && form.envJson.trim() === "" ? <p className="text-xs text-muted-foreground">Leave environment blank to keep the existing values.</p> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Toggle checked={form.enabled} onChange={(enabled) => onChange({ ...form, enabled })} />
            <span className="flex-1" />
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
            <Button type="submit" size="sm" disabled={busy}>{busy ? "Saving…" : "Save CLI source"}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

type CatalogTool = ToolboxSnapshot["tools"][number];
type McpSummary = ToolboxSnapshot["mcpServers"][number];
type CliSourceSummary = ToolboxSnapshot["cliSources"][number];

function statusIndicator(status: string) {
  return (
    <span className={`inline-flex items-center gap-2 text-xs ${statusTone(status)}`}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${status === "ready" ? "bg-emerald-500" : status === "error" ? "bg-destructive" : status === "disabled" ? "bg-muted-foreground" : "bg-amber-500"}`} />
      {status}
    </span>
  );
}

function EmptySourceState({ tab, onAdd }: { tab: Tab; onAdd: () => void }) {
  const label = tab === "mcp" ? "MCP server" : "CLI source";
  const description = tab === "mcp"
    ? "Connect an HTTP or local MCP server."
    : "Expose an executable directly so agents can use its own commands.";
  return (
    <div className="rounded-md border border-dashed border-border px-4 py-10 text-center">
      <p className="text-sm font-medium text-foreground">No {label.toLowerCase()}s yet</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      <Button className="mt-4" variant="outline" size="sm" onClick={onAdd}>Add source</Button>
    </div>
  );
}

function SourceTable({
  tab,
  snapshot,
  onAdd,
  onEditMcp,
  onRefreshMcp,
  onDeleteMcp,
  onEditCliSource,
  onDeleteCliSource,
}: {
  tab: Tab;
  snapshot: ToolboxSnapshot;
  onAdd: () => void;
  onEditMcp: (source: McpSummary) => void;
  onRefreshMcp: (source: McpSummary) => void;
  onDeleteMcp: (source: McpSummary) => void;
  onEditCliSource: (source: CliSourceSummary) => void;
  onDeleteCliSource: (source: CliSourceSummary) => void;
}) {
  if (tab === "mcp" && snapshot.mcpServers.length === 0) return <EmptySourceState tab={tab} onAdd={onAdd} />;
  if (tab === "cli-source" && snapshot.cliSources.length === 0) return <EmptySourceState tab={tab} onAdd={onAdd} />;

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[720px] border-collapse text-left text-sm">
        <thead className="border-b border-border bg-muted/20 text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">Source</th>
            <th className="px-4 py-3 font-medium">{tab === "mcp" ? "Endpoint" : "Executable"}</th>
            <th className="px-4 py-3 font-medium">Description</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="w-1 px-4 py-3"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {tab === "mcp" ? snapshot.mcpServers.map((source) => (
            <tr key={source.id} className="align-top hover:bg-state-hover/50">
              <td className="px-4 py-3"><div className="font-medium text-foreground">{source.name}</div><div className="mt-1 text-xs text-muted-foreground">{source.transport === "http" ? "Streamable HTTP" : "Local stdio"}</div></td>
              <td className="max-w-[18rem] px-4 py-3"><code className="block truncate text-xs text-muted-foreground" title={source.endpoint ?? source.command ?? ""}>{source.endpoint ?? source.command ?? "—"}</code></td>
              <td className="max-w-[22rem] px-4 py-3 text-muted-foreground"><span className="block truncate" title={source.description}>{source.description || "—"}</span>{source.lastError ? <span className="mt-1 block truncate text-xs text-destructive" title={source.lastError}>{source.lastError}</span> : null}</td>
              <td className="px-4 py-3">{statusIndicator(source.status)}</td>
              <td className="px-4 py-3"><div className="flex justify-end gap-1"><Button variant="ghost" size="sm" onClick={() => onRefreshMcp(source)}>Refresh</Button><Button variant="ghost" size="sm" onClick={() => onEditMcp(source)}>Edit</Button><Button variant="ghost" size="sm" className="text-destructive" onClick={() => onDeleteMcp(source)}>Delete</Button></div></td>
            </tr>
          )) : null}
          {tab === "cli-source" ? snapshot.cliSources.map((source) => (
            <tr key={source.id} className="align-top hover:bg-state-hover/50">
              <td className="px-4 py-3"><div className="font-medium text-foreground">{source.name}</div><div className="mt-1 text-xs text-muted-foreground">CLI source</div></td>
              <td className="px-4 py-3"><code className="text-xs text-muted-foreground">{source.command}</code></td>
              <td className="max-w-[28rem] px-4 py-3 text-muted-foreground"><span className="block truncate" title={source.description}>{source.description || "—"}</span></td>
              <td className="px-4 py-3">{statusIndicator(source.status)}</td>
              <td className="px-4 py-3"><div className="flex justify-end gap-1"><Button variant="ghost" size="sm" onClick={() => onEditCliSource(source)}>Edit</Button><Button variant="ghost" size="sm" className="text-destructive" onClick={() => onDeleteCliSource(source)}>Delete</Button></div></td>
            </tr>
          )) : null}
        </tbody>
      </table>
    </div>
  );
}

function AvailableToolsSummary({ tools, onRun }: { tools: CatalogTool[]; onRun: (tool: CatalogTool) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-y border-border py-4">
      <div className="shrink-0">
        <div className="text-sm font-medium text-foreground">Available tools</div>
        <div className="text-xs text-muted-foreground">{tools.length === 0 ? "None enabled" : `${tools.length} enabled`}</div>
      </div>
      {tools.length ? <div className="flex min-w-0 flex-1 flex-wrap gap-2">{tools.map((tool) => <button key={tool.exposedName} className="rounded-md border border-border px-2.5 py-1 text-left text-xs text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => onRun(tool)}>{toolLabel(tool)}</button>)}</div> : <span className="flex-1 text-sm text-muted-foreground">Add a source to make a tool available to agents.</span>}
      {tools.length ? <Button variant="outline" size="sm" onClick={() => onRun(tools[0]!)}>Run a tool</Button> : null}
    </div>
  );
}

function ToolRunnerDrawer({
  open,
  onOpenChange,
  tool,
  jsonArguments,
  rawArguments,
  result,
  busy,
  onJsonArgumentsChange,
  onRawArgumentsChange,
  onRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tool: CatalogTool | null;
  jsonArguments: string;
  rawArguments: string;
  result: string | null;
  busy: boolean;
  onJsonArgumentsChange: (value: string) => void;
  onRawArgumentsChange: (value: string) => void;
  onRun: () => void;
}) {
  const raw = tool?.sourceKind === "cli-source";
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 pb-6 pt-2">
          <div>
            <DrawerTitle>Run {tool ? toolLabel(tool) : "a tool"}</DrawerTitle>
            <DrawerDescription className="mt-1">{raw ? "Enter one direct CLI argument per line. Toolbox does not invoke a shell." : "Provide the JSON object required by this tool."}</DrawerDescription>
          </div>
          {tool ? (
            <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); onRun(); }}>
              <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
                {raw ? "Arguments" : "Arguments JSON"}
                <textarea className={`${textareaClass} min-h-28`} value={raw ? rawArguments : jsonArguments} onChange={(event) => raw ? onRawArgumentsChange(event.target.value) : onJsonArgumentsChange(event.target.value)} placeholder={raw ? "--help\nsearch\nfrom:OpenAI\n--json" : "{}"} autoFocus />
              </label>
              <div className="flex items-center justify-end gap-2">
                <DrawerClose asChild><Button type="button" variant="ghost">Cancel</Button></DrawerClose>
                <Button type="submit" disabled={busy}>{busy ? "Running…" : "Run tool"}</Button>
              </div>
            </form>
          ) : <p className="text-sm text-muted-foreground">Select a tool first.</p>}
          {result ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs text-foreground">{result}</pre> : null}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function ToolboxPanel({}: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [tab, setTab] = useState<Tab | null>(null);
  const [snapshot, setSnapshot] = useState<ToolboxSnapshot | null>(null);
  const [mcpForm, setMcpForm] = useState<McpFormState | null>(null);
  const [cliSourceForm, setCliSourceForm] = useState<CliSourceFormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState("");
  const [toolArguments, setToolArguments] = useState("{}");
  const [rawArguments, setRawArguments] = useState("");
  const [toolResult, setToolResult] = useState<string | null>(null);
  const [toolDrawerOpen, setToolDrawerOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  const activeTab = tab ?? (snapshot?.cliSources.length ? "cli-source" : "mcp");
  const activeTool = snapshot?.tools.find((tool) => tool.exposedName === selectedTool) ?? null;

  const load = useCallback(async () => {
    try {
      setError(null);
      const next = await rpc.call("snapshot");
      setSnapshot(next);
      setSelectedTool((current) => next.tools.some((tool) => tool.exposedName === current) ? current : next.tools[0]?.exposedName || "");
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

  useEffect(() => {
    if (!addMenuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddMenuOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [addMenuOpen]);

  const clearForms = () => {
    setMcpForm(null);
    setCliSourceForm(null);
  };

  const switchTab = (nextTab: Tab) => {
    setTab(nextTab);
    clearForms();
  };

  const startAdd = (nextTab: Tab) => {
    setAddMenuOpen(false);
    setTab(nextTab);
    setError(null);
    setMcpForm(nextTab === "mcp" ? emptyMcpForm() : null);
    setCliSourceForm(nextTab === "cli-source" ? emptyCliSourceForm() : null);
  };

  const openToolRunner = (tool: CatalogTool) => {
    setSelectedTool(tool.exposedName);
    setToolResult(null);
    if (tool.sourceKind === "cli-source") setRawArguments("");
    else setToolArguments("{}");
    setToolDrawerOpen(true);
  };

  const closeToolRunner = (open: boolean) => {
    setToolDrawerOpen(open);
    if (!open) setToolResult(null);
  };

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

  const saveCliSource = async (event: FormEvent) => {
    event.preventDefault();
    if (!cliSourceForm) return;
    try {
      setBusy(true);
      setError(null);
      const next = await rpc.call("saveCliSource", {
        id: cliSourceForm.id,
        name: cliSourceForm.name,
        description: cliSourceForm.description,
        command: cliSourceForm.command,
        cwd: cliSourceForm.cwd || null,
        env: parseOptionalMap(cliSourceForm.envJson, "Environment"),
        enabled: cliSourceForm.enabled,
      });
      setSnapshot(next);
      setCliSourceForm(null);
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setBusy(false);
    }
  };

  const invoke = async () => {
    if (!selectedTool || !activeTool) return;
    try {
      setBusy(true);
      setToolResult(null);
      const argumentsValue = activeTool.sourceKind === "cli-source"
        ? { argv: rawArguments.split(/\r?\n/gu).filter((argument) => argument.trim().length > 0) }
        : parseJson<Record<string, unknown>>(toolArguments, "Tool arguments");
      const result = await rpc.call("invoke", { toolName: selectedTool, arguments: argumentsValue });
      setToolResult(result.text);
    } catch (invokeError) {
      setToolResult(errorText(invokeError));
    } finally {
      setBusy(false);
    }
  };

  const refreshMcp = async (source: McpSummary) => {
    try {
      setBusy(true);
      setError(null);
      const next = await rpc.call("refreshMcp", { id: source.id });
      setSnapshot(next);
    } catch (refreshError) {
      setError(errorText(refreshError));
    } finally {
      setBusy(false);
    }
  };

  const deleteMcp = async (source: McpSummary) => {
    if (!window.confirm(`Delete ${source.name}?`)) return;
    try {
      setBusy(true);
      const next = await rpc.call("deleteMcp", { id: source.id });
      setSnapshot(next);
    } catch (deleteError) {
      setError(errorText(deleteError));
    } finally {
      setBusy(false);
    }
  };

  const deleteCliSource = async (source: CliSourceSummary) => {
    if (!window.confirm(`Delete ${source.name}?`)) return;
    try {
      setBusy(true);
      const next = await rpc.call("deleteCliSource", { id: source.id });
      setSnapshot(next);
    } catch (deleteError) {
      setError(errorText(deleteError));
    } finally {
      setBusy(false);
    }
  };

  const editMcp = (source: McpSummary) => {
    setTab("mcp");
    setCliSourceForm(null);
    setMcpForm({ ...emptyMcpForm(), id: source.id, name: source.name, description: source.description, transport: source.transport, url: source.endpoint ?? "", command: source.command ?? "", argsJson: JSON.stringify(source.args, null, 2), cwd: source.cwd ?? "", enabled: source.enabled, headersJson: source.hasHeaders ? "// existing headers kept when blank" : "", envJson: source.hasEnv ? "// existing environment kept when blank" : "" });
  };

  const editCliSource = (source: CliSourceSummary) => {
    setTab("cli-source");
    setMcpForm(null);
    setCliSourceForm({ ...emptyCliSourceForm(), id: source.id, name: source.name, description: source.description, command: source.command, cwd: source.cwd ?? "", enabled: source.enabled, envJson: source.hasEnv ? "// existing environment kept when blank" : "" });
  };

  if (loading && !snapshot) return <div className="p-5 text-sm text-muted-foreground">Loading Toolbox…</div>;
  if (!snapshot) return <div className="grid gap-3 p-5 text-sm text-muted-foreground"><p>{error ?? "Toolbox could not be loaded."}</p><Button className="w-fit" variant="outline" size="sm" onClick={() => void load()}>Retry</Button></div>;

  return (
    <>
      <div className="h-full min-h-0 overflow-y-auto bg-background p-4 text-foreground md:p-5">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-lg font-semibold">Toolbox</h1>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Connect servers and make command-line tools available to BB agents.</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Button size="sm" aria-expanded={addMenuOpen} aria-haspopup="menu" onClick={() => setAddMenuOpen((open) => !open)}>Add source <span aria-hidden="true">⌄</span></Button>
                {addMenuOpen ? <div className="absolute right-0 top-full z-20 mt-2 w-72 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md" role="menu">
                  <button className="w-full rounded-md p-3 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" role="menuitem" onClick={() => startAdd("mcp")}><span className="block text-sm font-medium">MCP server</span><span className="mt-1 block text-xs text-muted-foreground">Connect an HTTP or local server.</span></button>
                  <button className="w-full rounded-md p-3 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" role="menuitem" onClick={() => startAdd("cli-source")}><span className="block text-sm font-medium">CLI source</span><span className="mt-1 block text-xs text-muted-foreground">Expose an executable and its own commands.</span></button>
                </div> : null}
              </div>
              <Button variant="ghost" size="sm" onClick={() => void load()}>Refresh</Button>
            </div>
          </div>

          {error ? <div className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</div> : null}

          <div role="tablist" aria-label="Toolbox sources" className="flex gap-1 border-b border-border">
            {([ ["mcp", "MCP servers"], ["cli-source", "CLI sources"] ] as const).map(([id, label]) => <button key={id} role="tab" aria-selected={activeTab === id} className={`${buttonClass} rounded-b-none ${activeTab === id ? "border-b-2 border-foreground text-foreground" : "text-muted-foreground"}`} onClick={() => switchTab(id)}>{label}</button>)}
          </div>

          {activeTab === "mcp" && mcpForm ? <McpForm form={mcpForm} busy={busy} onChange={setMcpForm} onCancel={() => setMcpForm(null)} onSubmit={(event) => void saveMcp(event)} /> : null}
          {activeTab === "cli-source" && cliSourceForm ? <CliSourceForm form={cliSourceForm} busy={busy} onChange={setCliSourceForm} onCancel={() => setCliSourceForm(null)} onSubmit={(event) => void saveCliSource(event)} /> : null}

          <SourceTable tab={activeTab} snapshot={snapshot} onAdd={() => setAddMenuOpen(true)} onEditMcp={editMcp} onRefreshMcp={(source) => void refreshMcp(source)} onDeleteMcp={(source) => void deleteMcp(source)} onEditCliSource={editCliSource} onDeleteCliSource={(source) => void deleteCliSource(source)} />
          <AvailableToolsSummary tools={snapshot.tools} onRun={openToolRunner} />
        </div>
      </div>
      <ToolRunnerDrawer open={toolDrawerOpen} onOpenChange={closeToolRunner} tool={activeTool} jsonArguments={toolArguments} rawArguments={rawArguments} result={toolResult} busy={busy} onJsonArgumentsChange={setToolArguments} onRawArgumentsChange={setRawArguments} onRun={() => void invoke()} />
    </>
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
