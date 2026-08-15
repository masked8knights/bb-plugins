import { useEffect, useState, type ReactNode } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { JsonValue, PluginMessageDirectiveProps, PluginThreadHeaderActionProps, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { ReportRequest, rpcContract } from "./server";

type ReportParams = Partial<Omit<ReportRequest, "threadId">> & { reportId?: string };
type Report = { reportId: string; title: string; html: string; scope: "thread" | "message" | "selection"; sourceSeqEnd: number; createdAt: number; updatedAt: number };

function paramsOf(value: JsonValue | null): ReportParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as ReportParams;
}

function QuietState({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`flex h-full min-h-[360px] items-center justify-center p-8 text-sm ${error ? "text-destructive" : "text-muted-foreground"}`}>{children}</div>;
}

function ReportFrame({ report }: { report: Report }) {
  return <iframe title={report.title} sandbox="allow-scripts" srcDoc={report.html} className="h-full min-h-[720px] w-full border-0 bg-background" />;
}

function ReportPanel({ threadId, params }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = paramsOf(params);
  const paramsKey = JSON.stringify(params);
  useEffect(() => {
    let cancelled = false;
    setReport(null); setError(null);
    const promise = request.reportId
      ? rpc.call("getReport", { reportId: request.reportId })
      : rpc.call("createReport", { threadId, scope: request.scope ?? "thread", ...(request.messageId ? { messageId: request.messageId } : {}), ...(request.selectedText ? { selectedText: request.selectedText } : {}), ...(request.focus ? { focus: request.focus } : {}), ...(request.title ? { title: request.title } : {}) });
    void promise.then((result) => {
      if (cancelled) return;
      if (!result) throw new Error("This explainer is no longer available");
      if ("html" in result) setReport(result);
      else void rpc.call("getReport", { reportId: result.reportId }).then((full) => { if (!full) throw new Error("The explainer could not be loaded"); setReport(full); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Unable to load explainer"));
    }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to create explainer"); });
    return () => { cancelled = true; };
  }, [threadId, paramsKey]);
  if (error) return <QuietState error>{error}</QuietState>;
  if (!report) return <QuietState>Creating explainer…</QuietState>;
  return <ReportFrame report={report} />;
}

function ThreadExplainAction({ threadId }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  return <button type="button" aria-label="Explain this thread" title="Explain this thread" className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => navigate.openThreadPanel({ actionId: "explainer", title: "Explainer", params: { scope: "thread" } })}>
    <span aria-hidden="true" className="text-base">✦</span>
  </button>;
}

function ExplainerDirective({ attributes, message }: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const reportId = attributes.id?.trim();
  const [report, setReport] = useState<Report | null>(null);
  useEffect(() => { if (reportId) void rpc.call("getReport", { reportId }).then(setReport); }, [reportId]);
  if (!reportId) return null;
  if (!report) return <button type="button" className="text-sm text-primary underline" onClick={() => navigate.openThreadPanel({ actionId: "explainer", title: "Explainer", params: { reportId } })}>Open explainer</button>;
  return <div className="my-3 overflow-hidden rounded-lg border border-border bg-background"><div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-sm"><span className="font-medium">{report.title}</span><button type="button" className="text-primary hover:underline" onClick={() => navigate.openThreadPanel({ actionId: "explainer", title: "Explainer", params: { reportId } })}>Open full explainer</button></div><div className="h-[560px]"><ReportFrame report={report} /></div></div>;
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({ id: "explainer", title: "Explainer", icon: "BookOpen", layout: "flush", component: ReportPanel });
  app.slots.experimental_threadHeaderAction({ id: "explain-thread", title: "Explain this thread", component: ThreadExplainAction });
  app.slots.messageAction({
    id: "explain-message",
    title: "Explain this",
    icon: "BookOpen",
    run: ({ threadId, message, selectedText, openPanel }) => {
      openPanel({ actionId: "explainer", title: selectedText ? "Explain selection" : "Explain this message", params: { scope: selectedText ? "selection" : "message", messageId: message.id, selectedText: selectedText ?? null } });
    },
  });
  app.slots.messageDirective({ id: "comprehension", component: ExplainerDirective });
});
