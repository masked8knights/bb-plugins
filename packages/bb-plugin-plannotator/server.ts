// BB's Plannotator integration is intentionally a bridge, not a second
// review product. The released upstream binary owns the plan renderer,
// annotations, history, and feedback formatting. BB only supplies the agent
// tool, embeds the upstream session, and keeps the provider interaction alive.
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi, type JsonValue } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_BINARY,
  INTERACTION_SETTLE_TIMEOUT_MS,
  missingBinaryMessage,
  resolvePlannotatorBinary,
  startUpstreamPlanReview,
  type RunningUpstreamReview,
  type UpstreamDecision,
} from "./src/bridge";
import { PANEL_ACTION_ID, RENDERER_ID } from "./src/constants";

const reviewToolParametersSchema = z
  .object({
    planMarkdown: z.string().trim().min(1).max(1_000_000),
    title: z.string().trim().min(1).max(200).optional(),
    previousPlanMarkdown: z.string().max(1_000_000).optional(),
  })
  .strict();

const interactionPayloadSchema = z
  .object({
    kind: z.literal("plannotator"),
    sessionId: z.string().min(1),
    threadId: z.string().min(1),
    sessionUrl: z.string().url(),
    title: z.string().min(1),
  })
  .strict();

const upstreamResultSchema = z
  .object({
    kind: z.literal("upstream_result"),
    decision: z.object({
      approved: z.boolean(),
      feedback: z.string().optional(),
      savedPath: z.string().optional(),
      agentSwitch: z.string().optional(),
    }),
  })
  .strict();

const bridgeErrorSchema = z
  .object({
    kind: z.literal("bridge_error"),
    message: z.string().min(1),
  })
  .strict();

const interactionValueSchema = z.union([upstreamResultSchema, bridgeErrorSchema]);

export const rpcContract = defineRpcContract({
  /** A health check for the right-panel shell and plugin tests. */
  status: {
    input: z.object({}).strict(),
    output: z
      .object({
        binary: z.string().nullable(),
        configuredPath: z.string(),
      })
      .strict(),
  },
});

type InteractionRecord = {
  id: string;
  status: string;
  origin?: { kind?: string; rendererId?: string };
  payload?: { kind?: string; data?: unknown };
};

type ActiveReview = {
  sessionId: string;
  review: RunningUpstreamReview;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asInteractionRecord(value: unknown): InteractionRecord | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.status !== "string") {
    return null;
  }
  return {
    id: value.id,
    status: value.status,
    origin: isRecord(value.origin)
      ? {
          kind: typeof value.origin.kind === "string" ? value.origin.kind : undefined,
          rendererId:
            typeof value.origin.rendererId === "string"
              ? value.origin.rendererId
              : undefined,
        }
      : undefined,
    payload: isRecord(value.payload)
      ? {
          kind: typeof value.payload.kind === "string" ? value.payload.kind : undefined,
          data: value.payload.data,
        }
      : undefined,
  };
}

function isOwnedInteraction(
  value: unknown,
  threadId: string,
  sessionId: string,
): value is InteractionRecord {
  const interaction = asInteractionRecord(value);
  if (!interaction || interaction.status !== "pending") return false;
  if (interaction.origin?.kind !== "plugin" || interaction.origin.rendererId !== RENDERER_ID) {
    return false;
  }
  if (interaction.payload?.kind !== "plugin" || !isRecord(interaction.payload.data)) {
    return false;
  }
  return (
    interaction.payload.data.threadId === threadId &&
    interaction.payload.data.sessionId === sessionId
  );
}

async function findOwnedInteraction(
  bb: BbPluginApi,
  threadId: string,
  sessionId: string,
): Promise<InteractionRecord | null> {
  const interactions = await bb.sdk.threads.interactions.list({ threadId });
  for (const value of interactions) {
    const interaction = asInteractionRecord(value);
    if (isOwnedInteraction(interaction, threadId, sessionId)) return interaction;
  }
  return null;
}

async function respondToOwnedInteraction(
  bb: BbPluginApi,
  threadId: string,
  sessionId: string,
  value: JsonValue,
): Promise<boolean> {
  const deadline = Date.now() + INTERACTION_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const interaction = await findOwnedInteraction(bb, threadId, sessionId).catch(() => null);
    if (interaction) {
      try {
        await bb.sdk.threads.interactions.respond({
          threadId,
          interactionId: interaction.id,
          value,
        });
        return true;
      } catch {
        // The user may have cancelled the BB interaction at the same time the
        // upstream page submitted. The host is then already settled.
        return false;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function decisionLabel(decision: UpstreamDecision): "approved" | "changes_requested" | "cancelled" {
  if (decision.approved) return "approved";
  return decision.feedback?.trim() ? "changes_requested" : "cancelled";
}

function toolResponse(decision: UpstreamDecision): string {
  return JSON.stringify({
    decision: decisionLabel(decision),
    source: "plannotator",
    ...(decision.feedback ? { feedback: decision.feedback } : {}),
    ...(decision.savedPath ? { savedPath: decision.savedPath } : {}),
    ...(decision.agentSwitch ? { agentSwitch: decision.agentSwitch } : {}),
  });
}

function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ decision: "cancelled", source: "plannotator", error: message }) }],
    isError: true,
  };
}

function resultValue(decision: UpstreamDecision): JsonValue {
  return {
    kind: "upstream_result",
    decision: {
      approved: decision.approved,
      ...(decision.feedback ? { feedback: decision.feedback } : {}),
      ...(decision.savedPath ? { savedPath: decision.savedPath } : {}),
      ...(decision.agentSwitch ? { agentSwitch: decision.agentSwitch } : {}),
    },
  };
}

function errorValue(error: unknown): JsonValue {
  return {
    kind: "bridge_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function parseInteractionValue(value: unknown):
  | { kind: "upstream_result"; decision: UpstreamDecision }
  | { kind: "bridge_error"; message: string }
  | null {
  const parsed = interactionValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function getConfiguredPath(settings: { get(): Promise<{ binaryPath: string }> }): Promise<string> {
  const configured = await settings.get();
  return configured.binaryPath.trim() || DEFAULT_BINARY;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    binaryPath: {
      type: "string",
      label: "Plannotator binary",
      description:
        "Path or command for the official Plannotator binary. The default searches PATH and ~/.local/bin.",
      default: DEFAULT_BINARY,
    },
    timeoutSeconds: {
      type: "string",
      label: "Review timeout (seconds)",
      description: "How long an unattended upstream review may wait before it is dismissed.",
      default: "3600",
    },
  });

  const activeReviews = new Map<string, ActiveReview>();

  bb.rpc.register(rpcContract, {
    async status() {
      const configuredPath = await getConfiguredPath(settings);
      return {
        configuredPath,
        binary: resolvePlannotatorBinary(configuredPath),
      };
    },
  });

  bb.agents.registerTool({
    name: "plannotator_review_plan",
    description:
      "Open the upstream Plannotator plan-review UI in BB and wait for approval or actionable feedback.",
    instructions:
      "Before changing files or taking implementation actions, call plannotator_review_plan with the complete Markdown plan. If it returns changes_requested, revise the plan and call it again. Do not treat a review as approved unless the tool returns decision=approved.",
    experimental_statusLabels: {
      pending: "Waiting for Plannotator",
      completed: "Plannotator review completed",
    },
    parameters: reviewToolParametersSchema,
    async execute(params, context) {
      if (activeReviews.has(context.threadId)) {
        return errorResponse("A Plannotator review is already active in this thread.");
      }

      const configuredPath = await getConfiguredPath(settings);
      const binaryPath = resolvePlannotatorBinary(configuredPath);
      if (!binaryPath) return errorResponse(missingBinaryMessage(configuredPath));

      const sessionId = randomUUID();
      let upstream: RunningUpstreamReview;
      try {
        const timeoutValue = Number.parseInt(String((await settings.get()).timeoutSeconds), 10);
        upstream = await startUpstreamPlanReview({
          binaryPath,
          planMarkdown: params.planMarkdown,
          timeoutSeconds: Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : 3600,
          signal: context.signal,
        });
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
      }

      activeReviews.set(context.threadId, { sessionId, review: upstream });
      const title = params.title?.trim() || "Plannotator review";
      const payload = interactionPayloadSchema.parse({
        kind: "plannotator",
        sessionId,
        threadId: context.threadId,
        sessionUrl: upstream.url,
        title,
      });

      const interactionPromise = bb.ui
        .requestInput(
          {
            threadId: context.threadId,
            rendererId: RENDERER_ID,
            title: title.slice(0, 80),
            payload,
            timeoutMs: 60 * 60 * 1000,
          },
          { signal: context.signal },
        )
        .then(
          (interaction) => ({ kind: "interaction" as const, interaction }),
          (error) => ({ kind: "interaction_error" as const, error }),
        );

      const upstreamPromise = upstream.result.then(
        async (decision) => ({
          kind: "upstream" as const,
          decision,
          settled: await respondToOwnedInteraction(
            bb,
            context.threadId,
            sessionId,
            resultValue(decision),
          ),
        }),
        async (error) => ({
          kind: "bridge_error" as const,
          error,
          settled: await respondToOwnedInteraction(
            bb,
            context.threadId,
            sessionId,
            errorValue(error),
          ),
        }),
      );

      try {
        const winner = await Promise.race([interactionPromise, upstreamPromise]);
        if (winner.kind === "upstream") {
          if (!winner.settled) {
            const lateInteraction = await Promise.race([
              interactionPromise,
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
            ]);
            if (lateInteraction && lateInteraction.kind === "interaction_error") {
              return errorResponse(
                lateInteraction.error instanceof Error
                  ? lateInteraction.error.message
                  : String(lateInteraction.error),
              );
            }
          }
          return toolResponse(winner.decision);
        }

        if (winner.kind === "bridge_error") {
          return errorResponse(winner.error instanceof Error ? winner.error.message : String(winner.error));
        }
        if (winner.kind === "interaction_error") {
          return errorResponse(
            winner.error instanceof Error ? winner.error.message : String(winner.error),
          );
        }
        if (winner.interaction.outcome === "cancelled") {
          return errorResponse(`Review cancelled${winner.interaction.reason ? `: ${winner.interaction.reason}` : ""}`);
        }

        const submitted = parseInteractionValue(winner.interaction.value);
        if (!submitted) return errorResponse("BB returned an invalid Plannotator interaction value.");
        if (submitted.kind === "bridge_error") return errorResponse(submitted.message);
        return toolResponse(submitted.decision);
      } finally {
        activeReviews.delete(context.threadId);
        await upstream.stop();
        // Both branches attach rejection handlers through Promise.race, so a
        // late child exit cannot become an unhandled process rejection.
        void upstreamPromise.catch(() => undefined);
        void interactionPromise.catch(() => undefined);
      }
    },
  });

  bb.agents.configure(() => ({
    tools: ["plannotator_review_plan"],
    skills: ["plan-review"],
  }));

  bb.events.on("thread.deleted", ({ thread }) => {
    const active = activeReviews.get(thread.id);
    if (active) void active.review.stop();
  });

  bb.onDispose(async () => {
    await Promise.all([...activeReviews.values()].map(({ review }) => review.stop()));
    activeReviews.clear();
  });

  bb.log.info("loaded upstream Plannotator bridge");
}
