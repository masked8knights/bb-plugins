import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const reasoningLevels = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const memberDto = z.object({
  id: z.string(),
  name: z.string(),
  persona: z.string(),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  reasoningLevel: z.string().nullable(),
  isChief: z.boolean(),
  enabled: z.boolean(),
  createdAtMs: z.number(),
});

export const sessionSummaryDto = z.object({
  id: z.string(),
  proposalExcerpt: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  originThreadId: z.string().nullable(),
  support: z.number(),
  oppose: z.number(),
  abstain: z.number(),
  activeMembers: z.number(),
  totalMembers: z.number(),
  createdAtMs: z.number(),
  completedAtMs: z.number().nullable(),
});

export const turnDto = z.object({
  id: z.string(),
  seq: z.number(),
  phase: z.enum(["consideration", "discussion", "verdict"]),
  round: z.number().nullable(),
  memberId: z.string().nullable(),
  memberName: z.string(),
  stance: z.enum(["support", "oppose", "abstain", "pass"]).nullable(),
  comment: z.string(),
  createdAtMs: z.number(),
});

export const rosterEntryDto = z.object({
  memberId: z.string(),
  memberName: z.string(),
  status: z.enum(["ok", "recused"]),
});

export const sessionDetailDto = z.object({
  id: z.string(),
  proposal: z.string(),
  context: z.string().nullable(),
  status: z.enum(["running", "completed", "failed"]),
  consensusMode: z.string(),
  maxRounds: z.number(),
  verdict: z.string().nullable(),
  dissent: z.string().nullable(),
  error: z.string().nullable(),
  support: z.number(),
  oppose: z.number(),
  abstain: z.number(),
  activeMembers: z.number(),
  totalMembers: z.number(),
  createdAtMs: z.number(),
  completedAtMs: z.number().nullable(),
  turns: z.array(turnDto),
  roster: z.array(rosterEntryDto),
});

export const providerDto = z.object({
  id: z.string(),
  displayName: z.string(),
  available: z.boolean(),
});

export const modelDto = z.object({
  model: z.string(),
  displayName: z.string(),
  providerId: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  listMembers: {
    input: z.null(),
    output: z.object({ members: z.array(memberDto) }),
  },
  upsertMember: {
    input: z.object({
      id: z.string().optional(),
      name: z.string().min(1).max(80),
      persona: z.string().max(4000),
      providerId: z.string().nullable(),
      model: z.string().nullable(),
      reasoningLevel: z.string().nullable(),
      isChief: z.boolean(),
      enabled: z.boolean(),
    }),
    output: z.object({ id: z.string() }),
  },
  deleteMember: {
    input: z.object({ id: z.string() }),
    output: z.null(),
  },
  listSessions: {
    input: z.null(),
    output: z.object({ sessions: z.array(sessionSummaryDto) }),
  },
  getSession: {
    input: z.object({ id: z.string() }),
    output: sessionDetailDto,
  },
  deleteSession: {
    input: z.object({ id: z.string() }),
    output: z.null(),
  },
  startConversation: {
    input: z.object({
      proposal: z.string().min(1),
      context: z.string().optional(),
      projectId: z.string().optional(),
    }),
    output: z.object({ threadId: z.string() }),
  },
  listProviders: {
    input: z.null(),
    output: z.object({ providers: z.array(providerDto) }),
  },
  listModels: {
    input: z.null(),
    output: z.object({ models: z.array(modelDto) }),
  },
});
