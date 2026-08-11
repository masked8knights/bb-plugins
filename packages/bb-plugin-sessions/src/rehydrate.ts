// Rehydration: create a BB thread that continues an external provider session.

import type { BbPluginApi } from "@bb/plugin-sdk";
import { realpathSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import { buildRehydratePrompt, type RehydrateMode } from "./format";
import { PROVIDER_DEFAULTS, type ProviderId } from "./sources";
import type { SessionMeta } from "./types";
import type { SessionRow } from "./indexer";

export interface RehydrateResult {
  threadId: string;
  threadTitle: string;
  project: { id: string; name: string };
  environment: {
    kind: "unmanaged" | "project-default";
    path?: string;
    hostId?: string;
  };
  provider: string | null;
  inputChars: number;
  notes: string[];
}

function rowToMeta(row: SessionRow): SessionMeta {
  return {
    id: row.id,
    provider: row.provider,
    providerSessionId: row.providerSessionId,
    filePath: row.filePath,
    title: row.title,
    cwd: row.cwd,
    gitRepoRoot: row.gitRepoRoot,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    model: row.model,
    origin: row.origin,
    messageCount: row.messageCount,
    summary: row.summary,
    firstUserMessage: row.firstUserMessage,
    transcript: row.transcript,
    transcriptPreviewTruncated: row.transcript.length < row.transcriptLength,
    truncated: row.truncated === 1,
    sizeBytes: row.sizeBytes,
    mtimeMs: row.mtimeMs,
  };
}

export function isPathPrefix(parent: string, child: string): boolean {
  const a = resolvePath(parent);
  const b = resolvePath(child);
  return b === a || b.startsWith(a.endsWith(sep) ? a : `${a}${sep}`);
}

interface ResolvedTarget {
  projectId: string;
  projectName: string;
  /** Host used by the project's default environment for provider discovery. */
  defaultHostId?: string;
  environment: { type: "project-default" };
  notes: string[];
}

async function resolveTarget(
  bb: BbPluginApi,
  session: SessionMeta,
  explicitProjectId?: string,
): Promise<ResolvedTarget> {
  const notes: string[] = [];
  const projects = await bb.sdk.projects.list({ includePersonal: true });
  const cwd = session.cwd ? resolvePath(session.cwd) : null;

  // 1. Explicit project wins when provided.
  if (explicitProjectId) {
    const p = projects.find((x) => x.id === explicitProjectId);
    if (p) {
      notes.push(`Using explicit project ${p.name}`);
      return {
        projectId: p.id,
        projectName: p.name,
        defaultHostId: p.sources.find((source) => source.isDefault)?.hostId,
        environment: { type: "project-default" },
        notes,
      };
    }
    throw new Error(`Requested project ${explicitProjectId} was not found`);
  }

  // 2. Deepest project source whose path contains the session cwd.
  if (cwd) {
    const matches: Array<{
      projectId: string;
      projectName: string;
      hostId: string;
      defaultHostId?: string;
      path: string;
      depth: number;
    }> = [];
    for (const p of projects) {
      for (const src of p.sources) {
        if (isPathPrefix(src.path, cwd)) {
          const sourcePath = resolvePath(src.path);
          matches.push({
            projectId: p.id,
            projectName: p.name,
            hostId: src.hostId,
            defaultHostId: p.sources.find((source) => source.isDefault)?.hostId,
            path: sourcePath,
            depth: sourcePath.length,
          });
        }
      }
    }
    const deepestDepth = matches.reduce((depth, match) => Math.max(depth, match.depth), -1);
    const deepest = matches.filter((match) => match.depth === deepestDepth);
    const deepestProjectIds = new Set(deepest.map((match) => match.projectId));
    const best = deepestProjectIds.size === 1 ? deepest[0] : undefined;
    if (deepestProjectIds.size > 1) {
      notes.push("Cwd matched multiple projects at the same depth; using a project-default environment");
      const fallback = projects.find((project) => project.kind === "personal")
        ?? projects.find((project) => project.kind === "standard")
        ?? projects[0];
      if (fallback) {
        return {
          projectId: fallback.id,
          projectName: fallback.name,
          defaultHostId: fallback.sources.find((source) => source.isDefault)?.hostId,
          environment: { type: "project-default" },
          notes,
        };
      }
    }
    if (best) {
      notes.push(`Matched cwd ${cwd} to project ${best.projectName}`);
      let safeCwd: string | null = cwd;
      if (best.hostId === "primary") {
        try {
          const realSource = realpathSync(best.path);
          const realCwd = realpathSync(cwd);
          safeCwd = isPathPrefix(realSource, realCwd) ? realCwd : null;
        } catch {
          safeCwd = null;
        }
      } else if (resolvePath(cwd) !== resolvePath(best.path)) {
        // The SDK exposes remote existence checks but no remote realpath
        // primitive. Keep remote nested workspaces on the safe project-default
        // environment until the daemon can prove canonical containment.
        safeCwd = null;
        notes.push("Could not prove remote cwd symlink containment; using project default environment");
      }
      if (safeCwd === null) {
        return {
          projectId: best.projectId,
          projectName: best.projectName,
          defaultHostId: best.defaultHostId,
          environment: { type: "project-default" },
          notes,
        };
      }
      // Prefer an unmanaged workspace at the original cwd on the source host.
      try {
        const res = await bb.sdk.hosts.pathsExist({
          hostId: best.hostId,
          paths: [safeCwd],
        });
        if (res.existence[safeCwd]) {
          notes.push("The historical cwd was verified, but rehydration uses the project-default workspace to avoid a symlink race during spawn");
          return {
            projectId: best.projectId,
            projectName: best.projectName,
            defaultHostId: best.defaultHostId,
            environment: { type: "project-default" },
            notes,
          };
        }
        notes.push(`cwd ${safeCwd} no longer exists; using project default environment`);
      } catch {
        notes.push(`Could not verify cwd on host; using project default environment`);
      }
      return {
        projectId: best.projectId,
        projectName: best.projectName,
        defaultHostId: best.defaultHostId,
        environment: { type: "project-default" },
        notes,
      };
    }
  }

  // 3. Fall back to the personal project.
  const personal = projects.find((p) => p.kind === "personal");
  if (personal) {
    notes.push(`No project matched cwd; falling back to personal project ${personal.name}`);
    return {
      projectId: personal.id,
      projectName: personal.name,
      defaultHostId: personal.sources.find((source) => source.isDefault)?.hostId,
      environment: { type: "project-default" },
      notes,
    };
  }

  // 4. Last resort: first standard project.
  const first = projects.find((p) => p.kind === "standard") ?? projects[0];
  if (!first) throw new Error("No bb project available to rehydrate into");
  notes.push(`Falling back to project ${first.name}`);
  return {
    projectId: first.id,
    projectName: first.name,
    defaultHostId: first.sources.find((source) => source.isDefault)?.hostId,
    environment: { type: "project-default" },
    notes,
  };
}

/** Resolve the bb provider to use (null = project default). */
async function resolveProvider(
  bb: BbPluginApi,
  sourceProvider: ProviderId,
  explicitProviderId?: string,
  hostId?: string,
): Promise<string | null> {
  let providers;
  try {
    providers = await bb.sdk.providers.list(hostId ? { hostId } : undefined);
  } catch {
    if (explicitProviderId) {
      throw new Error(`Requested provider ${explicitProviderId} could not be verified`);
    }
    return null;
  }
  const available = new Set(providers.filter((p) => p.available).map((p) => p.id));
  if (explicitProviderId) {
    if (!available.has(explicitProviderId)) {
      throw new Error(`Requested provider ${explicitProviderId} is not available`);
    }
    return explicitProviderId;
  }
  const suggested = PROVIDER_DEFAULTS[sourceProvider];
  return suggested && available.has(suggested) ? suggested : null;
}

export async function rehydrateSession(
  bb: BbPluginApi,
  row: SessionRow,
  opts: { projectId?: string; providerId?: string; mode?: RehydrateMode },
): Promise<RehydrateResult> {
  const meta = rowToMeta(row);
  const mode = opts.mode ?? "full";
  const prompt = buildRehydratePrompt(meta, mode);

  const target = await resolveTarget(bb, meta, opts.projectId);
  const targetHostId = target.defaultHostId;
  const provider = await resolveProvider(
    bb,
    meta.provider,
    opts.providerId,
    targetHostId,
  );

  const notes = [...target.notes];
  notes.push(provider ? `Provider: ${provider}` : "Provider: project default");

  const title =
    meta.title === "Untitled session"
      ? `${meta.title} (${meta.providerSessionId.slice(0, 8)})`
      : meta.title;

  const spawnArgs = (
    env: { type: "project-default" },
    prov: string | null,
    model?: string,
  ) => ({
    projectId: target.projectId,
    ...(prov ? { providerId: prov } : {}),
    ...(model ? { model } : {}),
    title,
    prompt,
    environment: env,
  });

  /** Resolve a model id for a provider (first listed model). */
  const firstModel = async (prov: string, hostId?: string): Promise<string | null> => {
    try {
      const res = hostId
        ? await bb.sdk.providers.models({ providerId: prov, hostId })
        : await bb.sdk.providers.models({ providerId: prov });
      const def = res.models.find((m) => m.isDefault);
      const first = res.models[0];
      return (def ?? first)?.id ?? (def ?? first)?.model ?? null;
    } catch {
      return null;
    }
  };

  let thread;
  let usedProvider: string | null = provider;
  let modelUsed: string | null = null;
  try {
    thread = await bb.sdk.threads.spawn(spawnArgs(target.environment, provider));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Missing stored execution defaults for the requested provider → resolve
    // a model for it and retry.
    if (provider && /model is required/i.test(message)) {
      const model = await firstModel(provider, targetHostId);
      if (model) {
        modelUsed = model;
        thread = await bb.sdk.threads.spawn(
          spawnArgs(target.environment, provider, model),
        );
        notes.push(`Resolved model ${model} for provider ${provider}`);
      } else if (opts.providerId) {
        throw new Error(`Requested provider ${provider} has no available model on the target host`);
      } else {
        const fallbackHostId = target.defaultHostId;
        const fallbackProvider = await resolveProvider(
          bb,
          meta.provider,
          undefined,
          fallbackHostId,
        );
        notes.push(
          `Provider ${provider} has no model defaults on the matched host; falling back to project defaults`,
        );
        thread = await bb.sdk.threads.spawn(spawnArgs({ type: "project-default" }, fallbackProvider));
        usedProvider = fallbackProvider;
      }
    } else {
      throw err;
    }
  }

  return {
    threadId: thread.id,
    threadTitle: title,
    project: { id: target.projectId, name: target.projectName },
    environment: { kind: "project-default" },
    provider: usedProvider,
    inputChars: prompt.length,
    notes: modelUsed ? [...notes, `Model: ${modelUsed}`] : notes,
  };
}

/** Resolve the host that will actually run a rehydrated session. */
export async function resolveRehydrateHostId(
  bb: BbPluginApi,
  row: SessionRow,
  projectId?: string,
): Promise<string | undefined> {
  const target = await resolveTarget(bb, rowToMeta(row), projectId);
  return target.defaultHostId;
}
