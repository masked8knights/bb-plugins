import path from "node:path";
import type { BbPluginApi } from "@bb/plugin-sdk";
import type { DocumentSource, ResolvedDocumentTarget } from "./types";

function requireRelativePath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(normalized)
  ) {
    throw new Error("Document paths must be relative to their document root");
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("Document paths cannot contain empty or parent segments");
  }
  return parts.join("/");
}

function requireAbsolutePath(filePath: string): {
  normalized: string;
  api: typeof path.posix | typeof path.win32;
} {
  const isWindowsPath = /^[a-zA-Z]:[\\/]/u.test(filePath) || filePath.startsWith("\\\\");
  const api = isWindowsPath ? path.win32 : path.posix;
  if (!api.isAbsolute(filePath)) {
    throw new Error("Host document paths must be absolute");
  }
  return { normalized: api.normalize(filePath), api };
}

async function resolveThreadHostId(
  bb: BbPluginApi,
  threadId: string,
): Promise<string | null> {
  const thread = await bb.sdk.threads.get({
    threadId,
    include: "environment",
  });
  if (!("environment" in thread) || !thread.environment) return null;
  return thread.environment.hostId;
}

export async function resolveDocumentTarget(
  bb: BbPluginApi,
  source: DocumentSource,
  filePath: string,
): Promise<ResolvedDocumentTarget> {
  if (source.kind === "workspace") {
    if (!source.environmentId) {
      throw new Error("Workspace documents need an environment id");
    }
    const relativePath = requireRelativePath(filePath);
    const environment = await bb.sdk.environments.get({
      environmentId: source.environmentId,
    });
    if (!environment.path) {
      throw new Error("The document environment has no workspace path");
    }
    const root = requireAbsolutePath(environment.path);
    return {
      filePath: root.api.join(root.normalized, ...relativePath.split("/")),
      rootPath: root.normalized,
      displayPath: relativePath,
      hostId: environment.hostId,
    };
  }

  if (source.kind === "host") {
    const resolved = requireAbsolutePath(filePath);
    const hostId = source.hostId ??
      (source.threadId ? await resolveThreadHostId(bb, source.threadId) : null);
    return {
      filePath: resolved.normalized,
      rootPath: resolved.api.dirname(resolved.normalized),
      displayPath: resolved.normalized,
      ...(hostId ? { hostId } : {}),
    };
  }

  if (!source.threadId) {
    throw new Error("Thread storage documents need a thread id");
  }
  const relativePath = requireRelativePath(filePath);
  const [thread, storage] = await Promise.all([
    bb.sdk.threads.get({
      threadId: source.threadId,
      include: "environment",
    }),
    bb.sdk.threads.storageFiles({
      threadId: source.threadId,
      limit: "1",
    }),
  ]);
  if (!("environment" in thread) || !thread.environment) {
    throw new Error("The thread has no environment for its storage files");
  }
  const root = requireAbsolutePath(storage.storageRootPath);
  return {
    filePath: root.api.join(root.normalized, ...relativePath.split("/")),
    rootPath: root.normalized,
    displayPath: relativePath,
    hostId: thread.environment.hostId,
  };
}

export function canonicalDocumentPath(
  source: DocumentSource,
  target: ResolvedDocumentTarget,
): string {
  return source.kind === "host" ? target.filePath : target.displayPath;
}
