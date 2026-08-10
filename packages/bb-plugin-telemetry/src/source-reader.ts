import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { getSource } from "./source-registry";
import { createProviderJsonlParser, MAX_SOURCE_BYTES, parseProviderJsonl, parseProviderMetadataSession } from "./providers";
import type {
  CapabilityReport,
  ParsedProviderSession,
  ProviderId,
  ProviderSessionRecord,
  SessionStatus,
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
  /** Fingerprints for every listed file (skip-cache rows to persist). */
  files: Map<string, { fingerprint: string; sessionId: string | null }>;
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

/** bb's server-side cap for files.listPaths; request the max so large stores
 *  (e.g. Claude Code with thousands of session files) are not truncated. */
const JSONL_LIST_LIMIT = 10_000;

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
    limit: JSONL_LIST_LIMIT,
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

/**
 * Read a JSONL file on a remote host via bb's file API (whole content,
 * capped at MAX_SOURCE_BYTES). The primary host streams files directly
 * instead — see streamProviderJsonl — so multi-hundred-MB sessions are
 * never buffered in memory.
 */
async function readTextFile(bb: BbPluginApi, hostId: string, path: string): Promise<{ content: string; fingerprint: string }> {
  const result = await bb.sdk.files.read({ hostId: hostId === "primary" ? undefined : hostId, path });
  const content = result.contentEncoding === "base64"
    ? Buffer.from(result.content, "base64").toString("utf8")
    : result.content;
  return { content, fingerprint: result.sha256 };
}

/**
 * Stream one JSONL file on the primary host: lines are parsed one at a time,
 * so a session file of any size indexes in bounded memory. The caller has
 * already stat-checked the file against the stored fingerprint, so no content
 * hash is computed here.
 */
async function streamProviderJsonl(
  provider: ProviderId,
  hostId: string,
  path: string,
  fingerprint: string,
): Promise<ParsedProviderSession | null> {
  const parser = createProviderJsonlParser(provider, hostId, path);
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let index = 0;
  for await (const line of lines) {
    parser.processLine(line, index);
    index += 1;
  }
  return parser.finish(fingerprint);
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

/**
 * Stat-based fingerprint for one JSONL file. Unlike a content hash this can
 * be computed without reading the file, so unchanged sessions are skipped by
 * the incremental scan instead of re-read and re-parsed every few minutes.
 * The path is included so identical stat triples on different files (e.g. the
 * shared Pi / Prime Agent store) never collide across providers.
 */
function jsonlFingerprint(path: string): string {
  try {
    const stat = statSync(path);
    return `${path}:${stat.size}:${Math.round(stat.mtimeMs)}:${Math.round(stat.ctimeMs)}:${stat.ino}`;
  } catch {
    return `${path}:missing`;
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
  // Status precedence: a failed/completed verdict from either half wins over
  // a provisional "active" (e.g. the JSONL opening `session_state:active`
  // vs. hermes `ended_at`).
  const statusRank: Record<SessionStatus, number> = { failed: 3, completed: 2, active: 1, unknown: 0 };
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
      status: statusRank[primarySession.status] >= statusRank[secondarySession.status]
        ? primarySession.status
        : secondarySession.status,
      inputTokens: primarySession.inputTokens ?? secondarySession.inputTokens,
      cachedInputTokens: primarySession.cachedInputTokens ?? secondarySession.cachedInputTokens,
      cachedWriteTokens: primarySession.cachedWriteTokens ?? secondarySession.cachedWriteTokens,
      outputTokens: primarySession.outputTokens ?? secondarySession.outputTokens,
      reasoningTokens: primarySession.reasoningTokens ?? secondarySession.reasoningTokens,
      totalTokens: primarySession.totalTokens ?? secondarySession.totalTokens,
      toolCalls: Math.max(primarySession.toolCalls, secondarySession.toolCalls),
      toolErrors: Math.max(primarySession.toolErrors, secondarySession.toolErrors),
      costUsd: primarySession.costUsd ?? secondarySession.costUsd,
      costEstimated: primarySession.costUsd !== null ? primarySession.costEstimated : secondarySession.costEstimated,
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
  provider: "opencode" | "pi",
  path: string,
  hostId: string,
  fingerprint: string,
): ParsedProviderSession[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (provider === "opencode") {
      // opencode keeps per-message token and cost data in the `message` table
      // (JSON `data` column) and tool calls in `part`; the session table alone
      // only carries titles and timestamps.
      const rows = db.prepare(
        `SELECT s.id, s.title, s.directory,
                s.time_created AS timeCreated, s.time_updated AS timeUpdated,
                COALESCE(m.messageCount, 0) AS messageCount,
                m.inputTokens, m.outputTokens, m.reasoningTokens,
                m.cacheRead, m.cacheWrite, m.cost,
                (SELECT json_extract(m2.data, '$.modelID') FROM message m2
                 WHERE m2.session_id = s.id AND json_extract(m2.data, '$.modelID') IS NOT NULL
                 ORDER BY m2.time_created DESC LIMIT 1) AS modelID,
                COALESCE(t.toolCount, 0) AS toolCount,
                COALESCE(t.toolErrors, 0) AS toolErrors
         FROM session s
         LEFT JOIN (
           SELECT session_id,
                  COUNT(*) AS messageCount,
                  SUM(json_extract(data, '$.tokens.input')) AS inputTokens,
                  SUM(json_extract(data, '$.tokens.output')) AS outputTokens,
                  SUM(json_extract(data, '$.tokens.reasoning')) AS reasoningTokens,
                  SUM(json_extract(data, '$.tokens.cache.read')) AS cacheRead,
                  SUM(json_extract(data, '$.tokens.cache.write')) AS cacheWrite,
                  SUM(json_extract(data, '$.cost')) AS cost
           FROM message GROUP BY session_id
         ) m ON m.session_id = s.id
         LEFT JOIN (
           SELECT session_id, COUNT(*) AS toolCount,
                  SUM(CASE WHEN json_extract(data, '$.state.status') IN ('error', 'failed') THEN 1 ELSE 0 END) AS toolErrors
           FROM part WHERE json_extract(data, '$.type') = 'tool' GROUP BY session_id
         ) t ON t.session_id = s.id
         ORDER BY s.time_updated DESC`,
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
          messageCount: typeof row.messageCount === "number" ? row.messageCount : 0,
          toolCalls: typeof row.toolCount === "number" ? row.toolCount : 0,
          toolErrors: typeof row.toolErrors === "number" ? row.toolErrors : 0,
          inputTokens: typeof row.inputTokens === "number" ? row.inputTokens : null,
          outputTokens: typeof row.outputTokens === "number" ? row.outputTokens : null,
          reasoningTokens: typeof row.reasoningTokens === "number" ? row.reasoningTokens : null,
          cachedInputTokens: typeof row.cacheRead === "number" ? row.cacheRead : null,
          cachedWriteTokens: typeof row.cacheWrite === "number" ? row.cacheWrite : null,
          costUsd: typeof row.cost === "number" ? row.cost : null,
          costEstimated: false,
          model: typeof row.modelID === "string" ? row.modelID : null,
          fingerprint,
        }),
      );
    }
    // The hermes daemon store backs Pi (sources: acp, cron, desktop,
    // subagent, telegram, tui); it is scanned only under the pi provider.
    const rows = db.prepare(
      `SELECT s.id, s.source, s.title, s.display_name AS displayName,
              s.cwd, s.started_at AS startedAt, s.last_activity_at AS lastActivityAt,
              s.message_count AS messageCount, s.tool_call_count AS toolCallCount,
              s.input_tokens AS inputTokens, s.output_tokens AS outputTokens,
              s.cache_read_tokens AS cacheReadTokens, s.cache_write_tokens AS cacheWriteTokens,
              s.reasoning_tokens AS reasoningTokens, s.archived AS archived,
              s.estimated_cost_usd AS estimatedCostUsd, s.actual_cost_usd AS actualCostUsd,
              s.ended_at AS endedAt, s.end_reason AS endReason,
              COALESCE((SELECT SUM(estimated_cost_usd) FROM session_model_usage u
               WHERE u.session_id = s.id), 0) AS usageEstimatedCost,
              COALESCE((SELECT SUM(actual_cost_usd) FROM session_model_usage u
               WHERE u.session_id = s.id), 0) AS usageActualCost,
              COALESCE(s.model, (SELECT model FROM session_model_usage u
               WHERE u.session_id = s.id ORDER BY u.last_seen DESC LIMIT 1)) AS model
       FROM sessions s ORDER BY s.last_activity_at DESC`,
    ).all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const started = typeof row.startedAt === "number" ? row.startedAt * 1000 : null;
      const updated = typeof row.lastActivityAt === "number" ? row.lastActivityAt * 1000 : started;
      const actual = typeof row.actualCostUsd === "number" && row.actualCostUsd > 0 ? row.actualCostUsd
        : typeof row.usageActualCost === "number" && row.usageActualCost > 0 ? row.usageActualCost
        : null;
      const estimated = typeof row.estimatedCostUsd === "number" && row.estimatedCostUsd > 0 ? row.estimatedCostUsd
        : typeof row.usageEstimatedCost === "number" && row.usageEstimatedCost > 0 ? row.usageEstimatedCost
        : null;
      const endReason = typeof row.endReason === "string" ? row.endReason.toLowerCase() : "";
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
        toolCalls: typeof row.toolCallCount === "number" ? row.toolCallCount : 0,
        inputTokens: typeof row.inputTokens === "number" ? row.inputTokens : null,
        outputTokens: typeof row.outputTokens === "number" ? row.outputTokens : null,
        cachedInputTokens: typeof row.cacheReadTokens === "number" ? row.cacheReadTokens : null,
        cachedWriteTokens: typeof row.cacheWriteTokens === "number" ? row.cacheWriteTokens : null,
        reasoningTokens: typeof row.reasoningTokens === "number" ? row.reasoningTokens : null,
        costUsd: actual ?? estimated,
        costEstimated: actual === null,
        status: /fail|error|abort|cancel/.test(endReason) ? "failed" : row.endedAt !== null && row.endedAt !== undefined ? "completed" : undefined,
        archived: row.archived === 1 || row.archived === true,
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
  options: {
    /** Full reindex: re-read every file regardless of fingerprints. */
    full?: boolean;
    /** Per-file fingerprint cache for incremental scans (primary host only). */
    existingFiles?: Map<string, { fingerprint: string; sessionId: string | null }>;
  } = {},
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
    files: new Map(),
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
      if (listing.truncated) warnings.push(`The JSONL file listing for ${rootLabel} was truncated at ${JSONL_LIST_LIMIT.toLocaleString()} paths; refresh after narrowing the source path.`);
      for (const path of listing.paths) {
        if (seenPaths.has(path)) continue;
        seenPaths.add(path);
        if (settings.excludeCodexBar && isCodexBarPath(path)) {
          excludedCodexBar += 1;
          continue;
        }
        try {
          // Primary host: stat the file and skip it entirely (no read, no
          // parse) when the stored fingerprint already matches — the
          // incremental scan then only touches files that actually changed.
          // Remote hosts go through bb's file API, which returns whole
          // content and stays capped at MAX_SOURCE_BYTES.
          let parsed: ParsedProviderSession | null;
          if (sourceHost.id === "primary") {
            const fingerprint = jsonlFingerprint(path);
            const existing = options.existingFiles?.get(path);
            if (!options.full && existing !== undefined && existing.fingerprint === fingerprint) {
              base.files.set(path, { fingerprint, sessionId: existing.sessionId });
              skippedStoreLabels.push(path.split("/").at(-1) ?? path);
              continue;
            }
            parsed = await streamProviderJsonl(provider, sourceHost.id, path, fingerprint);
            base.files.set(path, { fingerprint, sessionId: parsed?.session.id ?? null });
          } else {
            const file = await readTextFile(bb, sourceHost.id, path);
            if (Buffer.byteLength(file.content, "utf8") > MAX_SOURCE_BYTES) {
              skippedOversized += 1;
              skippedStoreLabels.push(path.split("/").at(-1) ?? path);
              continue;
            }
            parsed = parseProviderJsonl(provider, sourceHost.id, path, file.content, file.fingerprint);
          }
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
    if (provider === "pi" && !config.hostId && !settings.hostId && sourceHost.id === "primary") {
      const dbLabel = getSource(provider).defaultDbPath;
      if (dbLabel) {
        const dbPath = joinHome(sourceHost.homePath, dbLabel);
        const localDbPath = joinHome(homedir(), dbLabel);
        if (existsSync(localDbPath)) {
          try {
            records.push(...sqliteRows("pi", localDbPath, "primary", databaseFingerprint(localDbPath)));
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
