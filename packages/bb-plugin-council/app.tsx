import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  Markdown,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type MemberDto = {
  id: string;
  name: string;
  persona: string;
  providerId: string | null;
  model: string | null;
  reasoningLevel: string | null;
  isChief: boolean;
  enabled: boolean;
  createdAtMs: number;
};

type SessionSummaryDto = {
  id: string;
  proposalExcerpt: string;
  status: "running" | "completed" | "failed";
  support: number;
  oppose: number;
  abstain: number;
  createdAtMs: number;
  completedAtMs: number | null;
};

type TurnDto = {
  id: string;
  seq: number;
  phase: "consideration" | "discussion" | "verdict";
  round: number | null;
  memberId: string | null;
  memberName: string;
  stance: "support" | "oppose" | "abstain" | "pass" | null;
  comment: string;
  createdAtMs: number;
};

type SessionDetailDto = {
  id: string;
  proposal: string;
  context: string | null;
  status: "running" | "completed" | "failed";
  consensusMode: string;
  maxRounds: number;
  verdict: string | null;
  dissent: string | null;
  error: string | null;
  support: number;
  oppose: number;
  abstain: number;
  activeMembers: number;
  totalMembers: number;
  createdAtMs: number;
  completedAtMs: number | null;
  turns: TurnDto[];
  roster: { memberId: string; memberName: string; status: "ok" | "recused" }[];
  votes: { memberId: string; memberName: string; stance: "support" | "oppose" | "abstain" }[];
  evidence: {
    memberId: string;
    memberName: string;
    kind: string;
    title: string;
    result: string | null;
  }[];
};

type ProviderDto = { id: string; displayName: string; available: boolean };
type ModelDto = { model: string; displayName: string; providerId: string | null };

const inputClass =
  "w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-ring";

const fieldLabel = "mb-1 block text-xs font-medium text-muted-foreground";

function StatusPill({ status }: { status: "running" | "completed" | "failed" }) {
  const tone =
    status === "completed"
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      : status === "failed"
        ? "bg-red-500/15 text-red-600 dark:text-red-400"
        : "bg-blue-500/15 text-blue-600 dark:text-blue-400";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {status}
    </span>
  );
}

function StanceBadge({
  stance,
}: {
  stance: "support" | "oppose" | "abstain" | "pass" | null;
}) {
  if (!stance) return null;
  const tone =
    stance === "support"
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      : stance === "oppose"
        ? "bg-red-500/15 text-red-600 dark:text-red-400"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>
      {stance}
    </span>
  );
}

function TallyChips({
  support,
  oppose,
  abstain,
}: {
  support: number;
  oppose: number;
  abstain: number;
}) {
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="text-emerald-600 dark:text-emerald-400">{support} support</span>
      <span className="text-red-600 dark:text-red-400">{oppose} oppose</span>
      <span>{abstain} abstain</span>
    </span>
  );
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function MemberEditor(props: {
  open: boolean;
  member: MemberDto | null;
  providers: ProviderDto[];
  models: ModelDto[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [providerId, setProviderId] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [reasoningLevel, setReasoningLevel] = useState<string>("");
  const [isChief, setIsChief] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setName(props.member?.name ?? "");
    setPersona(props.member?.persona ?? "");
    setProviderId(props.member?.providerId ?? "");
    setModel(props.member?.model ?? "");
    setReasoningLevel(props.member?.reasoningLevel ?? "");
    setIsChief(props.member?.isChief ?? false);
    setEnabled(props.member?.enabled ?? true);
    setError(null);
  }, [props.open, props.member]);

  const modelSuggestions = useMemo(() => {
    const pool = providerId
      ? props.models.filter(
          (entry) => entry.providerId === providerId || entry.providerId === null,
        )
      : props.models;
    return [...new Set(pool.map((entry) => entry.model))];
  }, [props.models, providerId]);

  async function save() {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await rpc.call("upsertMember", {
        id: props.member?.id,
        name: name.trim(),
        persona,
        providerId: providerId || null,
        model: model || null,
        reasoningLevel: reasoningLevel || null,
        isChief,
        enabled,
      });
      props.onSaved();
      props.onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(next) => !next && props.onClose()}>
      <DialogContent className="max-w-lg space-y-4">
        <DialogHeader>
          <DialogTitle>{props.member ? "Edit member" : "Add council member"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className={fieldLabel}>Name</label>
            <input
              className={inputClass}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Skeptic"
            />
          </div>
          <div>
            <label className={fieldLabel}>Persona instructions</label>
            <textarea
              className={`${inputClass} min-h-24`}
              value={persona}
              onChange={(event) => setPersona(event.target.value)}
              placeholder="How this member thinks and argues."
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={fieldLabel}>Provider</label>
              <select
                className={inputClass}
                value={providerId}
                onChange={(event) => setProviderId(event.target.value)}
              >
                <option value="">(project default)</option>
                {props.providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.displayName}
                    {provider.available ? "" : " (unavailable)"}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={fieldLabel}>Model</label>
              <input
                className={inputClass}
                value={model}
                onChange={(event) => setModel(event.target.value)}
                list="council-models"
                placeholder="(provider default)"
              />
              <datalist id="council-models">
                {modelSuggestions.map((candidate) => (
                  <option key={candidate} value={candidate} />
                ))}
              </datalist>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={fieldLabel}>Reasoning level</label>
              <select
                className={inputClass}
                value={reasoningLevel}
                onChange={(event) => setReasoningLevel(event.target.value)}
              >
                <option value="">(provider default)</option>
                {["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"].map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col justify-end gap-2 pb-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isChief}
                  onChange={(event) => setIsChief(event.target.checked)}
                />
                Chief justice (writes the verdict)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
                Enabled
              </label>
            </div>
          </div>
          {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={props.onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MembersTab() {
  const rpc = useRpc<typeof rpcContract>();
  const [members, setMembers] = useState<MemberDto[]>([]);
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [models, setModels] = useState<ModelDto[]>([]);
  const [editing, setEditing] = useState<MemberDto | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    const [memberResult, providerResult, modelResult] = await Promise.all([
      rpc.call("listMembers", null),
      rpc.call("listProviders", null),
      rpc.call("listModels", null),
    ]);
    setMembers(memberResult.members);
    setProviders(providerResult.providers);
    setModels(modelResult.models);
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function remove(id: string) {
    await rpc.call("deleteMember", { id });
    void refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          One member should be chief justice; they write the final report.
        </p>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          Add member
        </Button>
      </div>
      {members.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No members yet. Add at least one so agents can convene the council.
          </CardContent>
        </Card>
      ) : (
        members.map((member) => (
          <Card key={member.id}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                {member.name}
                {member.isChief ? (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                    chief
                  </span>
                ) : null}
                {!member.enabled ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    disabled
                  </span>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="line-clamp-2 text-sm text-muted-foreground">
                {member.persona || "No persona instructions."}
              </p>
              <p className="text-xs text-muted-foreground">
                {[member.providerId ?? "project default", member.model ?? "default model", member.reasoningLevel ?? "default reasoning"]
                  .join(" · ")}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditing(member);
                    setOpen(true);
                  }}
                >
                  Edit
                </Button>
                <Button size="sm" variant="outline" onClick={() => void remove(member.id)}>
                  Delete
                </Button>
              </div>
            </CardContent>
          </Card>
        ))
      )}
      <MemberEditor
        open={open}
        member={editing}
        providers={providers}
        models={models}
        onClose={() => setOpen(false)}
        onSaved={() => void refresh()}
      />
    </div>
  );
}

function StartConversationButton(props: { onStarted: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const bbContext = useBbContext();
  const [open, setOpen] = useState(false);
  const [proposal, setProposal] = useState("");
  const [context, setContext] = useState("");
  const [preset, setPreset] = useState("");
  const [presets, setPresets] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    rpc
      .call("listPresets", null)
      .then((result) => setPresets(result.presets.map((p) => p.name)))
      .catch(() => setPresets([]));
  }, [open, rpc]);

  async function submit() {
    if (!proposal.trim()) {
      setError("A proposal is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("startConversation", {
        proposal: proposal.trim(),
        context: context.trim() || undefined,
        projectId: bbContext.projectId ?? undefined,
        preset: preset.trim() || undefined,
      });
      setOpen(false);
      setProposal("");
      setContext("");
      setPreset("");
      props.onStarted();
      navigate.toThread(result.threadId);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Start a council conversation
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ask the council</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Starts a new thread whose agent presents your proposal to the
              council and reports back the verdict.
            </p>
            <textarea
              className={`${inputClass} min-h-20`}
              value={proposal}
              onChange={(event) => setProposal(event.target.value)}
              placeholder="Proposal for the council…"
              autoFocus
            />
            <textarea
              className={`${inputClass} min-h-14`}
              value={context}
              onChange={(event) => setContext(event.target.value)}
              placeholder="Optional context…"
            />
            <input
              className={inputClass}
              value={preset}
              onChange={(event) => setPreset(event.target.value)}
              placeholder="Optional council preset…"
              list="council-preset-options"
            />
            <datalist id="council-preset-options">
              {presets.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            {error ? (
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={() => void submit()} disabled={busy}>
                {busy ? "Starting…" : "Start conversation"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SessionsList(props: { refreshKey: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [sessions, setSessions] = useState<SessionSummaryDto[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    const result = await rpc.call("listSessions", null);
    setSessions(result.sessions);
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh, props.refreshKey]);

  async function remove(sessionId: string) {
    setDeleting(true);
    try {
      await rpc.call("deleteSession", { id: sessionId });
      setConfirmingDelete(null);
      await refresh();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-3">
      <StartConversationButton onStarted={() => void refresh()} />
      {sessions.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No sessions yet. Start a council conversation above, or ask any
            agent to call council_deliberate.
          </CardContent>
        </Card>
      ) : (
        sessions.map((session) => (
          <div
            key={session.id}
            className="flex w-full items-stretch gap-2 rounded-lg border border-border transition-colors hover:bg-accent"
          >
            <button
              className="min-w-0 flex-1 p-3 text-left"
              onClick={() =>
                navigate.toPluginPanel("council", { subPath: `session/${session.id}` })
              }
            >
              <div className="flex items-center justify-between gap-2">
                <StatusPill status={session.status} />
                <span className="text-xs text-muted-foreground">
                  {formatTime(session.createdAtMs)}
                </span>
              </div>
              <p className="mt-2 line-clamp-2 text-sm">{session.proposalExcerpt}</p>
              <div className="mt-2">
                <TallyChips
                  support={session.support}
                  oppose={session.oppose}
                  abstain={session.abstain}
                />
              </div>
            </button>
            <div className="flex items-center pr-2">
              {confirmingDelete === session.id ? (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={deleting}
                  onClick={() => void remove(session.id)}
                >
                  {deleting ? "…" : "Confirm delete"}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete session ${session.id}`}
                  onClick={() => setConfirmingDelete(session.id)}
                >
                  Delete
                </Button>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

type TabId = "overview" | "members" | "materials";

function duration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

const STANCE_COLOR: Record<string, string> = {
  support: "text-emerald-500",
  oppose: "text-red-400",
  abstain: "text-amber-400",
};

function StanceDots({ stance, final }: { stance: string | null; final?: boolean }) {
  if (!stance) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${STANCE_COLOR[stance] ?? ""}`}>
      <span
        className={`inline-block h-2 w-2 rounded-full bg-current ${final ? "ring-2 ring-current/30" : ""}`}
      />
      {stance}
    </span>
  );
}

function MemberChip({
  name,
  onClick,
}: {
  name: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center rounded-full border border-border bg-secondary px-2 py-0.5 text-[11px] font-semibold text-secondary-foreground hover:bg-accent"
    >
      {name}
    </button>
  );
}

function PhaseSpine({ session }: { session: SessionDetailDto }) {
  const turns = session.turns;
  const okIds = new Set(
    session.roster.filter((r) => r.status === "ok").map((r) => r.memberId),
  );
  const considerationDone = okIds.size > 0 &&
    [...okIds].every((id) =>
      turns.some((t) => t.phase === "consideration" && t.memberId === id && t.stance !== null),
    );
  const rounds = [
    ...new Set(
      turns.filter((t) => t.phase === "discussion" && t.round !== null).map((t) => t.round as number),
    ),
  ].sort((a, b) => a - b);
  const researchCalls = session.evidence.length;

  const steps: { name: string; meta: string; done: boolean }[] = [];
  steps.push({
    name: "Consideration",
    meta:
      researchCalls > 0
        ? `${researchCalls} research call${researchCalls === 1 ? "" : "s"}`
        : "no research recorded",
    done: considerationDone,
  });
  rounds.forEach((round) => {
    const replies = turns.filter((t) => t.phase === "discussion" && t.round === round).length;
    steps.push({ name: `Discussion R${round}`, meta: `${replies} replies`, done: true });
  });
  const verdictDone = Boolean(session.verdict) || turns.some((t) => t.phase === "verdict");
  steps.push({
    name: "Verdict",
    meta: verdictDone ? "report written" : "waiting",
    done: verdictDone,
  });

  return (
    <ol className="mt-4 flex flex-col gap-0 sm:flex-row">
      {steps.map((step, i) => (
        <li key={step.name} className="flex flex-1 items-start gap-3 sm:flex-col sm:gap-1">
          <div className="flex items-center sm:w-full">
            <span
              className={`relative z-10 inline-block h-3 w-3 shrink-0 rounded-full border-2 border-background ${
                step.done ? "bg-emerald-500" : "bg-muted"
              }`}
            />
            {i < steps.length - 1 ? (
              <span className={`h-px flex-1 ${step.done ? "bg-emerald-500/60" : "bg-border"}`} />
            ) : null}
          </div>
          <div className="pb-3">
            <p className="text-xs font-semibold">{step.name}</p>
            <p className="text-[11px] text-muted-foreground">{step.meta}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function StanceMatrix({
  session,
  onOpenMember,
}: {
  session: SessionDetailDto;
  onOpenMember: (memberId: string) => void;
}) {
  const turns = session.turns;
  const votesByMember = new Map(session.votes.map((v) => [v.memberId, v.stance]));
  const active = session.roster.filter((r) => r.status === "ok");
  const rounds = [
    ...new Set(
      turns.filter((t) => t.phase === "discussion" && t.round !== null).map((t) => t.round as number),
    ),
  ].sort((a, b) => a - b);

  function trail(memberId: string): (string | null)[] {
    const out: (string | null)[] = [];
    const consider = turns.find(
      (t) => t.phase === "consideration" && t.memberId === memberId && t.stance !== null,
    );
    out.push(consider?.stance ?? null);
    for (let round = 1; round <= rounds.length; round++) {
      const latest = turns
        .filter(
          (t) =>
            t.phase === "discussion" &&
            t.memberId === memberId &&
            t.stance !== null &&
            ((t.round ?? 0) <= round),
        )
        .sort((a, b) => a.seq - b.seq)
        .at(-1);
      out.push(latest?.stance ?? out[out.length - 1]);
    }
    return out;
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-foreground">
          <th className="py-1.5 pr-2 font-semibold">Member</th>
          <th className="py-1.5 pr-2 font-semibold">Consider</th>
          {rounds.map((round) => (
            <th key={round} className="py-1.5 pr-2 font-semibold">R{round}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {active.map((entry) => {
          const trailCells = trail(entry.memberId);
          const finalStance = votesByMember.get(entry.memberId);
          return (
            <tr key={entry.memberId} className="border-b border-border/50 last:border-b-0">
              <td className="py-2 pr-2">
                <MemberChip name={entry.memberName} onClick={() => onOpenMember(entry.memberId)} />
              </td>
              {trailCells.map((stance, i) => {
                const changed = i > 0 && stance !== null && trailCells[i - 1] !== stance;
                const isLast = i === trailCells.length - 1;
                return (
                  <td key={i} className="py-2 pr-2 whitespace-nowrap">
                    <StanceDots stance={stance} final={isLast && finalStance != null} />
                    {changed ? <span className="ml-1 font-mono text-[10px] text-amber-400">▲</span> : null}
                  </td>
                );
              })}
              {!finalStance ? null : (
                <td className="py-2 text-right font-mono text-[10px] text-muted-foreground">voted</td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SessionDetail(props: { sessionId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [session, setSession] = useState<SessionDetailDto | null>(null);
  const [missing, setMissing] = useState(false);
  const [tab, setTab] = useState<TabId>("overview");
  const [activeMemberId, setActiveMemberId] = useState<string | null>(null);
  const [highlightTitle, setHighlightTitle] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const load = async () => {
      try {
        const result = await rpc.call("getSession", { id: props.sessionId });
        if (!cancelled) setSession(result);
        return result.status;
      } catch {
        if (!cancelled) setMissing(true);
        return "failed" as const;
      }
    };
    void load().then((status) => {
      if (status === "running" && !cancelled) {
        timer = setInterval(() => {
          void load().then((next) => {
            if (next !== "running" && timer) {
              clearInterval(timer);
              timer = null;
            }
          });
        }, 2500);
      }
    });
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [rpc, props.sessionId]);

  if (missing) {
    return <p className="text-sm text-muted-foreground">Session not found.</p>;
  }
  if (!session) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const turns = session.turns;
  const votesByMember = new Map(session.votes.map((v) => [v.memberId, v.stance]));
  const activeRoster = session.roster.filter((r) => r.status === "ok");
  const selectedMemberId =
    activeMemberId && activeRoster.some((r) => r.memberId === activeMemberId)
      ? activeMemberId
      : (activeRoster[0]?.memberId ?? null);
  const memberEvidence = session.evidence.filter(
    (e) => e.memberId === selectedMemberId,
  );
  const memberTurns = turns
    .filter((t) => t.memberId === selectedMemberId && t.phase !== "verdict")
    .sort((a, b) => {
      const rank = (phase: string, round: number | null) =>
        phase === "consideration" ? -1 : (round ?? 999);
      return rank(a.phase, a.round) - rank(b.phase, b.round) || a.seq - b.seq;
    });
  const chiefTurn = turns.find((t) => t.phase === "verdict");

  // Materials ledger: group evidence by artifact title across members.
  const ledger = new Map<
    string,
    { kind: string; title: string; finding: string; citedBy: { memberId: string; memberName: string }[] }
  >();
  for (const item of session.evidence) {
    const entry = ledger.get(item.title) ?? {
      kind: item.kind,
      title: item.title,
      finding: item.result ?? "",
      citedBy: [],
    };
    if (!entry.finding && item.result) entry.finding = item.result;
    if (!entry.citedBy.some((c) => c.memberId === item.memberId)) {
      entry.citedBy.push({ memberId: item.memberId, memberName: item.memberName });
    }
    ledger.set(item.title, entry);
  }
  const ledgerRows = [...ledger.values()];

  function openMember(memberId: string) {
    setActiveMemberId(memberId);
    setTab("members");
  }
  function openMaterial(title: string) {
    setHighlightTitle(title);
    setTab("materials");
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "members", label: "Members" },
    { id: "materials", label: "Materials" },
  ];

  return (
    <div className="space-y-4">
      <Button
        size="sm"
        variant="ghost"
        className="-ml-2"
        onClick={() => navigate.toPluginPanel("council", { subPath: "" })}
      >
        ← All sessions
      </Button>

      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={session.status} />
          {session.completedAtMs ? (
            <span className="rounded-md border border-border bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
              ⏱ {duration(session.completedAtMs - session.createdAtMs)}
            </span>
          ) : null}
          {session.evidence.length > 0 ? (
            <span className="rounded-md border border-border bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
              🔬 researched · {session.evidence.length} calls
            </span>
          ) : (
            <span className="rounded-md border border-border bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
              no research recorded
            </span>
          )}
        </div>
        <p className="max-w-prose whitespace-pre-wrap text-base font-semibold">{session.proposal}</p>
        {session.context ? (
          <p className="max-w-prose whitespace-pre-wrap text-xs text-muted-foreground">{session.context}</p>
        ) : null}
        {session.error ? (
          <p className="rounded-lg border border-red-500/40 bg-red-500/5 p-2.5 text-sm text-red-600 dark:text-red-400">
            {session.error}
          </p>
        ) : null}
      </div>

      <PhaseSpine session={session} />

      <div className="flex w-fit gap-1 rounded-lg border border-border p-1">
        {tabs.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            className={`rounded-md px-3 py-1.5 text-sm ${
              tab === candidate.id ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setTab(candidate.id)}
          >
            {candidate.label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <div className="grid gap-6 lg:grid-cols-[1.55fr_1fr]">
          <div className="space-y-4">
            {session.verdict ? (
              <>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  Verdict
                </h3>
                <div className="rounded-lg border border-border p-4">
                  <Markdown content={session.verdict} />
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {session.error
                  ? "The session ended before a verdict was written. Stances below are the last recorded positions."
                  : "Deliberation in progress — the verdict appears here once every member has voted."}
              </p>
            )}
          </div>
          <div className="space-y-4">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              Tally
            </h3>
            <div className="rounded-lg border border-border p-4">
              <TallyChips
                support={session.support}
                oppose={session.oppose}
                abstain={session.abstain}
              />
              <div className="mt-3">
                <StanceMatrix
                  session={session}
                  onOpenMember={(memberId) => openMember(memberId)}
                />
              </div>
            </div>
          </div>
          {ledgerRows.length > 0 ? (
            <div className="space-y-2 lg:col-span-2">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                Verified materials
              </h3>
              {ledgerRows.slice(0, 4).map((row) => (
                <div
                  key={row.title}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 py-2 last:border-b-0"
                >
                  <p className="min-w-0 flex-1 text-sm text-muted-foreground">{row.title}</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {row.citedBy.map((c) => (
                      <MemberChip key={c.memberId} name={c.memberName} onClick={() => openMember(c.memberId)} />
                    ))}
                    <button
                      type="button"
                      className="rounded-md border border-border bg-secondary px-2 py-0.5 font-mono text-[11px] text-accent hover:bg-accent hover:text-accent-foreground"
                      onClick={() => openMaterial(row.title)}
                    >
                      {row.kind.toUpperCase()}
                    </button>
                  </div>
                </div>
              ))}
              {ledgerRows.length > 4 ? (
                <button
                  type="button"
                  className="text-xs font-semibold text-accent hover:underline"
                  onClick={() => setTab("materials")}
                >
                  View all {ledgerRows.length} materials →
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === "members" ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {activeRoster.map((entry) => (
              <button
                key={entry.memberId}
                type="button"
                className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                  entry.memberId === selectedMemberId
                    ? "border-accent bg-accent/15 text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent/10"
                }`}
                onClick={() => setActiveMemberId(entry.memberId)}
              >
                {entry.memberName}
                {votesByMember.has(entry.memberId) ? " ✓" : ""}
              </button>
            ))}
          </div>
          {selectedMemberId == null ? (
            <p className="text-sm text-muted-foreground">No members participated.</p>
          ) : (
            <div className="ml-2 space-y-3 border-l-2 border-border pl-5">
              {memberEvidence.map((item, i) => (
                <div key={`ev-${i}`} className="relative">
                  <span className="absolute -left-[26.5px] top-2 block h-2.5 w-2.5 rounded-full border-2 border-accent bg-background" />
                  <p className="font-mono text-[10px] font-bold uppercase tracking-wide text-accent">
                    {item.kind === "bash" ? "BASH" : "TOOL"} · {item.title}
                  </p>
                  {item.result ? (
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap rounded-md bg-secondary/60 p-2 font-mono text-[11px] text-muted-foreground">
                      {item.result}
                    </p>
                  ) : null}
                </div>
              ))}
              {memberTurns.map((turn) => {
                if (turn.comment.startsWith("(final vote)")) {
                  return (
                    <div key={turn.id} className="relative">
                      <span className="absolute -left-[26.5px] top-2 block h-2.5 w-2.5 rounded-full border-2 border-emerald-500 bg-background" />
                      <p className="font-mono text-[10px] font-bold uppercase tracking-wide text-emerald-500">
                        FINAL VOTE REGISTERED
                      </p>
                      <div className="mt-1 rounded-lg border border-border bg-secondary/40 p-3">
                        <StanceBadge stance={turn.stance} />
                        <p className="mt-1 text-sm text-muted-foreground">
                          {turn.comment.replace("(final vote)", "").trim()}
                        </p>
                      </div>
                    </div>
                  );
                }
                const label =
                  turn.phase === "consideration"
                    ? "CONSIDERATION"
                    : `DISCUSSION · ROUND ${turn.round}`;
                return (
                  <div key={turn.id} className="relative">
                    <span className="absolute -left-[26.5px] top-2 block h-2.5 w-2.5 rounded-full border-2 border-muted-foreground bg-background" />
                    <p className="font-mono text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                      {label}
                    </p>
                    <div className="mt-1 rounded-lg border border-border bg-secondary/40 p-3">
                      <StanceBadge stance={turn.stance} />
                      <p className="mt-1.5 whitespace-pre-wrap text-sm">{turn.comment}</p>
                    </div>
                  </div>
                );
              })}
              {chiefTurn && chiefTurn.memberId === selectedMemberId ? (
                <div className="relative">
                  <span className="absolute -left-[26.5px] top-2 block h-2.5 w-2.5 rounded-full border-2 border-emerald-500 bg-background" />
                  <p className="font-mono text-[10px] font-bold uppercase tracking-wide text-emerald-500">
                    VERDICT · WRITTEN BY THIS MEMBER
                  </p>
                  <div className="mt-1 rounded-lg border border-border p-3">
                    <Markdown content={chiefTurn.comment} />
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {tab === "materials" ? (
        ledgerRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No research artifacts were recorded for this session.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-semibold">Artifact</th>
                  <th className="px-3 py-2 font-semibold">Finding used by the council</th>
                  <th className="px-3 py-2 font-semibold">Cited by</th>
                </tr>
              </thead>
              <tbody>
                {ledgerRows.map((row) => (
                  <tr
                    key={row.title}
                    className={`border-b border-border/50 last:border-b-0 ${
                      highlightTitle === row.title ? "bg-accent/10" : ""
                    }`}
                  >
                    <td className="px-3 py-2.5 align-top">
                      <span className="mr-2 rounded border border-border px-1 py-0.5 font-mono text-[9px] font-bold uppercase text-accent">
                        {row.kind}
                      </span>
                      <span className="font-mono text-xs">{row.title}</span>
                    </td>
                    <td className="px-3 py-2.5 align-top text-muted-foreground">{row.finding || "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 align-top">
                      {row.citedBy.map((c) => (
                        <MemberChip
                          key={c.memberId}
                          name={c.memberName}
                          onClick={() => openMember(c.memberId)}
                        />
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </div>
  );
}

function CouncilPage(props: { subPath: string }) {
  const [tab, setTab] = useState<"sessions" | "members">("sessions");
  const [refreshKey, setRefreshKey] = useState(0);

  useRealtime("council", () => setRefreshKey((key) => key + 1));

  const sessionMatch = props.subPath.match(/^session\/(.+)$/);

  return (
    <div className="mx-auto h-full w-full max-w-3xl space-y-4 overflow-y-auto overscroll-contain p-4 md:p-5">
      {!sessionMatch ? (
        <>
          <div className="flex w-fit rounded-lg border border-border p-1">
            {(["sessions", "members"] as const).map((candidate) => (
              <button
                key={candidate}
                className={`rounded-md px-3 py-1.5 text-sm capitalize ${
                  tab === candidate
                    ? "bg-accent font-medium"
                    : "text-muted-foreground"
                }`}
                onClick={() => setTab(candidate)}
              >
                {candidate}
              </button>
            ))}
          </div>
          {tab === "sessions" ? (
            <SessionsList refreshKey={refreshKey} />
          ) : (
            <MembersTab />
          )}
        </>
      ) : (
        <SessionDetail sessionId={sessionMatch[1]} />
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "council",
    title: "Council",
    icon: "Landmark",
    path: "council",
    component: CouncilPage,
  });
});
