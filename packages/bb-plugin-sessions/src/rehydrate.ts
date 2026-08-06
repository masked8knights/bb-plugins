// Rehydration: create a BB thread that continues an external provider session.

import type { BbPluginApi } from "@bb/plugin-sdk";
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
    truncated: row.truncated === 1,
    sizeBytes: row.sizeBytes,
    mtimeMs: row.mtimeMs,
  };
}

function isPathPrefix(parent: string, child: string): boolean {
  const a = parent.replace(/\/+$/, "");
  const b = child;
  return b === a || b.startsWith(a + "/");
}

interface ResolvedTarget {
  projectId: string;
  projectName: string;
  environment:
    | { type: "host"; hostId?: string; workspace: { type: "unmanaged"; path: string } }
    | { type: "project-default" };
  notes: string[];
}

async function resolveTarget(
  bb: BbPluginApi,
  session: SessionMeta,
  explicitProjectId?: string,
): Promise<ResolvedTarget> {
  const notes: string[] = [];
  const projects = await bb.sdk.projects.list({ includePersonal: true });
  const cwd = session.cwd;

  // 1. Explicit project wins when provided.
  if (explicitProjectId) {
    const p = projects.find((x) => x.id === explicitProjectId);
    if (p) {
      notes.push(`Using explicit project ${p.name}`);
      return {
        projectId: p.id,
        projectName: p.name,
        environment: { type: "project-default" },
        notes,
      };
    }
    notes.push(`Requested project ${explicitProjectId} not found; resolving from cwd`);
  }

  // 2. Deepest project source whose path contains the session cwd.
  if (cwd) {
    let best:
      | { projectId: string; projectName: string; hostId: string; path: string; depth: number }
      | undefined;
    for (const p of projects) {
      for (const src of p.sources) {
        if (isPathPrefix(src.path, cwd)) {
          if (!best || src.path.length > best.depth) {
            best = {
              projectId: p.id,
              projectName: p.name,
              hostId: src.hostId,
              path: src.path,
              depth: src.path.length,
            };
          }
        }
      }
    }
    if (best) {
      notes.push(`Matched cwd ${cwd} to project ${best.projectName}`);
      // Prefer an unmanaged workspace at the original cwd on the source host.
      try {
        const res = await bb.sdk.hosts.pathsExist({
          hostId: best.hostId,
          paths: [cwd],
        });
        if (res.existence[cwd]) {
          return {
            projectId: best.projectId,
            projectName: best.projectName,
            environment: {
              type: "host",
              hostId: best.hostId,
              workspace: { type: "unmanaged", path: cwd },
            },
            notes,
          };
        }
        notes.push(`cwd ${cwd} no longer exists; using project default environment`);
      } catch {
        notes.push(`Could not verify cwd on host; using project default environment`);
      }
      return {
        projectId: best.projectId,
        projectName: best.projectName,
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
    environment: { type: "project-default" },
    notes,
  };
}

/** Resolve the bb provider to use (null = project default). */
async function resolveProvider(
  bb: BbPluginApi,
  sourceProvider: ProviderId,
  explicitProviderId?: string,
): Promise<string | null> {
  let providers;
  try {
    providers = await bb.sdk.providers.list();
  } catch {
    return explicitProviderId ?? null;
  }
  const available = new Set(providers.map((p) => p.id));
  if (explicitProviderId) {
    return available.has(explicitProviderId) ? explicitProviderId : null;
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
  const provider = await resolveProvider(bb, meta.provider, opts.providerId);

  const notes = [...target.notes];
  notes.push(provider ? `Provider: ${provider}` : "Provider: project default");

  const title =
    meta.title === "Untitled session"
      ? `${meta.title} (${meta.providerSessionId.slice(0, 8)})`
      : meta.title;

  const spawnArgs = (
    env: ResolvedTarget["environment"],
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
  const firstModel = async (prov: string): Promise<string | null> => {
    try {
      const res = await bb.sdk.providers.models({ providerId: prov });
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
      const model = await firstModel(provider);
      if (model) {
        modelUsed = model;
        thread = await bb.sdk.threads.spawn(
          spawnArgs(target.environment, provider, model),
        );
        notes.push(`Resolved model ${model} for provider ${provider}`);
      } else {
        notes.push(
          `Provider ${provider} has no model defaults and no discoverable models; falling back to project defaults`,
        );
        thread = await bb.sdk.threads.spawn(spawnArgs(target.environment, null));
        usedProvider = null;
      }
    } else if (target.environment.type === "host") {
      // Unmanaged-workspace environment failed → retry with project default.
      notes.push(
        `Unmanaged workspace spawn failed (${message}); retrying with project default`,
      );
      thread = await bb.sdk.threads.spawn(
        spawnArgs({ type: "project-default" }, provider),
      );
    } else {
      throw err;
    }
  }

  return {
    threadId: thread.id,
    threadTitle: title,
    project: { id: target.projectId, name: target.projectName },
    environment:
      target.environment.type === "host"
        ? {
            kind: "unmanaged",
            path: target.environment.workspace.path,
            hostId: target.environment.hostId,
          }
        : { kind: "project-default" },
    provider: usedProvider,
    inputChars: prompt.length,
    notes: modelUsed ? [...notes, `Model: ${modelUsed}`] : notes,
  };
}
