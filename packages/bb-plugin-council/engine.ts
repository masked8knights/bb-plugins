import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  CouncilStore,
  type MemberRow,
  type SessionRow,
  type TurnRow,
} from "./db";

export type Stance = "support" | "oppose" | "abstain";

export type Tally = {
  support: number;
  oppose: number;
  abstain: number;
  activeMembers: number;
  totalMembers: number;
};

const STANCE_RE_ALL = /^\s*STANCE:\s*(support|oppose|abstain)\s*$/gim;
const PASS_RE = /^\s*PASS:\s?/im;
const COMMENT_RE = /^\s*COMMENT:\s?/i;
export const REASONING_LEVELS = new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
]);

export function parseStance(text: string): Stance {
  const matches = [...text.matchAll(STANCE_RE_ALL)];
  const last = matches[matches.length - 1];
  return (last?.[1]?.toLowerCase() as Stance | undefined) ?? "abstain";
}

function latestStance(text: string): Stance | null {
  const matches = [...text.matchAll(STANCE_RE_ALL)];
  const last = matches[matches.length - 1];
  return (last?.[1]?.toLowerCase() as Stance | undefined) ?? null;
}

export function parseDiscussionReply(text: string): {
  kind: "comment" | "pass";
  comment: string;
  stance: Stance | null;
} {
  const stance = latestStance(text);
  let body = text.replace(STANCE_RE_ALL, "").trim();
  if (PASS_RE.test(body)) {
    const reason = body.replace(PASS_RE, "").trim();
    return { kind: "pass", comment: reason || "(passed)", stance };
  }
  body = body.replace(COMMENT_RE, "").trim();
  return { kind: "comment", comment: body || "(no content)", stance };
}

export function extractDissent(report: string): string | null {
  const match = report.match(/##\s*Dissent[\s\S]*?(?=\n##\s|$)/i);
  return match ? match[0].trim() : null;
}

function clamp(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function latestTurnPerMember(
  turns: TurnRow[],
): Map<string, TurnRow> {
  const latest = new Map<string, TurnRow>();
  for (const turn of turns) {
    if (!turn.memberId) continue;
    latest.set(turn.memberId, turn);
  }
  return latest;
}

function buildDigest(
  members: MemberRow[],
  turns: TurnRow[],
): string {
  const latest = latestTurnPerMember(turns);
  const lines: string[] = [];
  for (const member of members) {
    const turn = latest.get(member.id);
    if (!turn) continue;
    lines.push(`- ${member.name} (${turn.stance ?? "no stance"}): ${clamp(turn.comment, 600)}`);
  }
  return lines.join("\n") || "(no positions recorded yet)";
}

function buildTranscript(turns: TurnRow[]): string {
  return turns
    .filter((turn) => turn.phase !== "verdict")
    .map((turn) => {
      const where =
        turn.phase === "consideration"
          ? "initial review"
          : `discussion round ${turn.round}`;
      return `[${turn.memberName} — ${where}] (${turn.stance ?? "no stance"}) ${clamp(turn.comment, 900)}`;
    })
    .join("\n\n");
}

function latestStancePerMember(
  turns: TurnRow[],
): Map<string, NonNullable<TurnRow["stance"]>> {
  const latest = new Map<string, NonNullable<TurnRow["stance"]>>();
  for (const turn of turns) {
    if (!turn.memberId || turn.stance === null) continue;
    latest.set(turn.memberId, turn.stance);
  }
  return latest;
}

function computeTally(
  members: MemberRow[],
  rosterOk: Set<string>,
  turns: TurnRow[],
): Tally {
  const stances = latestStancePerMember(turns);
  let support = 0;
  let oppose = 0;
  let abstain = 0;
  for (const member of members) {
    if (!rosterOk.has(member.id)) continue;
    const stance = stances.get(member.id);
    if (stance === "support") support++;
    else if (stance === "oppose") oppose++;
    else abstain++;
  }
  return {
    support,
    oppose,
    abstain,
    activeMembers: rosterOk.size,
    totalMembers: members.length,
  };
}

function consensusReached(tally: Tally, mode: string): boolean {
  if (tally.activeMembers === 0) return false;
  if (mode === "unanimous") {
    return (
      tally.support === tally.activeMembers &&
      tally.oppose === 0 &&
      tally.abstain === 0
    );
  }
  const majority = Math.floor(tally.activeMembers / 2) + 1;
  return tally.support >= majority && tally.support > tally.oppose;
}

function considerationPrompt(
  member: MemberRow,
  proposal: string,
  context: string | null,
  research: boolean,
): string {
  const contextBlock = context
    ? `\nSupplementary context from the requester:\n\n<context>\n${context}\n</context>\n`
    : "";
  const researchClause = research
    ? "You may use tools to investigate before judging: read the relevant code, docs, and config in this workspace, and run quick read-only checks to verify claims. Stay focused — a few minutes of targeted checking, not a survey — and do not modify anything."
    : "Do not use any tools.";
  return [
    `You are ${member.name}, a member of an advisory council.`,
    member.persona
      ? `Your persona and judgment style:\n${member.persona}`
      : "Bring your own independent judgment.",
    "",
    "A proposal has been submitted for council review.",
    "",
    "<proposal>",
    proposal,
    "</proposal>",
    contextBlock,
    `Review it independently. Identify strengths, risks, and open questions. Be specific and concise (under 250 words). ${researchClause}`,
    "",
    "End your reply with exactly one line:",
    "STANCE: support",
    "or",
    "STANCE: oppose",
    "or",
    "STANCE: abstain",
  ].join("\n");
}

function discussionPrompt(
  round: number,
  maxRounds: number,
  digest: string,
): string {
  return [
    `Council discussion, round ${round} of ${maxRounds}.`,
    "",
    "Current positions:",
    digest,
    "",
    "Reply with ONE short comment (a rebuttal, concession, or new concern) in exactly this shape:",
    "",
    "COMMENT: <your comment>",
    "STANCE: <support|oppose|abstain>",
    "",
    "If you have nothing useful to add, reply instead:",
    "",
    "PASS: <one-line reason>",
    "STANCE: <support|oppose|abstain>",
    "",
    "Do not use tools. Keep comments under 120 words.",
  ].join("\n");
}

function verdictPrompt(
  reporterName: string,
  tally: Tally,
  transcript: string,
): string {
  return [
    `You are ${reporterName}, chief justice of the council. Deliberation has ended. Write the final report for the requester.`,
    "",
    "Use exactly these markdown sections:",
    "## Verdict",
    "## Reasoning highlights",
    "## Dissent and minority views",
    "",
    "Rules: the Verdict states the council's majority position plainly. Reasoning highlights lists the strongest distinct points raised, attributed to members. Include Dissent and minority views only when at least one member ended opposed or abstaining; otherwise write \"None.\" Be faithful to the transcript. Do not use tools.",
    "",
    `Tally: ${tally.support} support / ${tally.oppose} oppose / ${tally.abstain} abstain (${tally.activeMembers} active of ${tally.totalMembers})`,
    "",
    "Final transcript:",
    transcript,
  ].join("\n");
}

function fallbackReport(tally: Tally, turns: TurnRow[]): string {
  const latest = [...latestTurnPerMember(turns).values()];
  const positions = latest
    .map((turn) => `- ${turn.memberName} (${turn.stance ?? "no stance"}): ${clamp(turn.comment, 400)}`)
    .join("\n");
  return [
    "## Verdict",
    "The council could not produce a chief justice report because no member remained available to write it.",
    "",
    "## Reasoning highlights",
    positions || "No member responses were recorded.",
    "",
    "## Dissent and minority views",
    tally.oppose > 0 || tally.abstain > 0
      ? "See the member positions above."
      : "None.",
  ].join("\n");
}

export type CouncilConfig = {
  maxRounds: number;
  timeoutMs: number;
  consensusMode: "majority" | "unanimous";
  research: boolean;
};

export class CouncilEngine {
  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: CouncilStore,
    private readonly getConfig: () => Promise<CouncilConfig>,
  ) {}

  private publish(sessionId: string): void {
    try {
      this.bb.realtime.publish("council", { sessionId });
    } catch {
      this.bb.log.warn("council: realtime publish failed");
    }
  }

  private async waitIdle(
    threadId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    await this.bb.sdk.threads.wait({
      threadId,
      status: "idle",
      timeoutMs,
      signal,
    });
  }

  private async readOutput(threadId: string): Promise<string | null> {
    const result = await this.bb.sdk.threads.output({ threadId });
    return result.output;
  }

  private async cleanupThreads(threadIds: string[]): Promise<void> {
    for (const threadId of threadIds) {
      try {
        await this.bb.sdk.threads.stop({ threadId });
      } catch {
        this.bb.log.warn(`council: stop failed for ${threadId}`);
      }
      try {
        await this.bb.sdk.threads.archive({ threadId });
      } catch {
        this.bb.log.warn(`council: archive failed for ${threadId}`);
      }
    }
  }

  private isAbort(error: unknown, signal: AbortSignal): boolean {
    if (signal.aborted) return true;
    const name = (error as { name?: string } | null | undefined)?.name;
    return name === "AbortError" || name === "TimeoutError";
  }

  async runSession(input: {
    session: SessionRow;
    members: MemberRow[];
    projectId: string;
    signal: AbortSignal;
  }): Promise<string> {
    const { session, members, projectId, signal } = input;

    const threadIds: string[] = [];
    const rosterOk = new Set<string>();
    const threadsByMember = new Map<string, string>();

    try {
      const raw = await this.getConfig();
      const maxRounds = Math.max(0, raw.maxRounds);
      const timeoutMs = Math.max(30_000, raw.timeoutMs);
      const research = raw.research !== false;
      const consensusMode: string =
        raw.consensusMode === "unanimous" ? "unanimous" : "majority";

      const chief =
        members.find((member) => member.isChief === 1) ?? members[0] ?? null;

      const spawnResults = await Promise.allSettled(
        members.map(async (member) => {
          const reasoningLevel =
            member.reasoningLevel &&
            REASONING_LEVELS.has(member.reasoningLevel)
              ? (member.reasoningLevel as "low")
              : null;
          const thread = await this.bb.sdk.threads.spawn({
            projectId,
            environment: { type: "project-default" },
            prompt: considerationPrompt(member, session.proposal, session.context, research),
            title: `Council — ${member.name}`,
            visibility: "hidden",
            permissionMode: "auto",
            ...(member.providerId ? { providerId: member.providerId } : {}),
            ...(member.model ? { model: member.model } : {}),
            ...(reasoningLevel ? { reasoningLevel } : {}),
            executionInputSources: {
              ...(member.providerId
                ? { providerId: "explicit" as const }
                : {}),
              ...(member.model ? { model: "explicit" as const } : {}),
              ...(reasoningLevel
                ? { reasoningLevel: "explicit" as const }
                : {}),
            },
          });
          return { member, threadId: thread.id };
        }),
      );

      // Collect every fulfilled id BEFORE persisting anything, so the finally
      // block can always stop/archive every spawned thread even if a store
      // write throws partway through roster bookkeeping.
      for (let i = 0; i < members.length; i++) {
        const result = spawnResults[i];
        if (result.status === "fulfilled") {
          threadIds.push(result.value.threadId);
          threadsByMember.set(members[i].id, result.value.threadId);
          rosterOk.add(members[i].id);
        }
      }
      for (let i = 0; i < members.length; i++) {
        const result = spawnResults[i];
        const member = members[i];
        if (result.status === "fulfilled") {
          this.store.upsertRoster({
            sessionId: session.id,
            memberId: member.id,
            memberName: member.name,
            threadId: result.value.threadId,
            status: "ok",
          });
        } else {
          this.store.upsertRoster({
            sessionId: session.id,
            memberId: member.id,
            memberName: member.name,
            threadId: "none",
            status: "recused",
          });
          this.store.addTurn({
            sessionId: session.id,
            phase: "consideration",
            round: null,
            memberId: member.id,
            memberName: member.name,
            stance: null,
            comment: `(recused — could not start: ${String(result.reason)})`,
          });
        }
      }
      this.publish(session.id);

      if (rosterOk.size === 0) {
        throw new Error("No council member could be convened.");
      }

      const activeAfterSpawn = members.filter((member) =>
        rosterOk.has(member.id),
      );
      const considerationResults = await Promise.allSettled(
        activeAfterSpawn.map(async (member) => {
          const threadId = threadsByMember.get(member.id);
          if (!threadId) throw new Error("missing thread");
          await this.waitIdle(threadId, timeoutMs, signal);
          const output = await this.readOutput(threadId);
          if (!output) throw new Error("empty response");
          return { member, output };
        }),
      );

      for (let i = 0; i < activeAfterSpawn.length; i++) {
        const member = activeAfterSpawn[i];
        const result = considerationResults[i];
        if (result.status === "fulfilled") {
          this.store.addTurn({
            sessionId: session.id,
            phase: "consideration",
            round: null,
            memberId: member.id,
            memberName: member.name,
            stance: parseStance(result.value.output),
            comment: result.value.output.trim(),
          });
        } else {
          rosterOk.delete(member.id);
          this.store.upsertRoster({
            sessionId: session.id,
            memberId: member.id,
            memberName: member.name,
            threadId: threadsByMember.get(member.id) ?? "none",
            status: "recused",
          });
          this.store.addTurn({
            sessionId: session.id,
            phase: "consideration",
            round: null,
            memberId: member.id,
            memberName: member.name,
            stance: null,
            comment:
              result.status === "rejected" && this.isAbort(result.reason, signal)
                ? "(recused — deliberation cancelled during initial review)"
                : `(recused — failed during initial review: ${String(result.reason)})`,
          });
        }
      }
      this.publish(session.id);

      if (signal.aborted) {
        throw new Error("Deliberation cancelled.");
      }
      if (rosterOk.size === 0) {
        throw new Error(
          "Every council member was recused during initial review.",
        );
      }

      let tally = computeTally(
        members,
        rosterOk,
        this.store.listTurns(session.id),
      );

      if (!consensusReached(tally, consensusMode)) {
        for (let round = 1; round <= maxRounds; round++) {
          const activeMembers = members.filter((member) =>
            rosterOk.has(member.id),
          );
          const digest = buildDigest(
            activeMembers,
            this.store.listTurns(session.id),
          );
          for (const member of activeMembers) {
            if (signal.aborted) {
              throw new Error("Deliberation cancelled.");
            }
            const threadId = threadsByMember.get(member.id);
            if (!threadId) continue;
            try {
              await this.bb.sdk.threads.send({
                threadId,
                mode: "auto",
                input: [{ type: "text", mentions: [], text: discussionPrompt(round, maxRounds, digest) }],
              });
              await this.waitIdle(threadId, timeoutMs, signal);
              const output = await this.readOutput(threadId);
              if (!output) throw new Error("empty response");
              const reply = parseDiscussionReply(output);
              this.store.addTurn({
                sessionId: session.id,
                phase: "discussion",
                round,
                memberId: member.id,
                memberName: member.name,
                stance: reply.stance,
                comment: reply.comment,
              });
            } catch (error) {
              if (this.isAbort(error, signal)) {
                throw new Error("Deliberation cancelled.");
              }
              this.store.addTurn({
                sessionId: session.id,
                phase: "discussion",
                round,
                memberId: member.id,
                memberName: member.name,
                stance: null,
                comment: `(no response this round: ${String(error)})`,
              });
            }
            this.publish(session.id);
          }
          tally = computeTally(members, rosterOk, this.store.listTurns(session.id));
          if (consensusReached(tally, consensusMode)) break;
        }
      }

      let report: string;
      const reporterId =
        chief && rosterOk.has(chief.id)
          ? chief.id
          : ([...rosterOk][0] ?? null);
      const reporter = members.find((member) => member.id === reporterId);
      const reporterThreadId = reporter
        ? threadsByMember.get(reporter.id)
        : undefined;

      if (reporter && reporterThreadId) {
        try {
          if (signal.aborted) {
            throw new Error("Deliberation cancelled.");
          }
          await this.bb.sdk.threads.send({
            threadId: reporterThreadId,
            mode: "auto",
            input: [
              {
                type: "text",
                mentions: [],
                text: verdictPrompt(
                  reporter.name,
                  tally,
                  buildTranscript(this.store.listTurns(session.id)),
                ),
              },
            ],
          });
          await this.waitIdle(reporterThreadId, timeoutMs, signal);
          const output = await this.readOutput(reporterThreadId);
          report = output?.trim() || fallbackReport(tally, this.store.listTurns(session.id));
        } catch (error) {
          if (this.isAbort(error, signal)) {
            throw new Error("Deliberation cancelled.");
          }
          this.bb.log.warn(`council: verdict step failed: ${String(error)}`);
          report = fallbackReport(tally, this.store.listTurns(session.id));
        }
      } else {
        report = fallbackReport(tally, this.store.listTurns(session.id));
      }

      this.store.addTurn({
        sessionId: session.id,
        phase: "verdict",
        round: null,
        memberId: reporter?.id ?? null,
        memberName: reporter?.name ?? "Council",
        stance: null,
        comment: report,
      });
      this.store.completeSession(
        session.id,
        report,
        extractDissent(report),
        tally,
      );
      this.publish(session.id);
      return report;
    } catch (error) {
      // Persist failure/cancellation before rethrowing so the session never
      // stays stuck in "running". Cleanup happens in finally either way.
      try {
        this.store.setSessionError(session.id, String(error));
        this.publish(session.id);
      } catch (persistError) {
        this.bb.log.error(
          `council: could not record session failure: ${String(persistError)}`,
        );
      }
      throw error;
    } finally {
      await this.cleanupThreads(threadIds);
    }
  }
}
