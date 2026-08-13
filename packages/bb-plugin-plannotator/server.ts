// BB's Plannotator integration is intentionally a bridge, not a second
// review product. The released upstream binary owns the plan renderer,
// annotations, history, and feedback formatting. BB only supplies the agent
// tool, embeds the upstream session, and keeps the provider interaction alive.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  defineRpcContract,
  type BbPluginApi,
  type JsonValue,
  type PluginInteractionRequest,
  type PluginInteractionResult,
} from "@bb/plugin-sdk";
import { z } from "zod";
import {
  BUNDLED_BINARY,
  DEFAULT_BINARY,
  INTERACTION_SETTLE_TIMEOUT_MS,
  ensureBundledPlannotatorBinary,
  missingBinaryMessage,
  resolvePlannotatorBinary,
  startUpstreamPlanReview,
  type RunningUpstreamReview,
  type UpstreamDecision,
  type UpstreamOrigin,
} from "./src/bridge";
import { PANEL_ACTION_ID, RENDERER_ID } from "./src/constants";
import { isLocalBindHostname } from "./src/embedded";

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

// BB currently caps plugin interaction lifetimes at one hour. The review
// itself must not inherit that product-level safety limit: a user may leave a
// plan open while away from the desk. waitForReviewInteraction silently
// re-arms the host interaction when that cap is reached.
export const REVIEW_INTERACTION_TIMEOUT_MS = 60 * 60 * 1000;

type RequestInput = (
  request: PluginInteractionRequest,
  options?: { signal?: AbortSignal },
) => Promise<PluginInteractionResult>;

export async function waitForReviewInteraction(
  requestInput: RequestInput,
  request: PluginInteractionRequest,
  signal?: AbortSignal,
): Promise<PluginInteractionResult> {
  while (true) {
    const result = await requestInput(request, signal ? { signal } : undefined);
    if (result.outcome !== "cancelled" || result.reason !== "timeout") {
      return result;
    }

    // The host's one-hour interaction timer is an implementation safety
    // window, not a review deadline. If cancellation raced with the expiry,
    // do not create another pending interaction for an already-aborted tool.
    if (signal?.aborted) {
      return { outcome: "cancelled", reason: "request-aborted" };
    }
  }
}

/**
 * Map BB's provider ids to the identities the upstream UI knows how to name.
 * The child must not infer this from ambient OPENCODE/CODEX_* environment
 * variables: BB is the owner of the waiting tool call.
 */
export function upstreamOriginForProvider(
  providerId: string | null | undefined,
): UpstreamOrigin {
  const normalized = providerId?.trim().toLowerCase() ?? "";
  if (normalized === "opencode" || normalized.includes("open-code")) {
    return "opencode";
  }
  if (normalized === "claude" || normalized.includes("claude-code")) {
    return "claude-code";
  }
  if (normalized === "copilot" || normalized.includes("copilot-cli")) {
    return "copilot-cli";
  }
  if (normalized === "gemini" || normalized.includes("gemini-cli")) {
    return "gemini-cli";
  }
  if (
    normalized === "pi" ||
    normalized === "omp" ||
    normalized.includes("oh-my-pi")
  ) {
    return "pi";
  }
  return "codex";
}

async function resolveUpstreamOrigin(
  bb: BbPluginApi,
  threadId: string,
  signal: AbortSignal,
): Promise<UpstreamOrigin> {
  try {
    const thread = await bb.sdk.threads.get({ threadId, signal });
    return upstreamOriginForProvider(thread.providerId);
  } catch {
    // The provider identity is presentation-only. A failed metadata lookup
    // must not prevent the review gate from opening.
    return "codex";
  }
}

export function shouldUseRemotePlannotatorMode(
  serverUrl: string | undefined,
  env: Partial<Pick<NodeJS.ProcessEnv, "BB_APP_URL" | "BB_SERVER_BIND_HOST">> = process.env,
): boolean {
  const configuredUrl = env.BB_APP_URL?.trim() || serverUrl?.trim();
  if (configuredUrl) {
    try {
      if (!isLocalBindHostname(new URL(configuredUrl).hostname)) return true;
    } catch {
      // Fall through to the explicit bind-host signal below.
    }
  }
  return env.BB_SERVER_BIND_HOST?.trim() === "0.0.0.0";
}

async function resolveUpstreamRuntimeConfig(
  bb: BbPluginApi,
  signal: AbortSignal,
): Promise<{ dataDir?: string; remote: boolean }> {
  try {
    const systemConfig = await bb.sdk.system.config({ signal });
    return {
      dataDir: join(systemConfig.dataDir, "plugins", bb.pluginId, "plannotator"),
      remote: shouldUseRemotePlannotatorMode(systemConfig.serverUrl),
    };
  } catch {
    // External runtimes remain usable if an older host does not expose the
    // system data directory. The bundled runtime already needs this lookup.
    return {
      remote: shouldUseRemotePlannotatorMode(undefined),
    };
  }
}

function resolveEmbedHost(bb: BbPluginApi): string | undefined {
  try {
    return new URL(bb.server.loopbackBaseUrl).hostname;
  } catch {
    return undefined;
  }
}

function panelSessionId(paramsJson: string | null): string | null {
  if (!paramsJson) return null;
  try {
    const value = JSON.parse(paramsJson) as unknown;
    return isRecord(value) && typeof value.sessionId === "string"
      ? value.sessionId
      : null;
  } catch {
    return null;
  }
}

/** Remove only this review's persisted right-panel tab, retrying CAS races. */
async function closeReviewPanel(
  bb: BbPluginApi,
  threadId: string,
  sessionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const current = await bb.sdk.threads.tabs.get({ threadId });
      const remaining = current.tabs.filter((tab) => {
        if (tab.kind !== "plugin-panel") return true;
        return !(
          tab.pluginId === bb.pluginId &&
          tab.actionId === PANEL_ACTION_ID &&
          panelSessionId(tab.paramsJson) === sessionId
        );
      });
      if (remaining.length === current.tabs.length) return;

      await bb.sdk.threads.tabs.update({
        threadId,
        expectedRevision: current.revision,
        tabs: remaining,
      });
      return;
    } catch (error) {
      if (attempt === 2) {
        bb.log.warn(
          `Could not close Plannotator tab for ${threadId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

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
  return configured.binaryPath.trim() || BUNDLED_BINARY;
}

async function resolveRuntimeBinary(
  bb: BbPluginApi,
  configuredPath: string,
  signal: AbortSignal,
): Promise<string> {
  const environmentOverride = process.env.PLANNOTATOR_BIN?.trim();
  if (environmentOverride) {
    const external = resolvePlannotatorBinary(environmentOverride);
    if (!external) throw new Error(missingBinaryMessage(environmentOverride));
    return external;
  }

  // Preserve compatibility with the first adapter release, where the
  // default was the standalone `plannotator` command. Explicit paths remain
  // strict; only the old command name falls back to the bundled runtime.
  if (configuredPath !== BUNDLED_BINARY) {
    const external = resolvePlannotatorBinary(configuredPath, {
      ...process.env,
      PLANNOTATOR_BIN: "",
    });
    if (external) return external;
    if (configuredPath !== DEFAULT_BINARY && configuredPath !== "auto") {
      throw new Error(missingBinaryMessage(configuredPath));
    }
  }

  const systemConfig = await bb.sdk.system.config({ signal });
  try {
    return await ensureBundledPlannotatorBinary({
      runtimeDir: join(systemConfig.dataDir, "plugins", bb.pluginId, "runtime"),
      signal,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${missingBinaryMessage(BUNDLED_BINARY)} ${detail}`, {
      cause: error,
    });
  }
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    binaryPath: {
      type: "string",
      label: "Plannotator binary",
      description:
        `Use the bundled official runtime by default, or enter a path/command to override it. Set to \"${BUNDLED_BINARY}\" to restore the default.`,
      default: BUNDLED_BINARY,
    },
  });

  const activeReviews = new Map<string, ActiveReview>();

  bb.rpc.register(rpcContract, {
    async status() {
      const configuredPath = await getConfiguredPath(settings);
      return {
        configuredPath,
        binary:
          configuredPath === BUNDLED_BINARY
            ? null
            : resolvePlannotatorBinary(configuredPath),
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
      let binaryPath: string;
      try {
        binaryPath = await resolveRuntimeBinary(bb, configuredPath, context.signal);
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
      }

      const sessionId = randomUUID();
      let upstream: RunningUpstreamReview;
      try {
        const [origin, runtimeConfig] = await Promise.all([
          resolveUpstreamOrigin(bb, context.threadId, context.signal),
          resolveUpstreamRuntimeConfig(bb, context.signal),
        ]);
        upstream = await startUpstreamPlanReview({
          binaryPath,
          planMarkdown: params.planMarkdown,
          timeoutSeconds: null,
          signal: context.signal,
          origin,
          dataDir: runtimeConfig.dataDir,
          remote: runtimeConfig.remote,
          embedHost: resolveEmbedHost(bb),
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

      const interactionPromise = waitForReviewInteraction(
        (request, options) => bb.ui.requestInput(request, options),
        {
          threadId: context.threadId,
          rendererId: RENDERER_ID,
          title: title.slice(0, 80),
          payload,
          timeoutMs: REVIEW_INTERACTION_TIMEOUT_MS,
        },
        context.signal,
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
        await closeReviewPanel(bb, context.threadId, sessionId);
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
    if (active) {
      void Promise.all([
        closeReviewPanel(bb, thread.id, active.sessionId),
        active.review.stop(),
      ]);
    }
  });

  bb.onDispose(async () => {
    await Promise.all(
      [...activeReviews.entries()].map(([threadId, { sessionId, review }]) =>
        Promise.all([
          closeReviewPanel(bb, threadId, sessionId),
          review.stop(),
        ]),
      ),
    );
    activeReviews.clear();
  });

  bb.log.info("loaded upstream Plannotator bridge");
}
