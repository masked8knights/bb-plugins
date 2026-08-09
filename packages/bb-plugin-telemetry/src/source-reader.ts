import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { getSource } from "./source-registry";
import { MAX_SOURCE_BYTES, parseProviderJsonl, parseProviderMetadataSession } from "./providers";
import type {
  CapabilityReport,
  ParsedProviderSession,
  ProviderId,
  ProviderSessionRecord,
  SourceSettings,
} from "./types";
import { emptyCapabilities } from "./types";

export interface HostContext {
  id: string;
  name: string;
  homePath: string;
  connected: boolean;
}

export interface SourceScanResult {
  provider: ProviderId;
  hostId: string;
  pathLabel: string;
  storeKind: "jsonl" | "sqlite";
  detected: boolean;
  remoteDatabaseUnsupported: boolean;
  records: ParsedProviderSession[];
  count: number;
  capabilities: CapabilityReport;
  error: string | null;
  warning: string | null;
  truncated: boolean;
  skippedStoreLabels: string[];
}

function joinHome(homePath: string, configured: string): string {
  const value = configured.trim();
  const base = homePath.trim() || homedir();
  if (value === "~") return base;
  if (value.startsWith("~/")) return join(base, value.slice(2));
  return isAbsolute(value) ? value : join(base, value);
}

function mergeCapabilities(records: ParsedProviderSession[]): CapabilityReport {
  const report = emptyCapabilities();
  if (!records.length) return report;
  for (const capability of Object.keys(report) as Array<keyof CapabilityReport>) {
    const levels = records.map((record) => record.session.coverage[capability]);
    report[capability] = levels.includes("complete")
      ? "complete"
      : levels.includes("partial")
        ? "partial"
        : "unavailable";
  }
  return report;
}

const CODEXBAR_MARKER = "codexbar";

export function isCodexBarPath(path: string): boolean {
  return path.toLowerCase().includes(CODEXBAR_MARKER);
}

export function isCodexBarSession(session: ProviderSessionRecord): boolean {
  return session.cwd !== null && isCodexBarPath(session.cwd);
}

function excludedCodexBarWarning(count: number): string | null {
  if (!count) return null;
  return `Excluded ${count} CodexBar session${count === 1 ? "" : "s"}.`;
}

export async function resolveHost(
  bb: BbPluginApi,
  requestedHostId = "",
): Promise<HostContext> {
  if (!requestedHostId || requestedHostId === "primary") {
    return { id: "primary", name: "Primary host", homePath: homedir(), connected: true };
  }
  const hosts = await bb.sdk.hosts.list();
  const selected = hosts.find((host) => host.id === requestedHostId);
  if (!selected) {
    return { id: requestedHostId, name: "Unavailable host", homePath: "", connected: false };
  }
  try {
    const directory = await bb.sdk.hosts.directory({ hostId: selected.id });
    return {
      id: selected.id,
      name: selected.name,
      homePath: directory.directory,
      connected: selected.status === "connected",
    };
  } catch {
    return {
      id: selected.id,
      name: selected.name,
      homePath: "",
      connected: false,
    };
  }
}

async function listJsonlFiles(
  bb: BbPluginApi,
  hostId: string,
  rootPath: string,
): Promise<{ paths: string[]; truncated: boolean }> {
  type ListedPath = { kind: "file" | "directory"; path: string };
  const result = await bb.sdk.files.listPaths({
    hostId: hostId === "primary" ? undefined : hostId,
    path: rootPath,
    query: ".jsonl",
    limit: 5000,
    includeFiles: true,
    includeDirectories: false,
  });
  return {
    paths: result.paths
      .filter((entry: ListedPath) => entry.kind === "file")
      .map((entry: ListedPath) => (isAbsolute(entry.path) ? entry.path : join(rootPath, entry.path)))
      .filter((filePath: string) => filePath.toLowerCase().endsWith(".jsonl")),
    truncated: result.truncated,
  };
}

async function readTextFile(bb: BbPluginApi, hostId: string, path: string): Promise<{ content: string; fingerprint: string }> {
  if (hostId === "primary" && existsSync(path)) {
    const sizeBytes = statSync(path).size;
    if (sizeBytes > MAX_SOURCE_BYTES) throw new Error(`file size ${sizeBytes} exceeds ${MAX_SOURCE_BYTES} byte limit`);
    const content = await readFile(path, "utf8");
    return { content, fingerprint: createHash("sha256").update(content).digest("hex") };
  }
  const result = await bb.sdk.files.read({ hostId: hostId === "primary" ? undefined : hostId, path });
  const content = result.contentEncoding === "base64"
    ? Buffer.from(result.content, "base64").toString("utf8")
    : result.content;
  return { content, fingerprint: result.sha256 };
}

function isFileSizeLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:HTTP\s*)?413\b|file size .* exceeds .*limit/i.test(message);
}

function fileMetadata(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.size}:${Math.round(stat.mtimeMs)}:${Math.round(stat.ctimeMs)}`;
  } catch {
    return "missing";
  }
}

export function databaseFingerprint(path: string): string {
  // SQLite WAL writes can leave the main database's size and mtime unchanged.
  // Include both sidecars so a committed provider update invalidates the
  // session fingerprint even before a checkpoint folds it into the .db file.
  return [path, `${path}-wal`, `${path}-shm`]
    .map(fileMetadata)
    .join("|");
}

function parsedRecordRichness(record: ParsedProviderSession): number {
  return record.turns.length * 4 + record.items.length * 4 + record.usage.length * 2 + record.evidence.length;
}

function combineParsedRecords(left: ParsedProviderSession, right: ParsedProviderSession): ParsedProviderSession {
  const primary = parsedRecordRichness(right) > parsedRecordRichness(left) ? right : left;
  const secondary = primary === left ? right : left;
  const primarySession = primary.session;
  const secondarySession = secondary.session;
  const fingerprints = [primarySession.fingerprint, secondarySession.fingerprint]
    .filter((value): value is string => Boolean(value))
    .sort();
  return {
    session: {
      ...secondarySession,
      ...primarySession,
      title: primarySession.title.startsWith("Untitled ") ? secondarySession.title : primarySession.title,
      cwd: primarySession.cwd ?? secondarySession.cwd,
      projectId: primarySession.projectId ?? secondarySession.projectId,
      model: primarySession.model ?? secondarySession.model,
      origin: primarySession.origin ?? secondarySession.origin,
      startedAt: primarySession.startedAt === null
        ? secondarySession.startedAt
        : secondarySession.startedAt === null
          ? primarySession.startedAt
          : Math.min(primarySession.startedAt, secondarySession.startedAt),
      updatedAt: primarySession.updatedAt === null
        ? secondarySession.updatedAt
        : secondarySession.updatedAt === null
          ? primarySession.updatedAt
          : Math.max(primarySession.updatedAt, secondarySession.updatedAt),
      messageCount: Math.max(primarySession.messageCount, secondarySession.messageCount),
      archived: primarySession.archived || secondarySession.archived,
      fingerprint: fingerprints.length
        ? createHash("sha256").update(fingerprints.join("\u0000")).digest("hex")
        : null,
    },
    turns: primary.turns.length ? primary.turns : secondary.turns,
    items: primary.items.length ? primary.items : secondary.items,
    usage: primary.usage.length ? primary.usage : secondary.usage,
    evidence: primary.evidence.length ? primary.evidence : secondary.evidence,
  };
}

export function mergeParsedRecords(records: ParsedProviderSession[]): ParsedProviderSession[] {
  const byId = new Map<string, ParsedProviderSession>();
  for (const record of records) {
    const existing = byId.get(record.session.id);
    byId.set(record.session.id, existing ? combineParsedRecords(existing, record) : record);
  }
  return [...byId.values()];
}

function sqliteRows(
  provider: "opencode" | "prime",
  path: string,
  hostId: string,
  fingerprint: string,
): ParsedProviderSession[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (provider === "opencode") {
      const rows = db.prepare(
        `SELECT id, title, directory, time_created AS timeCreated, time_updated AS timeUpdated
         FROM session ORDER BY time_updated DESC`,
      ).all() as Array<Record<string, unknown>>;
      return rows.map((row) =>
        parseProviderMetadataSession({
          provider,
          hostId,
          providerSessionId: String(row.id),
          path,
          title: typeof row.title === "string" ? row.title : null,
          cwd: typeof row.directory === "string" ? row.directory : null,
          startedAt: typeof row.timeCreated === "number" ? row.timeCreated : null,
          updatedAt: typeof row.timeUpdated === "number" ? row.timeUpdated : null,
          origin: "opencode",
          fingerprint,
        }),
      );
    }
    const rows = db.prepare(
      `SELECT s.id, s.source, s.title, s.display_name AS displayName,
              s.cwd, s.started_at AS startedAt, s.last_activity_at AS lastActivityAt,
              s.message_count AS messageCount,
              (SELECT model FROM session_model_usage u
               WHERE u.session_id = s.id ORDER BY u.last_seen DESC LIMIT 1) AS model
       FROM sessions s ORDER BY s.last_activity_at DESC`,
    ).all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const started = typeof row.startedAt === "number" ? row.startedAt * 1000 : null;
      const updated = typeof row.lastActivityAt === "number" ? row.lastActivityAt * 1000 : started;
      return parseProviderMetadataSession({
        provider,
        hostId,
        providerSessionId: String(row.id),
        path,
        title: typeof row.title === "string" ? row.title : typeof row.displayName === "string" ? row.displayName : null,
        cwd: typeof row.cwd === "string" ? row.cwd : null,
        model: typeof row.model === "string" ? row.model : null,
        origin: typeof row.source === "string" ? row.source : "hermes",
        startedAt: started,
        updatedAt: updated,
        messageCount: typeof row.messageCount === "number" ? row.messageCount : 0,
        fingerprint,
      });
    });
  } finally {
    db.close();
  }
}

export async function scanProviderSource(
  bb: BbPluginApi,
  settings: SourceSettings,
  provider: ProviderId,
  host: HostContext,
): Promise<SourceScanResult> {
  const source = getSource(provider);
  const config = settings.sources[provider];
  const pathLabel = config.path || source.defaultPath;
  const pathLabels = [pathLabel];
  if (source.archivePath && source.archivePath !== pathLabel) pathLabels.push(source.archivePath);
  const combinedPathLabel = pathLabels.join(" + ");
  const sourceHostId = config.hostId || settings.hostId || host.id;
  const sourceHost = sourceHostId === host.id ? host : await resolveHost(bb, sourceHostId);
  const base: SourceScanResult = {
    provider,
    hostId: sourceHost.id,
    pathLabel: combinedPathLabel,
    storeKind: source.storeKind,
    detected: false,
    remoteDatabaseUnsupported: false,
    records: [],
    count: 0,
    capabilities: emptyCapabilities(),
    error: null,
    warning: null,
    truncated: false,
    skippedStoreLabels: [],
  };

  if (!config.enabled) return base;
  if (!sourceHost.connected || !sourceHost.homePath) {
    return { ...base, error: `Source host "${sourceHost.name}" is unavailable` };
  }
  if (source.storeKind === "sqlite") {
    if (sourceHost.id !== "primary") {
      return { ...base, remoteDatabaseUnsupported: true, error: "Remote database reading is not supported yet" };
    }
    const localPath = joinHome(homedir(), pathLabel);
    if (!localPath || !existsSync(localPath)) return base;
    try {
      const fingerprint = databaseFingerprint(localPath);
      const parsedRecords = sqliteRows(provider as "opencode", localPath, "primary", fingerprint);
      const records = settings.excludeCodexBar
        ? parsedRecords.filter((record) => !isCodexBarSession(record.session))
        : parsedRecords;
      return {
        ...base,
        hostId: "primary",
        detected: records.length > 0,
        records,
        count: records.length,
        capabilities: mergeCapabilities(records),
        warning: excludedCodexBarWarning(parsedRecords.length - records.length),
      };
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : String(error) };
    }
  }

  try {
    const records: ParsedProviderSession[] = [];
    let skippedOversized = 0;
    let excludedCodexBar = 0;
    let detected = false;
    let truncated = false;
    const skippedStoreLabels: string[] = [];
    const warnings: string[] = [];
    const seenPaths = new Set<string>();
    for (const [rootIndex, rootLabel] of pathLabels.entries()) {
      const rootPath = joinHome(sourceHost.homePath, rootLabel);
      const rootIsArchive = rootIndex > 0;
      let listing: { paths: string[]; truncated: boolean };
      try {
        listing = await listJsonlFiles(bb, sourceHost.id, rootPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rootIsArchive) warnings.push(`Could not scan archived Codex sessions: ${message}`);
        else base.error = message;
        continue;
      }
      detected ||= listing.paths.length > 0;
      truncated ||= listing.truncated;
      if (listing.truncated) warnings.push(`The JSONL file listing for ${rootLabel} was truncated at 5,000 paths; refresh after narrowing the source path.`);
      for (const path of listing.paths) {
        if (seenPaths.has(path)) continue;
        seenPaths.add(path);
        if (settings.excludeCodexBar && isCodexBarPath(path)) {
          excludedCodexBar += 1;
          continue;
        }
        try {
          const file = await readTextFile(bb, sourceHost.id, path);
          if (Buffer.byteLength(file.content, "utf8") > MAX_SOURCE_BYTES) {
            skippedOversized += 1;
            skippedStoreLabels.push(path.split("/").at(-1) ?? path);
            continue;
          }
          const parsed = parseProviderJsonl(provider, sourceHost.id, path, file.content, file.fingerprint);
          if (parsed) {
            if (settings.excludeCodexBar && isCodexBarSession(parsed.session)) {
              excludedCodexBar += 1;
              continue;
            }
            if (rootIsArchive) parsed.session.archived = true;
            records.push(parsed);
          }
        } catch (error) {
          if (isFileSizeLimitError(error)) {
            skippedOversized += 1;
            skippedStoreLabels.push(path.split("/").at(-1) ?? path);
          }
          else if (rootIsArchive) warnings.push(`Could not read archived Codex session: ${error instanceof Error ? error.message : String(error)}`);
          else base.error = error instanceof Error ? error.message : String(error);
        }
      }
    }
    if (provider === "prime" && !config.hostId && !settings.hostId && sourceHost.id === "primary") {
      const dbLabel = getSource(provider).defaultDbPath;
      if (dbLabel) {
        const dbPath = joinHome(sourceHost.homePath, dbLabel);
        const localDbPath = joinHome(homedir(), dbLabel);
        if (existsSync(localDbPath)) {
          try {
            records.push(...sqliteRows("prime", localDbPath, "primary", databaseFingerprint(localDbPath)));
          } catch (error) {
            base.error = error instanceof Error ? error.message : String(error);
          }
        }
      }
    }
    if (skippedOversized > 0) warnings.push(`Skipped ${skippedOversized} oversized JSONL file${skippedOversized === 1 ? "" : "s"}; individual files are capped at ${Math.round(MAX_SOURCE_BYTES / (1024 * 1024))} MiB.`);
    const codexBarWarning = excludedCodexBarWarning(excludedCodexBar);
    if (codexBarWarning) warnings.push(codexBarWarning);
    const mergedRecords = mergeParsedRecords(records);
    return {
      ...base,
      detected: detected || mergedRecords.length > 0,
      records: mergedRecords,
      count: mergedRecords.length,
      capabilities: mergeCapabilities(mergedRecords),
      truncated,
      skippedStoreLabels,
      warning: warnings.length ? warnings.join(" ") : null,
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}
