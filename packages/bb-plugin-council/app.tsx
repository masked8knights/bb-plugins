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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      });
      setOpen(false);
      setProposal("");
      setContext("");
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

function SessionDetail(props: { sessionId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [session, setSession] = useState<SessionDetailDto | null>(null);
  const [missing, setMissing] = useState(false);

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

  const consideration = session.turns.filter((turn) => turn.phase === "consideration");
  const rounds = [
    ...new Set(
      session.turns
        .filter((turn) => turn.phase === "discussion")
        .map((turn) => turn.round),
    ),
  ].sort((a, b) => (a ?? 0) - (b ?? 0));
  const verdictTurns = session.turns.filter((turn) => turn.phase === "verdict");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => navigate.toPluginPanel("council", { subPath: "" })}
        >
          ← All sessions
        </Button>
        <div className="flex items-center gap-2">
          <StatusPill status={session.status} />
          <TallyChips
            support={session.support}
            oppose={session.oppose}
            abstain={session.abstain}
          />
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Proposal</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="whitespace-pre-wrap text-sm">{session.proposal}</p>
          {session.context ? (
            <p className="whitespace-pre-wrap text-xs text-muted-foreground">
              Context: {session.context}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {formatTime(session.createdAtMs)} · {session.consensusMode} rule · max{" "}
            {session.maxRounds} rounds · {session.activeMembers}/{session.totalMembers}{" "}
            members active
          </p>
          {session.error ? (
            <p className="text-sm text-red-600 dark:text-red-400">{session.error}</p>
          ) : null}
        </CardContent>
      </Card>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Initial review</h3>
        {consideration.map((turn) => (
          <div key={turn.id} className="rounded-lg border border-border p-3">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-sm font-medium">{turn.memberName}</span>
              <StanceBadge stance={turn.stance} />
            </div>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {turn.comment}
            </p>
          </div>
        ))}
      </section>

      {rounds.map((round) => (
        <section key={round} className="space-y-2">
          <h3 className="text-sm font-semibold">Discussion round {round}</h3>
          {session.turns
            .filter((turn) => turn.phase === "discussion" && turn.round === round)
            .map((turn) => (
              <div key={turn.id} className="rounded-lg border border-border p-3">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-sm font-medium">{turn.memberName}</span>
                  <StanceBadge stance={turn.stance} />
                </div>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {turn.comment}
                </p>
              </div>
            ))}
        </section>
      ))}

      {verdictTurns.length > 0 || session.verdict ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Verdict</h3>
          <div className="rounded-lg border border-border p-3">
            <Markdown content={session.verdict ?? verdictTurns[0]?.comment ?? ""} />
          </div>
        </section>
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
