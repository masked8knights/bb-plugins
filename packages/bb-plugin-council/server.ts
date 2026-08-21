import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CouncilStore, migrations, type MemberRow, type RosterRow, type SessionRow } from "./db";
import { CouncilEngine } from "./engine";
import { rpcContract } from "./contract";

export type { rpcContract };

function excerpt(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

const DEFAULT_MEMBERS = [
  {
    name: "Grug",
    isChief: true,
    persona: [
      "You are a senior software developer in the mold of grugbrain.dev — pragmatic, experienced, and deeply allergic to complexity. Speak in plain professional English; the grug mindset shapes your judgment, not your voice.",
      "",
      "Complexity is your apex predator and you evaluate every proposal through one measure above all: how much complexity does this add compared to the value it delivers?",
      "- Favor the simplest thing that could possibly work. An 80/20 solution that ships beats an elegant design that doesn't.",
      '- Say no by default. Every feature, abstraction, dependency, and configuration option must earn its complexity; ask what it costs forever, not just to build.',
      "- Distrust premature abstraction, speculative generality, early factoring, and fashionable ideas adopted before the problem is understood. Let good cut points emerge from working code before formalizing them.",
      "- Respect Chesterton's fence: never recommend ripping out or rewriting existing code until you understand why it exists, no matter how ugly it looks.",
      "- Prefer small refactors where the system keeps working at every step over big-bang rewrites.",
      "- Integration tests at stable seams beat exhaustive mocked unit suites. When a bug appears, demand a regression test before the fix.",
      "- No performance work without a measured profile. Network calls cost millions of CPU cycles; count them.",
      "- Boring, proven technology beats exciting new fads with unproven track records.",
      "",
      "When you support a proposal, explain what makes it hard to break and easy to debug at 2am. When you oppose one, name the simplest workable alternative.",
    ].join("\n"),
  },
  {
    name: "Architect",
    isChief: false,
    persona: [
      "You are a principal software architect and systems thinker. You judge proposals at the highest level: component boundaries, responsibilities, data flow, dependencies, failure modes, and how the whole holds together as it grows.",
      "",
      "- You look for hidden coupling, blurred ownership between components, missing migration and rollback paths, and local optimizations that fragment global coherence.",
      "- You ensure cohesion across the board: naming, patterns, interfaces, and conventions stay consistent, and you push back when one-off decisions erode the system's integrity.",
      "- You reason in explicit trade-offs — consistency vs availability, build vs buy, abstraction vs speed of delivery — stated openly rather than hidden inside a 'perfect' design.",
      "- You ask: what does this look like at 10x scale, at 10x team size, and when the third different kind of client arrives?",
      "- You respect working structure but never defend architecture for its own sake; every layer must pay for itself.",
      "",
      "Support when the proposed structure strengthens the whole system. Oppose when it weakens it, and always offer a concrete architectural alternative rather than only criticism.",
    ].join("\n"),
  },
  {
    name: "Designer",
    isChief: false,
    persona: [
      "You are a senior product designer obsessed with user experience. You judge every proposal from the seat of the person using it: is it obvious, fast, forgiving, and pleasant? Is the fastest path to the user's goal the default path?",
      "",
      "- You sweat the details others skip: wording and copy tone, empty/loading/error/partial states, feedback and perceived latency, focus order, keyboard and touch ergonomics, color contrast, accessibility, responsive behavior, and consistency with familiar interface patterns.",
      "- You catch flows with unnecessary steps, interruptions that break concentration, jargon that excludes users, and states nobody bothered to design.",
      "- You ask who the user is, what job they hired the product for, and what happens when they make a mistake — because they will.",
      "- You defend platform conventions where familiarity helps the user, but fight friction wherever it hides, even when removing it is inconvenient to build.",
      "",
      "Support when the experience becomes measurably clearer and kinder. Oppose when polish is sacrificed for convenience, and say specifically which moments in the flow break down and how to fix them.",
    ].join("\n"),
  },
];

async function seedDefaultMembers(
  bb: BbPluginApi,
  store: CouncilStore,
): Promise<void> {
  try {
    if (await bb.storage.kv.get<boolean>("defaultMembersSeeded")) return;
    if (store.listMembers().length === 0) {
      for (const member of DEFAULT_MEMBERS) {
        const id = store.insertMember({
          name: member.name,
          persona: member.persona,
          providerId: null,
          model: null,
          reasoningLevel: null,
          isChief: member.isChief,
          enabled: true,
        });
        if (member.isChief) store.clearOtherChiefs(id);
      }
      bb.log.info("council: seeded default members (Grug, Architect, Designer)");
    }
    await bb.storage.kv.set("defaultMembersSeeded", true);
  } catch (error) {
    bb.log.warn(`council: default member seeding failed: ${String(error)}`);
  }
}


function memberToDto(member: MemberRow) {
  return {
    id: member.id,
    name: member.name,
    persona: member.persona,
    providerId: member.providerId,
    model: member.model,
    reasoningLevel: member.reasoningLevel,
    isChief: member.isChief === 1,
    enabled: member.enabled === 1,
    createdAtMs: member.createdAtMs,
  };
}

function sessionSummary(session: SessionRow, roster: RosterRow[]) {
  let tally = {
    support: 0,
    oppose: 0,
    abstain: 0,
    activeMembers: roster.filter((entry) => entry.status === "ok").length,
    totalMembers: roster.length,
  };
  if (session.tallyJson) {
    try {
      tally = { ...tally, ...JSON.parse(session.tallyJson) };
    } catch {
      // keep roster-derived zeros
    }
  }
  return {
    id: session.id,
    proposalExcerpt: excerpt(session.proposal, 160),
    status: session.status,
    originThreadId: session.originThreadId,
    support: Number(tally.support) || 0,
    oppose: Number(tally.oppose) || 0,
    abstain: Number(tally.abstain) || 0,
    activeMembers: Number(tally.activeMembers) || 0,
    totalMembers: Number(tally.totalMembers) || 0,
    createdAtMs: session.createdAtMs,
    completedAtMs: session.completedAtMs,
  };
}

async function resolveProjectId(
  bb: BbPluginApi,
  projectId?: string | null,
): Promise<string> {
  if (projectId) return projectId;
  const projects = await bb.sdk.projects.list({ includePersonal: true });
  const first = projects[0];
  if (!first) {
    throw new Error("No bb project available to host council threads.");
  }
  return first.id;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    maxRounds: {
      type: "string",
      label: "Discussion rounds (max)",
      default: "2",
    },
    memberTimeoutSec: {
      type: "string",
      label: "Per-response timeout (seconds)",
      default: "240",
    },
    consensusMode: {
      type: "select",
      label: "Consensus rule",
      options: ["majority", "unanimous"],
      default: "majority",
    },
    maxMembers: {
      type: "string",
      label: "Max council members",
      default: "7",
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const store = new CouncilStore(db);
  await seedDefaultMembers(bb, store);

  const getConfig = async () => {
    const parseCount = (raw: string, fallback: number): number => {
      const parsed = Number.parseInt(raw, 10);
      return Number.isNaN(parsed) ? fallback : parsed;
    };
    const values = await settings.get();
    return {
      maxRounds: Math.max(0, parseCount(values.maxRounds, 2)),
      timeoutMs: Math.max(30, parseCount(values.memberTimeoutSec, 240)) * 1000,
      consensusMode:
        values.consensusMode === "unanimous"
          ? ("unanimous" as const)
          : ("majority" as const),
    };
  };

  const engine = new CouncilEngine(bb, store, getConfig);

  // UI-launched sessions run detached; track them so dispose can abort and
  // drain every in-flight deliberation instead of leaking member threads.
  const detached = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();

  const conveneDetached = (input: {
    sessionId: string;
    members: MemberRow[];
    session: SessionRow;
    projectId: string;
  }): void => {
    const controller = new AbortController();
    const { sessionId } = input;
    const promise = engine
      .runSession({
        session: input.session,
        members: input.members,
        projectId: input.projectId,
        signal: controller.signal,
      })
      .then(() => undefined)
      .catch((error) => {
        bb.log.error(
          `council: session ${sessionId} failed: ${String(error)}`,
        );
        // runSession persists failures itself; this is a safety net for
        // errors thrown before/outside its try block. Guarded so a closed
        // DB handle during dispose cannot become an unhandled rejection.
        try {
          const current = store.getSession(sessionId);
          if (current?.status === "running") {
            store.setSessionError(sessionId, String(error));
          }
        } catch {
          bb.log.warn(`council: could not record failure for ${sessionId}`);
        }
      })
      .finally(() => {
        detached.delete(sessionId);
      });
    detached.set(sessionId, { controller, promise });
  };

  const enabledMembers = () =>
    store
      .listMembers()
      .filter((member) => member.enabled === 1)
      .sort((a, b) =>
        a.isChief === b.isChief ? 0 : a.isChief === 1 ? -1 : 1,
      );

  const startSession = async (input: {
    proposal: string;
    context?: string;
    projectId?: string | null;
    originThreadId?: string | null;
  }): Promise<string> => {
    const members = enabledMembers();
    if (members.length === 0) {
      throw new Error(
        "The council has no enabled members. Add members in the Council panel.",
      );
    }
    const projectId = await resolveProjectId(bb, input.projectId);
    const config = await getConfig();
    const session = store.createSession({
      proposal: input.proposal,
      context: input.context ?? null,
      originThreadId: input.originThreadId ?? null,
      projectId,
      consensusMode: config.consensusMode,
      maxRounds: config.maxRounds,
    });
    try {
      bb.realtime.publish("council", { sessionId: session.id });
    } catch {
      bb.log.warn("council: realtime publish failed");
    }
    return session.id;
  };

  const runToCompletion = async (input: {
    proposal: string;
    context?: string;
    projectId?: string | null;
    originThreadId?: string | null;
    signal?: AbortSignal;
  }): Promise<{ sessionId: string; report: string }> => {
    const sessionId = await startSession(input);
    const session = store.getSession(sessionId);
    if (!session) throw new Error("Council session disappeared.");
    const members = enabledMembers();
    const projectId = await resolveProjectId(bb, session.projectId);
    const report = await engine.runSession({
      session,
      members,
      projectId,
      signal: input.signal ?? new AbortController().signal,
    });
    return { sessionId, report };
  };

  bb.agents.registerTool({
    name: "council_deliberate",
    description:
      "Convene the Council: a panel of configured advisor agents that independently reviews a proposal, discusses it over rounds, and returns a majority verdict with dissent. Use when the user asks to 'ask the council', 'present to the council', or when independent second opinions from multiple models would help before committing to a plan.",
    instructions:
      "council_deliberate blocks for one or more minutes while the council deliberates. Pass the complete proposal text; pass supporting material through context. The result contains the verdict report. Do not call it repeatedly for the same proposal.",
    experimental_statusLabels: {
      pending: "Convening the council",
      completed: "Council verdict received",
    },
    parameters: z.object({
      proposal: z
        .string()
        .min(1)
        .describe("The proposal, plan, or question for the council to review."),
      context: z
        .string()
        .optional()
        .describe("Optional supporting material: diffs, constraints, background."),
    }),
    async execute(params, ctx) {
      try {
        const { report } = await runToCompletion({
          proposal: params.proposal,
          context: params.context,
          projectId: ctx.projectId,
          originThreadId: ctx.threadId,
          signal: ctx.signal,
        });
        return `${report}\n\n---\nCouncil session recorded. Full transcripts are available in the Council panel.`;
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Council deliberation failed: ${String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  bb.rpc.register(rpcContract, {
    listMembers: () => ({
      members: store.listMembers().map(memberToDto),
    }),
    upsertMember: async (input) => {
      if (input.id) {
        const existing = store.getMember(input.id);
        if (!existing) throw new Error("Member not found.");
        store.updateMember(input.id, input);
        if (input.isChief) store.clearOtherChiefs(input.id);
        return { id: input.id };
      }
      const values = await settings.get();
      const maxMembers =
        Math.max(1, Number.parseInt(values.maxMembers, 10) || 7);
      if (store.listMembers().length >= maxMembers) {
        throw new Error(
          `Council is full (max ${maxMembers} members). Raise "Max council members" in plugin settings.`,
        );
      }
      const id = store.insertMember(input);
      if (input.isChief) store.clearOtherChiefs(id);
      return { id };
    },
    deleteMember: (input) => {
      store.deleteMember(input.id);
      return null;
    },
    listSessions: () => ({
      sessions: store
        .listSessions(100)
        .map((session) => sessionSummary(session, store.listRoster(session.id))),
    }),
    getSession: (input) => {
      const session = store.getSession(input.id);
      if (!session) throw new Error("Session not found.");
      const roster = store.listRoster(session.id);
      let tally: {
        support: number;
        oppose: number;
        abstain: number;
        activeMembers: number;
        totalMembers: number;
      } = {
        support: 0,
        oppose: 0,
        abstain: 0,
        activeMembers: roster.filter((entry) => entry.status === "ok").length,
        totalMembers: roster.length,
      };
      if (session.tallyJson) {
        try {
          tally = { ...tally, ...JSON.parse(session.tallyJson) };
        } catch {
          bb.log.warn("council: bad tally json");
        }
      }
      return {
        id: session.id,
        proposal: session.proposal,
        context: session.context,
        status: session.status,
        consensusMode: session.consensusMode,
        maxRounds: session.maxRounds,
        verdict: session.verdict,
        dissent: session.dissent,
        error: session.error,
        support: tally.support,
        oppose: tally.oppose,
        abstain: tally.abstain,
        activeMembers: tally.activeMembers,
        totalMembers: tally.totalMembers,
        createdAtMs: session.createdAtMs,
        completedAtMs: session.completedAtMs,
        turns: store.listTurns(session.id).map((turn) => ({
          id: turn.id,
          seq: turn.seq,
          phase: turn.phase,
          round: turn.round,
          memberId: turn.memberId,
          memberName: turn.memberName,
          stance: turn.stance,
          comment: turn.comment,
          createdAtMs: turn.createdAtMs,
        })),
        roster: roster.map((entry) => ({
          memberId: entry.memberId,
          memberName: entry.memberName,
          status: entry.status,
        })),
      };
    },
    convene: async (input) => {
      const sessionId = await startSession({
        proposal: input.proposal,
        context: input.context,
        projectId: input.projectId ?? null,
        originThreadId: null,
      });
      const session = store.getSession(sessionId);
      if (!session) throw new Error("Council session disappeared.");
      const members = enabledMembers();
      const projectId = await resolveProjectId(bb, session.projectId);
      conveneDetached({ sessionId, members, session, projectId });
      return { sessionId };
    },
    listProviders: async () => {
      const providers = await bb.sdk.providers.list();
      return {
        providers: providers.map((provider) => ({
          id: provider.id,
          displayName: provider.displayName,
          available: provider.available,
        })),
      };
    },
    listModels: async () => {
      const result = await bb.sdk.providers.models();
      return {
        models: result.models.map((model) => ({
          model: model.model,
          displayName: model.displayName,
          providerId: model.routeProviderId ?? null,
        })),
      };
    },
  });

  bb.cli.register({
    name: "council",
    summary: "Inspect and convene Council sessions",
    commands: [
      {
        name: "sessions",
        summary: "List recent council sessions",
        usage: "bb council sessions",
      },
      {
        name: "session",
        summary: "Show one session's transcript and verdict",
        usage: "bb council session <id>",
      },
      {
        name: "convene",
        summary: "Convene the council on a proposal (blocking)",
        usage: 'bb council convene "<proposal>"',
      },
    ],
    async run(argv, ctx) {
      const [sub, ...rest] = argv;
      if (sub === "sessions") {
        const sessions = store.listSessions(20);
        if (sessions.length === 0) return { exitCode: 0, stdout: "No sessions yet." };
        const lines = sessions.map((session) => {
          const date = new Date(session.createdAtMs).toISOString();
          return `${session.id}  ${session.status.padEnd(10)} ${date}  ${excerpt(session.proposal, 80)}`;
        });
        return { exitCode: 0, stdout: lines.join("\n") };
      }
      if (sub === "session" && rest[0]) {
        const session = store.getSession(rest[0]);
        if (!session) return { exitCode: 1, stderr: "Session not found." };
        const parts: string[] = [
          `Session ${session.id} — ${session.status}`,
          `Proposal: ${session.proposal}`,
        ];
        if (session.error) parts.push(`Error: ${session.error}`);
        for (const turn of store.listTurns(session.id)) {
          if (turn.phase === "verdict") continue;
          const where =
            turn.phase === "consideration" ? "initial review" : `round ${turn.round}`;
          parts.push(`\n== ${turn.memberName} (${where}) [${turn.stance ?? "-"}] ==\n${turn.comment}`);
        }
        if (session.verdict) parts.push(`\n== Final report ==\n${session.verdict}`);
        return { exitCode: 0, stdout: parts.join("\n") };
      }
      if (sub === "convene") {
        const proposal = rest.join(" ").trim();
        if (!proposal) {
          return {
            exitCode: 1,
            stderr: 'Usage: bb council convene "<proposal>"',
          };
        }
        try {
          const { sessionId, report } = await runToCompletion({
            proposal,
            projectId: ctx.projectId ?? null,
            originThreadId: ctx.threadId ?? null,
            signal: ctx.signal,
          });
          return { exitCode: 0, stdout: `Session ${sessionId}\n\n${report}` };
        } catch (error) {
          return { exitCode: 1, stderr: String(error) };
        }
      }
      const usage =
        'Usage: bb council sessions | bb council session <id> | bb council convene "<proposal>"';
      return {
        exitCode: 1,
        stderr: sub ? `Unknown council command: ${sub}\n${usage}` : usage,
      };
    },
  });

  bb.onDispose(async () => {
    for (const entry of detached.values()) {
      entry.controller.abort(new Error("council plugin disposed"));
    }
    await Promise.allSettled(
      [...detached.values()].map((entry) => entry.promise),
    );
    bb.log.info("council disposed");
  });

  bb.log.info("council loaded");
}
