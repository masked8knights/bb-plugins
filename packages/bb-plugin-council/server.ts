import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CouncilStore, migrations, type MemberRow, type RosterRow, type SessionRow } from "./db";
import { CouncilEngine, REASONING_LEVELS } from "./engine";
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
      "You are a senior software developer in the mold of grugbrain.dev: pragmatic, experienced, allergic to complexity. Write plain professional English — let the grug mindset shape your judgment, not your voice.",
      "",
      "Your one measure: how much complexity does this add versus the value it delivers?",
      "- The simplest thing that could work wins; an 80/20 that ships beats an elegant design that doesn't.",
      "- Everything must earn its complexity: features, abstractions, dependencies, configuration options. Ask what each costs forever, not just to build.",
      "- Distrust premature abstraction, early factoring, and fashionable tools adopted before the problem is understood. Let cut points emerge from working code before formalizing them.",
      "- Chesterton's fence: never delete or rewrite until you can explain why the code exists. Prefer small refactors where the system keeps working at every step.",
      "- Integration tests at stable seams beat exhaustive mocked unit suites; every bugfix ships with a regression test first. No performance work without a measured profile. Boring, proven technology beats exciting fads.",
      "",
      "Deliberating: argue from measurement and named costs, not taste. Being outnumbered is not an argument. Change your stance only when someone states a concrete fact or cost you had not considered; otherwise hold, even alone. Reserve \"abstain\" for proposals well outside your experience, and say which part.",
      "",
      "When supporting: name what makes it boring to operate and easy to debug at 2am. When opposing: name the simplest workable alternative.",
    ].join("\n"),
  },
  {
    name: "Architect",
    isChief: false,
    persona: [
      "You are a principal software architect and systems thinker. Open every review by naming the single biggest structural risk, then judge the whole: boundaries, responsibilities, data flow, failure modes, and how it holds together as it grows.",
      "",
      "You hunt hidden coupling, blurred ownership, missing migration and rollback paths, and local choices that fragment global coherence. Consistency across naming, patterns, and interfaces matters because drift compounds. Every layer must pay for itself — architecture for its own sake is dead weight.",
      "",
      "Reason in explicit trade-offs — consistency vs availability, build vs buy, abstraction vs delivery speed — and state them openly rather than hiding them inside a \"perfect\" design. Always ask: what does this look like at 10x scale, at 10x team size, and when the third different kind of client arrives?",
      "",
      "Deliberating: you defend the health of the whole. Concede points that reduce coupling; hold points where structure would erode — being outvoted is not evidence. Change your stance only when someone identifies a boundary or failure mode you missed; otherwise hold and refine your alternative. Reserve \"abstain\" for proposals with no structural dimension at all.",
      "",
      "When supporting: say what makes the structure survive growth. When opposing: always offer a concrete architectural alternative, never just criticism.",
    ].join("\n"),
  },
  {
    name: "Designer",
    isChief: false,
    persona: [
      "You are a senior product designer who judges everything from the seat of the person using it. Is it obvious, fast, forgiving, and pleasant? Is the fastest path to their goal the default path?",
      "",
      "You sweat what others skip: copy and tone, empty/loading/error/partial states, feedback and perceived latency, focus order, keyboard and touch ergonomics, contrast, accessibility, responsive behavior, and consistency with familiar interface patterns. You catch unnecessary steps, interruptions, jargon, and states nobody bothered to design. You ask who the user is, what job they hired the product for, and what happens when they make a mistake — because they will. For developer-facing proposals, developers are still users: setup, error messages, docs, and recovery are experience.",
      "",
      "Deliberating: bring evidence from real user behavior, not preference. Disagreeing with the room is expected when users pay the cost. Change your stance only when someone shows concretely that the affected flow holds up; otherwise hold, or keep your abstain with a one-line reason. Never drift toward consensus just because the room settled.",
      "",
      "When supporting: name the moments that became measurably clearer. When opposing: point to the specific flow that breaks and the smallest fix that saves it.",
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

function parseCliFlags(args: string[]): {
  positional: string[];
  flags: Map<string, string | boolean>;
} {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, true);
    }
  }
  return { positional, flags };
}

function optionalString(
  flags: Map<string, string | boolean>,
  key: string,
): string | undefined {
  const value = flags.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const NULL_SENTINELS = new Set(["none", "clear", "default"]);

/**
 * Tri-state flag reader for nullable values: not present, set-to-value
 * (empty/sentinel means clear to null), so `--provider none` clears.
 */
function nullableFlag(
  flags: Map<string, string | boolean>,
  key: string,
): { changed: true; value: string | null } | undefined {
  if (!flags.has(key)) return undefined;
  const raw = flags.get(key);
  const value = typeof raw === "string" && raw.length > 0 ? raw : null;
  if (value !== null && NULL_SENTINELS.has(value)) {
    return { changed: true, value: null };
  }
  return { changed: true, value };
}
function conversationPrompt(
  proposal: string,
  context?: string,
  preset?: string,
): string {
  const contextBlock = context
    ? `\nSupporting context:\n\n<context>\n${context}\n</context>\n`
    : "";
  const presetLine = preset
    ? `Convene the "${preset}" council preset — pass preset: "${preset}" to the tool. `
    : "";
  return [
    "Please present this proposal to the Council using its council_deliberate tool.",
    "",
    "<proposal>",
    proposal,
    "</proposal>",
    contextBlock,
    `${presetLine}Call council_deliberate exactly once with the full proposal text${
      context ? " and the supporting context" : ""
    }. The tool blocks for one or more minutes while the members deliberate — let it run rather than retrying.`,
    "",
    "When the report comes back, give me:",
    "- The tally and overall verdict in a sentence",
    "- Each member's position in a line or two",
    "- Any dissent worth knowing about",
  ].join("\n");
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
      label: "Safety cap: max discussion rounds",
      default: "20",
    },
    memberTimeoutSec: {
      type: "string",
      label: "Per-response timeout (seconds)",
      default: "240",
    },
    memberResearch: {
      type: "select",
      label: "Member research (consideration phase)",
      options: ["workspace tools", "off"],
      default: "workspace tools",
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
      maxRounds: Math.max(1, parseCount(values.maxRounds, 20)),
      timeoutMs: Math.max(30, parseCount(values.memberTimeoutSec, 240)) * 1000,
      research: values.memberResearch !== "off",
    };
  };

  const engine = new CouncilEngine(bb, store, getConfig);

  const enabledMembers = () =>
    store
      .listMembers()
      .filter((member) => member.enabled === 1)
      .sort((a, b) =>
        a.isChief === b.isChief ? 0 : a.isChief === 1 ? -1 : 1,
      );

  // A preset scopes one convene to a named subset of members. Global
  // enable flags are never mutated; the session roster snapshots whoever
  // is actually invited.
  const resolveMembers = (preset?: string | null): MemberRow[] => {
    if (!preset) return enabledMembers();
    const saved = store.getPresetByName(preset);
    if (!saved) {
      const known = store.listPresets().map((p) => p.name);
      throw new Error(
        `Unknown council preset "${preset}".${known.length ? ` Known presets: ${known.join(", ")}.` : " No presets are defined — create one with bb council preset-add."}`,
      );
    }
    const members = enabledMembers().filter((member) =>
      saved.memberIds.includes(member.id),
    );
    if (members.length === 0) {
      throw new Error(
        `Preset "${preset}" matches no currently enabled members. Re-save it with bb council preset-add.`,
      );
    }
    return members;
  };

  const startSession = async (input: {
    proposal: string;
    context?: string;
    projectId?: string | null;
    originThreadId?: string | null;
    preset?: string | null;
  }): Promise<string> => {
    const members = resolveMembers(input.preset);
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
      consensusMode: "majority",
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
    preset?: string | null;
    signal?: AbortSignal;
  }): Promise<{ sessionId: string; report: string }> => {
    const sessionId = await startSession(input);
    const session = store.getSession(sessionId);
    if (!session) throw new Error("Council session disappeared.");
    const members = resolveMembers(input.preset);
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
      preset: z
        .string()
        .optional()
        .describe(
          "Name of a saved council preset to convene a specific panel. Omit for the default council (all enabled members).",
        ),
    }),
    async execute(params, ctx) {
      try {
        const { report } = await runToCompletion({
          proposal: params.proposal,
          context: params.context,
          projectId: ctx.projectId,
          originThreadId: ctx.threadId,
          preset: params.preset ?? null,
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

  // Member threads register their final vote through this tool. It is
  // visible to every agent thread, but it only works when the caller's
  // thread id matches a member thread on a running council session —
  // anyone else gets a polite error.
  bb.agents.registerTool({
    name: "council_register_vote",
    description:
      "Register your FINAL vote in an active council deliberation. Only council member threads can use this. After registering, your position is locked and you leave the discussion.",
    instructions:
      "Call this exactly once, when you are confident in your answer. Pass stance plus a one-line closing reason. Do not call it before the discussion phase.",
    experimental_statusLabels: {
      pending: "Registering final vote",
      completed: "Final vote registered",
    },
    parameters: z.object({
      stance: z
        .enum(["support", "oppose", "abstain"])
        .describe("Your final position."),
      comment: z
        .string()
        .max(600)
        .optional()
        .describe("One-line closing reason for your vote."),
    }),
    async execute(params, ctx) {
      const membership = store.findOpenSessionByThreadId(ctx.threadId);
      if (!membership) {
        return {
          content: [
            {
              type: "text" as const,
              text: "You are not part of an active council session, so no vote was recorded.",
            },
          ],
          isError: true,
        };
      }
      store.registerVote(membership.sessionId, membership.memberId, params.stance);
      if (params.comment) {
        store.addTurn({
          sessionId: membership.sessionId,
          phase: "discussion",
          round: null,
          memberId: membership.memberId,
          memberName: membership.memberName,
          stance: params.stance,
          comment: `(final vote) ${params.comment}`,
        });
      }
      bb.realtime.publish("council", { sessionId: membership.sessionId });
      return `${membership.memberName}, your final vote (${params.stance}) is locked. You are no longer part of the discussion.`;
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
    deleteSession: (input) => {
      if (!store.deleteSession(input.id)) {
        throw new Error("Session not found.");
      }
      return null;
    },
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
    startConversation: async (input) => {
      if (resolveMembers(input.preset ?? null).length === 0) {
        throw new Error(
          "The council has no enabled members. Add members in the Council panel first.",
        );
      }
      const projectId = await resolveProjectId(bb, input.projectId ?? null);
      const thread = await bb.sdk.threads.spawn({
        projectId,
        environment: { type: "project-default" },
        prompt: conversationPrompt(input.proposal, input.context, input.preset),
        title: `Council: ${excerpt(input.proposal, 60)}`,
      });
      return { threadId: thread.id };
    },
    listPresets: () => ({
      presets: store.listPresets().map((preset) => ({
        name: preset.name,
        members: preset.memberIds
          .map((id) => store.getMember(id)?.name)
          .filter((name): name is string => Boolean(name)),
      })),
    }),
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
        name: "delete",
        summary: "Delete one council session",
        usage: "bb council delete <id>",
      },
      {
        name: "members",
        summary: "List council members",
        usage: "bb council members",
      },
      {
        name: "member-add",
        summary: "Add a council member",
        usage:
          'bb council member-add <name> [--persona "<text>"] [--provider <id>] [--model <model>] [--reasoning <level>] [--chief] [--disabled]',
      },
      {
        name: "member-set",
        summary:
          "Update a council member (flags mirror member-add; pass none to clear provider/model/reasoning)",
        usage:
          'bb council member-set <id> [--name "<name>"] [--persona "<text>"] [--provider <id|none>] [--model <model|none>] [--reasoning <level|none>] [--chief true|false] [--enabled true|false]',
      },
      {
        name: "member-delete",
        summary: "Delete a council member",
        usage: "bb council member-delete <id>",
      },
      {
        name: "presets",
        summary: "List saved council presets",
        usage: "bb council presets",
      },
      {
        name: "preset-add",
        summary: "Create or update a council preset from member names or ids",
        usage: "bb council preset-add <name> <member...>",
      },
      {
        name: "preset-delete",
        summary: "Delete a council preset",
        usage: "bb council preset-delete <name>",
      },
      {
        name: "convene",
        summary:
          "Convene the council on a proposal (blocking; --preset <name> scopes the panel)",
        usage: 'bb council convene [--preset <name>] "<proposal>"',
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
              turn.phase === "consideration"
                ? "initial review"
                : turn.round === null
                  ? "final vote"
                  : `round ${turn.round}`;
          parts.push(`\n== ${turn.memberName} (${where}) [${turn.stance ?? "-"}] ==\n${turn.comment}`);
        }
        if (session.verdict) parts.push(`\n== Final report ==\n${session.verdict}`);
        return { exitCode: 0, stdout: parts.join("\n") };
      }
      if (sub === "delete" && rest[0]) {
        if (!store.deleteSession(rest[0])) {
          return { exitCode: 1, stderr: "Session not found." };
        }
        return { exitCode: 0, stdout: `Deleted session ${rest[0]}.` };
      }
      if (sub === "members") {
        const members = store.listMembers();
        if (members.length === 0) return { exitCode: 0, stdout: "No members yet." };
        const lines = members.map((member) => {
          const tags = [
            member.isChief === 1 ? "chief" : null,
            member.enabled === 1 ? null : "disabled",
          ]
            .filter(Boolean)
            .join(",");
          const execution =
            [member.providerId, member.model, member.reasoningLevel]
              .filter(Boolean)
              .join("/") || "project default";
          return `${member.id}  ${member.name.padEnd(16)} ${execution.padEnd(28)} [${tags}]`;
        });
        return { exitCode: 0, stdout: lines.join("\n") };
      }
      if (sub === "member-add") {
        const { positional, flags } = parseCliFlags(rest);
        const name = positional[0];
        if (!name) {
          return { exitCode: 1, stderr: 'Usage: bb council member-add <name> [--persona "<text>"]' };
        }
        const values = await settings.get();
        const maxMembers = Math.max(
          1,
          Number.parseInt(values.maxMembers, 10) || 7,
        );
        if (store.listMembers().length >= maxMembers) {
          return {
            exitCode: 1,
            stderr: `Council is full (max ${maxMembers} members). Raise "Max council members" in plugin settings.`,
          };
        }
        const reasoningLevel = optionalString(flags, "reasoning");
        if (
          reasoningLevel !== undefined &&
          !REASONING_LEVELS.has(reasoningLevel)
        ) {
          return {
            exitCode: 1,
            stderr: `Unknown reasoning level "${reasoningLevel}". Valid: ${[...REASONING_LEVELS].join(", ")}.`,
          };
        }
        const isChief = flags.get("chief") === true;
        const id = store.insertMember({
          name,
          persona: optionalString(flags, "persona") ?? "",
          providerId: optionalString(flags, "provider") ?? null,
          model: optionalString(flags, "model") ?? null,
          reasoningLevel: reasoningLevel ?? null,
          isChief,
          enabled: flags.get("disabled") !== true,
        });
        if (isChief) store.clearOtherChiefs(id);
        return { exitCode: 0, stdout: `Added member ${name} (${id}).` };
      }
      if (sub === "member-set" && rest[0]) {
        const member = store.getMember(rest[0]);
        if (!member) return { exitCode: 1, stderr: "Member not found." };
        const { flags } = parseCliFlags(rest.slice(1));
        const name = optionalString(flags, "name");
        const persona = optionalString(flags, "persona");
        const providerChange = nullableFlag(flags, "provider");
        const modelChange = nullableFlag(flags, "model");
        const reasoningChange = nullableFlag(flags, "reasoning");
        if (
          typeof reasoningChange?.value === "string" &&
          !REASONING_LEVELS.has(reasoningChange.value)
        ) {
          return {
            exitCode: 1,
            stderr: `Unknown reasoning level "${reasoningChange.value}". Valid: ${[...REASONING_LEVELS].join(", ")}.`,
          };
        }
        const chiefFlag = flags.get("chief");
        const enabledFlag = flags.get("enabled");
        const truthy = (value: string | boolean | undefined) =>
          value === true || value === "true";
        const falsy = (value: string | boolean | undefined) =>
          value === false || value === "false";
        if (
          (chiefFlag !== undefined && !truthy(chiefFlag) && !falsy(chiefFlag)) ||
          (enabledFlag !== undefined &&
            !truthy(enabledFlag) &&
            !falsy(enabledFlag))
        ) {
          return { exitCode: 1, stderr: "Boolean flags accept true or false." };
        }
        store.updateMember(member.id, {
          name: name ?? member.name,
          persona: persona ?? member.persona,
          providerId: providerChange ? providerChange.value : member.providerId,
          model: modelChange ? modelChange.value : member.model,
          reasoningLevel: reasoningChange
            ? reasoningChange.value
            : member.reasoningLevel,
          isChief:
            chiefFlag === undefined ? member.isChief === 1 : truthy(chiefFlag),
          enabled:
            enabledFlag === undefined
              ? member.enabled === 1
              : truthy(enabledFlag),
        });
        if (truthy(chiefFlag)) store.clearOtherChiefs(member.id);
        return { exitCode: 0, stdout: `Updated member ${member.name}.` };
      }
      if (sub === "member-delete" && rest[0]) {
        const member = store.getMember(rest[0]);
        if (!member) return { exitCode: 1, stderr: "Member not found." };
        store.deleteMember(rest[0]);
        return { exitCode: 0, stdout: `Deleted member ${member.name}.` };
      }
      if (sub === "presets") {
        const presets = store.listPresets();
        if (presets.length === 0) {
          return { exitCode: 0, stdout: "No presets saved. Create one: bb council preset-add <name> <member...>" };
        }
        const lines = presets.map((preset) => {
          const names = preset.memberIds
            .map((id) => store.getMember(id)?.name ?? "(deleted)")
            .join(", ");
          return `${preset.name.padEnd(16)} ${names}`;
        });
        return { exitCode: 0, stdout: lines.join("\n") };
      }
      if (sub === "preset-add") {
        const { positional } = parseCliFlags(rest);
        const [name, ...wanted] = positional;
        if (!name || wanted.length === 0) {
          return {
            exitCode: 1,
            stderr: "Usage: bb council preset-add <name> <memberNameOrId...>",
          };
        }
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
          return { exitCode: 1, stderr: "Preset names use letters, digits, and dashes." };
        }
        const all = store.listMembers();
        const resolved: string[] = [];
        const missing: string[] = [];
        for (const want of wanted) {
          const match =
            all.find((member) => member.id === want) ??
            all.find(
              (member) =>
                member.name.toLowerCase() === want.toLowerCase(),
            );
          if (match) resolved.push(match.id);
          else missing.push(want);
        }
        if (missing.length > 0) {
          return {
            exitCode: 1,
            stderr: `Unknown members: ${missing.join(", ")}. Known: ${all.map((m) => m.name).join(", ")}.`,
          };
        }
        store.savePreset(name, [...new Set(resolved)]);
        const names = resolved
          .map((id) => all.find((m) => m.id === id)?.name)
          .filter(Boolean)
          .join(", ");
        return { exitCode: 0, stdout: `Saved preset "${name}": ${names}.` };
      }
      if (sub === "preset-delete" && rest[0]) {
        if (!store.deletePreset(rest[0])) {
          return { exitCode: 1, stderr: "Preset not found." };
        }
        return { exitCode: 0, stdout: `Deleted preset ${rest[0]}.` };
      }
      if (sub === "convene") {
        const { positional, flags } = parseCliFlags(rest);
        const proposal = positional.join(" ").trim();
        const preset = optionalString(flags, "preset") ?? null;
        if (!proposal) {
          return {
            exitCode: 1,
            stderr:
              'Usage: bb council convene [--preset <name>] "<proposal>"',
          };
        }
        try {
          const { sessionId, report } = await runToCompletion({
            proposal,
            projectId: ctx.projectId ?? null,
            originThreadId: ctx.threadId ?? null,
            preset,
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

  bb.onDispose(() => {
    bb.log.info("council disposed");
  });

  bb.log.info("council loaded");
}
