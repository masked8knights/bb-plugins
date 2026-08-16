import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { JsonValue, PluginMessageDirectiveProps, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { BriefSegment, ExplainerFormat, ReportContext, ReportJob, ReportJobStatus, ReportMeta, ReportProgressStatus, ReportRequest, ReportScope, rpcContract } from "./server";

type ReportParams = Partial<Omit<ReportRequest, "threadId">> & { reportId?: string };
type Report = ReportMeta & { html: string; selectedText: string | null; script: string | null; segments: BriefSegment[] };
type GenerationOverrides = { title?: string; focus?: string; messageId?: string; selectedText?: string };

const ACTIVE_JOB_STATUSES: ReportJobStatus[] = ["queued", "capturing", "starting-worker", "generating", "finalizing"];
const primaryButton = "inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton = "inline-flex items-center justify-center rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50";

function paramsOf(value: JsonValue | null): ReportParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as ReportParams;
}

function makeRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function isReportScope(value: unknown): value is ReportScope {
  return value === "thread" || value === "message" || value === "selection";
}

function isReportJobStatus(value: unknown): value is ReportJobStatus {
  return value === "queued" || value === "capturing" || value === "starting-worker" || value === "generating" || value === "finalizing" || value === "ready" || value === "error" || value === "cancelled";
}

function isReportProgressStatus(value: unknown): value is ReportProgressStatus {
  return isReportJobStatus(value);
}

function jobFromPayload(payload: unknown, threadId: string, jobId: string): ReportJob | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (value.threadId !== threadId || value.jobId !== jobId || !isReportScope(value.scope) || !isReportProgressStatus(value.status) || !isExplainerFormat(value.format)) return null;
  if (typeof value.label !== "string" || typeof value.detail !== "string" || typeof value.progress !== "number" || typeof value.step !== "number" || typeof value.totalSteps !== "number" || typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") return null;
  return {
    jobId,
    threadId,
    scope: value.scope,
    format: value.format,
    status: value.status,
    label: value.label,
    detail: value.detail,
    progress: Math.max(0, Math.min(100, Math.round(value.progress))),
    step: Math.max(0, Math.round(value.step)),
    totalSteps: Math.max(1, Math.round(value.totalSteps)),
    sourceSeqStart: typeof value.sourceSeqStart === "number" ? value.sourceSeqStart : null,
    sourceSeqEnd: typeof value.sourceSeqEnd === "number" ? value.sourceSeqEnd : null,
    sourceMessageStartId: typeof value.sourceMessageStartId === "string" ? value.sourceMessageStartId : null,
    sourceMessageEndId: typeof value.sourceMessageEndId === "string" ? value.sourceMessageEndId : null,
    sourceMessageCount: typeof value.sourceMessageCount === "number" ? value.sourceMessageCount : null,
    reportId: typeof value.reportId === "string" ? value.reportId : null,
    error: typeof value.error === "string" ? value.error : null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function scopeLabel(scope: ReportScope): string {
  if (scope === "thread") return "This thread";
  if (scope === "message") return "One message";
  return "Selected text";
}

function isExplainerFormat(value: unknown): value is ExplainerFormat {
  return value === "html" || value === "audio" || value === "podcast";
}

function formatLabel(format: ExplainerFormat): string {
  if (format === "audio") return "Audio briefing";
  if (format === "podcast") return "Podcast walkthrough";
  return "HTML explainer";
}

function formatDescription(format: ExplainerFormat): string {
  if (format === "audio") return "Listen to one narrator explain the important parts.";
  if (format === "podcast") return "Hear a host and explainer work through the changes together.";
  return "Read a structured explanation with context, decisions, and evidence.";
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function sourceCountLabel(value: Pick<ReportContext, "sourceMessageCount"> | Pick<ReportMeta, "sourceMessageCount">): string {
  if (value.sourceMessageCount <= 0) return "Older snapshot";
  return value.sourceMessageCount === 1 ? "1 message" : `${value.sourceMessageCount} messages`;
}

function currentSourceLabel(scope: ReportScope, value: Pick<ReportContext, "sourceMessageCount">): string {
  if (scope === "thread") return `${sourceCountLabel(value)} in the current thread`;
  if (scope === "message") return "One message from the current thread";
  return "The selected text from the current message";
}

function formatSavedAt(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(timestamp);
}

function buildRequest(threadId: string, scope: ReportScope, params: ReportParams, overrides: GenerationOverrides, format: ExplainerFormat = params.format ?? "html"): ReportRequest {
  const messageId = overrides.messageId ?? params.messageId;
  const selectedText = overrides.selectedText ?? params.selectedText;
  return {
    threadId,
    scope,
    format,
    ...(scope === "message" && messageId ? { messageId } : {}),
    ...(scope === "selection" ? {
      ...(messageId ? { messageId } : {}),
      ...(selectedText ? { selectedText } : {}),
    } : {}),
    ...((overrides.focus ?? params.focus) ? { focus: overrides.focus ?? params.focus } : {}),
    ...((overrides.title ?? params.title) ? { title: overrides.title ?? params.title } : {}),
  };
}

function overridesForReport(report: Report): GenerationOverrides {
  return {
    title: report.title,
    ...(report.focus ? { focus: report.focus } : {}),
    ...(report.messageId ? { messageId: report.messageId } : {}),
    ...(report.selectedText ? { selectedText: report.selectedText } : {}),
  };
}

function matchesContext(report: ReportMeta, context: ReportContext | null, params: ReportParams, overrides: GenerationOverrides): boolean {
  if (!context || report.scope !== context.scope) return false;
  return report.format === context.format
    && report.messageId === context.messageId
    && report.selectedTextHash === context.selectedTextHash
    && report.sourceSeqStart === context.sourceSeqStart
    && report.sourceSeqEnd === context.sourceSeqEnd
    && report.sourceMessageCount === context.sourceMessageCount
    && (report.focus ?? "") === (overrides.focus ?? params.focus ?? "")
    && report.title === context.title;
}

function QuietState({ children, error = false, action }: { children: ReactNode; error?: boolean; action?: ReactNode }) {
  return <div className={`flex h-full min-h-[360px] flex-col items-center justify-center gap-4 p-8 text-center text-sm ${error ? "text-destructive" : "text-muted-foreground"}`}>
    <p>{children}</p>
    {action}
  </div>;
}

function ReportFrame({ report, className = "h-full min-h-[720px]" }: { report: Report; className?: string }) {
  return <iframe title={report.title} sandbox="allow-scripts" srcDoc={report.html} className={`${className} w-full border-0 bg-background`} />;
}

function SourceOption({ selected, disabled, title, description, onSelect }: { selected: boolean; disabled?: boolean; title: string; description: string; onSelect: () => void }) {
  return <button type="button" aria-pressed={selected} disabled={disabled} onClick={onSelect} className={`w-full rounded-md border p-3 text-left transition-colors ${selected ? "border-primary bg-accent" : "border-border hover:bg-accent/60"} disabled:cursor-not-allowed disabled:opacity-50`}>
    <span className="flex items-center justify-between gap-3">
      <span className="font-medium text-foreground">{title}</span>
      {selected ? <span className="text-xs text-primary">Selected</span> : null}
    </span>
    <span className="mt-1 block text-sm leading-5 text-muted-foreground">{description}</span>
  </button>;
}

function FormatOption({ selected, title, description, onSelect }: { selected: boolean; title: string; description: string; onSelect: () => void }) {
  return <button type="button" aria-pressed={selected} onClick={onSelect} className={`flex min-h-[76px] w-full flex-col justify-center rounded-md border p-3 text-left transition-colors ${selected ? "border-primary bg-accent" : "border-border hover:bg-accent/60"}`}>
    <span className="flex items-center justify-between gap-3">
      <span className="font-medium text-foreground">{title}</span>
      {selected ? <span className="text-xs text-primary">Selected</span> : null}
    </span>
    <span className="mt-1 block text-sm leading-5 text-muted-foreground">{description}</span>
  </button>;
}

function SetupPanel({
  format,
  setFormat,
  scope,
  setScope,
  context,
  reports,
  matchingReport,
  messageAvailable,
  selectionAvailable,
  loading,
  busy,
  error,
  onGenerate,
  onOpenReport,
  onRefresh,
}: {
  format: ExplainerFormat;
  setFormat: (format: ExplainerFormat) => void;
  scope: ReportScope;
  setScope: (scope: ReportScope) => void;
  context: ReportContext | null;
  reports: ReportMeta[];
  matchingReport: ReportMeta | null;
  messageAvailable: boolean;
  selectionAvailable: boolean;
  loading: boolean;
  busy: boolean;
  error: string | null;
  onGenerate: (force: boolean) => void;
  onOpenReport: (reportId: string) => void;
  onRefresh: () => void;
}) {
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Make an explainer</h2>
        <p className="mt-1 text-sm text-muted-foreground">Choose how you want to understand this conversation.</p>
      </div>
      <button type="button" className={secondaryButton} onClick={onRefresh} disabled={loading} aria-label="Refresh explainer source and saved reports">Refresh</button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <fieldset>
        <legend className="mb-3 text-sm font-medium text-foreground">What do you want to make?</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          <FormatOption selected={format === "html"} title="HTML explainer" description={formatDescription("html")} onSelect={() => setFormat("html")} />
          <FormatOption selected={format === "audio"} title="Audio briefing" description={formatDescription("audio")} onSelect={() => setFormat("audio")} />
          <FormatOption selected={format === "podcast"} title="Podcast walkthrough" description={formatDescription("podcast")} onSelect={() => setFormat("podcast")} />
        </div>
      </fieldset>

      <fieldset className="mt-6">
        <legend className="mb-3 text-sm font-medium text-foreground">What should it cover?</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          <SourceOption selected={scope === "thread"} title="This thread" description="Use the current conversation." onSelect={() => setScope("thread")} />
          {messageAvailable ? <SourceOption selected={scope === "message"} title="One message" description="Focus on a single message." onSelect={() => setScope("message")} /> : null}
          {selectionAvailable ? <SourceOption selected={scope === "selection"} title="Selected text" description="Explain only the text you selected." onSelect={() => setScope("selection")} /> : null}
        </div>
        {!messageAvailable && !selectionAvailable ? <p className="mt-2 text-xs text-muted-foreground">To focus on one message or a selection, open Explainer from that message’s actions.</p> : null}
      </fieldset>

      <div className="mt-5 rounded-md border border-border bg-muted/40 p-4">
        <p className="text-sm font-medium text-foreground">Ready to create: {formatLabel(format)}</p>
        <p className="mt-1 text-sm text-muted-foreground">{loading ? "Reading the current conversation…" : context ? currentSourceLabel(scope, context) : "This source could not be read yet."}</p>
        {context ? <p className="mt-1 text-xs text-muted-foreground">This snapshot is saved with the explainer, so the same request can be reused later.</p> : null}
      </div>

      {error ? <div className="mt-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive" role="alert">{error}</div> : null}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button type="button" className={primaryButton} disabled={!context || busy || (scope === "message" && !messageAvailable) || (scope === "selection" && !selectionAvailable)} onClick={() => onGenerate(false)}>{busy ? "Starting…" : `Create ${formatLabel(format)}`}</button>
        {matchingReport ? <>
          <button type="button" className={secondaryButton} onClick={() => onOpenReport(matchingReport.reportId)}>Open existing</button>
          <button type="button" className={secondaryButton} disabled={busy} onClick={() => onGenerate(true)}>Create another</button>
        </> : null}
      </div>

      <section className="mt-8" aria-labelledby="saved-explainers-heading">
        <div className="flex items-baseline justify-between gap-4">
          <h3 id="saved-explainers-heading" className="text-sm font-medium text-foreground">Saved explainers</h3>
        </div>
        {reports.length ? <div className="mt-3 divide-y divide-border rounded-md border border-border">
          {reports.map((report) => <div key={report.reportId} className="flex items-center justify-between gap-4 p-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{report.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">{formatLabel(report.format)} · {scopeLabel(report.scope)} · {sourceCountLabel(report)} · Saved {formatSavedAt(report.createdAt)}</p>
            </div>
            <button type="button" className={secondaryButton} onClick={() => onOpenReport(report.reportId)}>Open</button>
          </div>)}
        </div> : <p className="mt-3 text-sm text-muted-foreground">No saved explainers for this thread yet.</p>}
      </section>
    </div>
  </div>;
}

function ExplainerProgress({ job, elapsedSeconds, busy, onStop, onBack, onRetry }: { job: ReportJob; elapsedSeconds: number; busy: boolean; onStop: () => void; onBack: () => void; onRetry: () => void }) {
  const active = ACTIVE_JOB_STATUSES.includes(job.status);
  const stopped = job.status === "cancelled";
  const failed = job.status === "error";
  const heading = stopped ? "Generation stopped" : failed ? "Explainer failed" : job.status === "ready" ? "Opening explainer" : "Creating explainer";
  const range = job.sourceSeqStart !== null && job.sourceSeqEnd !== null && job.sourceMessageCount !== null
    ? `${sourceCountLabel({ sourceMessageCount: job.sourceMessageCount })} captured`
    : null;
  return <div className="flex h-full min-h-[360px] items-center justify-center p-8">
    <div className="w-full max-w-md space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">{formatLabel(job.format)} · {scopeLabel(job.scope)}</p>
          {range ? <p className="mt-1 text-xs text-muted-foreground">{range}</p> : null}
          <h2 className="mt-1 text-lg font-semibold text-foreground">{heading}</h2>
        </div>
        <span className="text-sm tabular-nums text-muted-foreground">~{Math.round(job.progress)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Explainer progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress)}>
        <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${job.progress}%` }} />
      </div>
      <div className="space-y-2" aria-live="polite">
        <div className="flex items-center gap-2">
          {active ? <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-primary" /> : null}
          <p className="font-medium text-foreground">{job.label}</p>
        </div>
        <p className="text-sm leading-6 text-muted-foreground">{failed ? job.error ?? job.detail : job.detail}</p>
      </div>
      <div className="flex items-center justify-between gap-4 border-t border-border pt-3 text-xs text-muted-foreground">
        <span>Step {Math.min(job.step, job.totalSteps)} of {job.totalSteps}</span>
        <span className="tabular-nums">Elapsed {formatElapsed(elapsedSeconds)}</span>
      </div>
      {active ? <div className="flex flex-wrap gap-2">
        <button type="button" className={secondaryButton} onClick={onStop} disabled={busy}>Stop generation</button>
        <button type="button" className={secondaryButton} onClick={onBack} disabled={busy}>Back</button>
      </div> : <div className="flex flex-wrap gap-2">
        {failed || stopped ? <button type="button" className={primaryButton} onClick={onRetry} disabled={busy}>Try again</button> : null}
        <button type="button" className={secondaryButton} onClick={onBack} disabled={busy}>Back to setup</button>
      </div>}
    </div>
  </div>;
}

function assetUrl(assetId: string): string {
  return `/api/v1/plugins/comprehension/http/assets/${encodeURIComponent(assetId)}`;
}

function reportSegments(report: Report): BriefSegment[] {
  if (report.segments.length) return report.segments;
  return report.script ? [{ startMs: 0, endMs: Number.MAX_SAFE_INTEGER, role: "narrator", text: report.script }] : [];
}

function segmentRoleLabel(role: BriefSegment["role"]): string {
  if (role === "host") return "Host";
  if (role === "explainer") return "Explainer";
  return "Narrator";
}

function AudioReport({ report }: { report: Report }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const segments = reportSegments(report);
  const updateActiveSegment = useCallback(() => {
    const currentMs = (audioRef.current?.currentTime ?? 0) * 1_000;
    const index = segments.findIndex((segment) => currentMs >= segment.startMs && currentMs < segment.endMs);
    if (index >= 0) setActiveIndex(index);
  }, [segments]);
  if (!report.assetId) return <QuietState error>This audio briefing has no cached audio asset.</QuietState>;
  return <div className="h-full overflow-y-auto p-5">
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="rounded-xl border border-border bg-muted/30 p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Audio briefing</p>
        <h3 className="mt-2 text-xl font-semibold text-foreground">Listen for the shape of the work</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">A single narrator summarizes the source range. The transcript stays visible so you can scan or jump back into the details.</p>
        <audio ref={audioRef} className="mt-5 w-full" controls preload="metadata" src={assetUrl(report.assetId)} onTimeUpdate={updateActiveSegment} />
      </div>
      <section aria-labelledby="audio-transcript-heading">
        <div className="flex items-baseline justify-between gap-3">
          <h3 id="audio-transcript-heading" className="text-sm font-semibold text-foreground">Transcript</h3>
          {report.durationMs ? <span className="text-xs text-muted-foreground">{formatElapsed(Math.round(report.durationMs / 1_000))}</span> : null}
        </div>
        <div className="mt-3 space-y-2">
          {segments.map((segment, index) => <button key={`${segment.startMs}-${index}`} type="button" onClick={() => { if (audioRef.current) { audioRef.current.currentTime = segment.startMs / 1_000; void audioRef.current.play().catch(() => undefined); } setActiveIndex(index); }} className={`w-full rounded-lg border p-4 text-left transition-colors ${activeIndex === index ? "border-primary bg-accent" : "border-border hover:bg-accent/60"}`} aria-current={activeIndex === index ? "true" : undefined}>
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{segmentRoleLabel(segment.role)}</span>
            <span className="mt-2 block text-sm leading-6 text-foreground">{segment.text}</span>
          </button>)}
        </div>
      </section>
    </div>
  </div>;
}

function PodcastReport({ report }: { report: Report }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const segments = reportSegments(report);
  const updateActiveSegment = useCallback(() => {
    const currentMs = (audioRef.current?.currentTime ?? 0) * 1_000;
    const index = segments.findIndex((segment) => currentMs >= segment.startMs && currentMs < segment.endMs);
    if (index >= 0) setActiveIndex(index);
  }, [segments]);
  const activeSegment = segments[activeIndex] ?? segments[0];
  if (!report.assetId || !activeSegment) return <QuietState error>This podcast walkthrough has no cached audio asset or transcript.</QuietState>;
  return <div className="h-full overflow-y-auto p-5">
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="rounded-xl border border-border bg-muted/30 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Podcast walkthrough</p>
            <h3 className="mt-2 text-xl font-semibold text-foreground">A conversation about what changed</h3>
          </div>
          <span className="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">{activeIndex + 1} / {segments.length}</span>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <div className={`rounded-lg border p-4 ${activeSegment.role === "host" ? "border-primary bg-accent" : "border-border"}`}>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Host</p>
            <p className="mt-2 text-sm leading-6 text-foreground">Asks what a returning engineer needs to know.</p>
          </div>
          <div className={`rounded-lg border p-4 ${activeSegment.role === "explainer" ? "border-primary bg-accent" : "border-border"}`}>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Explainer</p>
            <p className="mt-2 text-sm leading-6 text-foreground">Connects the decision to evidence in the source.</p>
          </div>
        </div>
        <div className="mt-5 rounded-lg border border-primary/40 bg-background p-5" aria-live="polite">
          <p className="text-xs font-medium uppercase tracking-wide text-primary">{segmentRoleLabel(activeSegment.role)}</p>
          <p className="mt-3 text-lg leading-8 text-foreground">{activeSegment.text}</p>
        </div>
        <audio ref={audioRef} className="mt-5 w-full" controls preload="metadata" src={assetUrl(report.assetId)} onTimeUpdate={updateActiveSegment} />
      </div>
      <section aria-labelledby="podcast-chapters-heading">
        <div className="flex items-baseline justify-between gap-3">
          <h3 id="podcast-chapters-heading" className="text-sm font-semibold text-foreground">Chapters and captions</h3>
          {report.durationMs ? <span className="text-xs text-muted-foreground">{formatElapsed(Math.round(report.durationMs / 1_000))}</span> : null}
        </div>
        <div className="mt-3 space-y-2">
          {segments.map((segment, index) => <button key={`${segment.startMs}-${index}`} type="button" onClick={() => { if (audioRef.current) { audioRef.current.currentTime = segment.startMs / 1_000; void audioRef.current.play().catch(() => undefined); } setActiveIndex(index); }} className={`flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors ${activeIndex === index ? "border-primary bg-accent" : "border-border hover:bg-accent/60"}`} aria-current={activeIndex === index ? "true" : undefined}>
            <span className="mt-0.5 w-8 shrink-0 text-xs tabular-nums text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
            <span className="min-w-0">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{segmentRoleLabel(segment.role)}</span>
              <span className="mt-2 block text-sm leading-6 text-foreground">{segment.text}</span>
            </span>
          </button>)}
        </div>
      </section>
    </div>
  </div>;
}

function ReportView({ report, busy, onNew, onRegenerate }: { report: Report; busy: boolean; onNew: () => void; onRegenerate: () => void }) {
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-foreground">{report.title}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{formatLabel(report.format)} · {scopeLabel(report.scope)} · {sourceCountLabel(report)} · Saved {formatSavedAt(report.createdAt)}</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <button type="button" className={secondaryButton} onClick={onNew}>New explainer</button>
        <button type="button" className={primaryButton} onClick={onRegenerate} disabled={busy}>{busy ? "Starting…" : "Regenerate"}</button>
      </div>
    </div>
    <div className="min-h-0 flex-1">{report.format === "audio" ? <AudioReport report={report} /> : report.format === "podcast" ? <PodcastReport report={report} /> : <ReportFrame report={report} className="h-full min-h-0" />}</div>
  </div>;
}

function ReportPanel({ threadId, params }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const request = paramsOf(params);
  const paramsKey = JSON.stringify(params);
  const messageAvailable = Boolean(request.messageId);
  const selectionAvailable = Boolean(request.selectedText);
  const requestedScope = request.scope ?? "thread";
  const initialScope = requestedScope === "message" && !messageAvailable || requestedScope === "selection" && !selectionAvailable ? "thread" : requestedScope;
  const initialFormat = isExplainerFormat(request.format) ? request.format : "html";
  const [format, setFormat] = useState<ExplainerFormat>(initialFormat);
  const [scope, setScope] = useState<ReportScope>(initialScope);
  const [overrides, setOverrides] = useState<GenerationOverrides>({});
  const [context, setContext] = useState<ReportContext | null>(null);
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [job, setJob] = useState<ReportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingSetup, setLoadingSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [setupNonce, setSetupNonce] = useState(0);
  const requestId = useMemo(() => makeRequestId(), [threadId, paramsKey, scope, format]);
  const activeRequest = useMemo(() => buildRequest(threadId, scope, request, overrides, format), [threadId, scope, format, request.messageId, request.selectedText, request.focus, request.title, overrides.focus, overrides.title, overrides.messageId, overrides.selectedText]);
  const activeRequestKey = JSON.stringify(activeRequest);
  const activeJobId = job?.jobId ?? null;
  const activeJob = Boolean(job && ACTIVE_JOB_STATUSES.includes(job.status));
  const elapsedSeconds = job ? Math.max(0, Math.floor((now - job.createdAt) / 1000)) : 0;
  const matchingReport = reports.find((candidate) => matchesContext(candidate, context, request, overrides)) ?? null;

  const handleRealtime = useCallback((payload: unknown) => {
    if (!activeJobId) return;
    const next = jobFromPayload(payload, threadId, activeJobId);
    if (next) setJob(next);
  }, [activeJobId, threadId]);
  useRealtime("comprehension", handleRealtime);

  useEffect(() => {
    setScope(initialScope);
    setFormat(initialFormat);
    setOverrides({});
    setReport(null);
    setJob(null);
    setError(null);
    setSetupNonce((value) => value + 1);
  }, [threadId, paramsKey, initialScope, initialFormat]);

  useEffect(() => {
    const reportId = request.reportId;
    if (!reportId) return;
    let cancelled = false;
    setBusy(true);
    void rpc.call("getReport", { reportId }).then((result) => {
      if (cancelled) return;
      if (!result) throw new Error("This explainer is no longer available");
      setReport(result);
      setScope(result.scope);
      setFormat(result.format);
      setOverrides(overridesForReport(result));
    }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to load explainer"); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [threadId, paramsKey, request.reportId]);

  useEffect(() => {
    if (request.reportId) return;
    let cancelled = false;
    setLoadingSetup(true);
    setContext(null);
    setReports([]);
    const sourceRequest = buildRequest(threadId, scope, request, overrides, format);
    void rpc.call("listReports", { threadId }).then((result) => { if (!cancelled) setReports(result); }).catch(() => undefined);
    void rpc.call("getReportContext", sourceRequest).then((result) => { if (!cancelled) setContext(result); }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to read the current source"); }).finally(() => { if (!cancelled) setLoadingSetup(false); });
    void rpc.call("getActiveJob", { ...sourceRequest, requestId }).then((result) => { if (!cancelled && result) setJob(result); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [threadId, paramsKey, request.reportId, scope, format, activeRequestKey, setupNonce]);

  useEffect(() => {
    if (!job || !ACTIVE_JOB_STATUSES.includes(job.status)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [job?.jobId, job?.status]);

  useEffect(() => {
    if (!job || !ACTIVE_JOB_STATUSES.includes(job.status)) return;
    let cancelled = false;
    const poll = () => { void rpc.call("getReportJob", { jobId: job.jobId }).then((result) => { if (!cancelled && result) setJob(result); }).catch(() => undefined); };
    poll();
    const timer = window.setInterval(poll, 1_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [job?.jobId, job?.status]);

  useEffect(() => {
    if (!job || job.status !== "ready" || !job.reportId) return;
    let cancelled = false;
    setBusy(true);
    void rpc.call("getReport", { reportId: job.reportId }).then((result) => {
      if (cancelled) return;
      if (!result) throw new Error("The finished explainer could not be loaded");
      setReport(result);
      setOverrides(overridesForReport(result));
      void rpc.call("listReports", { threadId }).then(setReports).catch(() => undefined);
    }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to load explainer"); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [job?.jobId, job?.status, job?.reportId, threadId]);

  const openReport = useCallback(async (reportId: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("getReport", { reportId });
      if (!result) throw new Error("This explainer is no longer available");
      setReport(result);
      setJob(null);
      setScope(result.scope);
      setFormat(result.format);
      setOverrides(overridesForReport(result));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load explainer");
    } finally {
      setBusy(false);
    }
  }, [rpc]);

  const generate = useCallback(async (force: boolean) => {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const result = await rpc.call("startReport", { ...activeRequest, requestId: makeRequestId(), force });
      setJob(result.job);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to start explainer");
    } finally {
      setBusy(false);
    }
  }, [activeRequest, rpc]);

  const stop = useCallback(async () => {
    if (!job) return;
    setBusy(true);
    try {
      const result = await rpc.call("stopReport", { jobId: job.jobId });
      if (result) setJob(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to stop explainer");
    } finally {
      setBusy(false);
    }
  }, [job, rpc]);

  const backToSetup = useCallback(() => {
    setJob(null);
    setReport(null);
    setError(null);
    setOverrides({});
    setFormat(initialFormat);
    setSetupNonce((value) => value + 1);
  }, [initialFormat]);

  const refreshSetup = useCallback(() => {
    setError(null);
    setSetupNonce((value) => value + 1);
  }, []);

  if (request.reportId && !report) {
    return error ? <QuietState error action={<button type="button" className={secondaryButton} onClick={backToSetup}>Back to setup</button>}>{error}</QuietState> : <QuietState>Loading explainer…</QuietState>;
  }
  if (report && !activeJob) return <ReportView report={report} busy={busy} onNew={backToSetup} onRegenerate={() => generate(true)} />;
  if (job) return <ExplainerProgress job={job} elapsedSeconds={elapsedSeconds} busy={busy} onStop={stop} onBack={backToSetup} onRetry={() => generate(false)} />;
  return <SetupPanel format={format} setFormat={(next) => { setFormat(next); setError(null); }} scope={scope} setScope={(next) => { setScope(next); setError(null); }} context={context} reports={reports} matchingReport={matchingReport} messageAvailable={messageAvailable} selectionAvailable={selectionAvailable} loading={loadingSetup} busy={busy} error={error} onGenerate={generate} onOpenReport={openReport} onRefresh={refreshSetup} />;
}

function ExplainerDirective({ attributes }: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const reportId = attributes.id?.trim();
  const [report, setReport] = useState<Report | null>(null);
  useEffect(() => { if (reportId) void rpc.call("getReport", { reportId }).then(setReport); }, [reportId, rpc]);
  if (!reportId) return null;
  if (!report) return <button type="button" className="text-sm text-primary underline" onClick={() => navigate.openThreadPanel({ actionId: "explainer", title: "Explainer", params: { reportId } })}>Open explainer</button>;
  return <div className="my-3 overflow-hidden rounded-lg border border-border bg-background"><div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-sm"><span className="font-medium">{report.title}</span><button type="button" className="text-primary hover:underline" onClick={() => navigate.openThreadPanel({ actionId: "explainer", title: "Explainer", params: { reportId } })}>Open full explainer</button></div><div className="h-[560px]">{report.format === "audio" ? <AudioReport report={report} /> : report.format === "podcast" ? <PodcastReport report={report} /> : <ReportFrame report={report} className="h-full min-h-0" />}</div></div>;
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({ id: "explainer", title: "Explainer", icon: "BookOpen", layout: "flush", component: ReportPanel });
  app.slots.messageAction({
    id: "explain-message",
    title: "Explain this",
    icon: "BookOpen",
    run: ({ threadId, message, selectedText, openPanel }) => {
      openPanel({ actionId: "explainer", title: selectedText ? "Explain selection" : "Explain this message", params: { scope: selectedText ? "selection" : "message", threadId, messageId: message.id, selectedText: selectedText ?? null } });
    },
  });
  app.slots.messageDirective({ id: "comprehension", component: ExplainerDirective });
});
