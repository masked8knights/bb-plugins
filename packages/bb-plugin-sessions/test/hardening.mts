import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIndexer,
  deleteSession,
  migrateDb,
  upsertSession,
  walkJsonl,
  walkedRootsStable,
} from "../src/indexer.ts";
import { parseJsonlStreaming } from "../src/streaming.ts";
import { buildRichTelemetryDashboard, buildTelemetryDashboard } from "../src/telemetry.ts";
import { buildRehydratePrompt } from "../src/format.ts";
import { isPathPrefix } from "../src/rehydrate.ts";
import { openOpenCodeDb, readHermesConversation, readHermesSessions, readOpenCodeConversation } from "../src/parsers.ts";
import { canonicalStorePath, PROVIDER_SOURCES, resolveSourceRoots } from "../src/sources.ts";
import { defaultIndexSettings, emptySessionAnalytics, type IndexSettings, type SessionMeta } from "../src/types.ts";
import { providerLabel } from "../src/provider-labels.ts";
import { SOURCE_STALE_AFTER_MS, sourceIsStale } from "../src/source-freshness.ts";

const dir = mkdtempSync(join(tmpdir(), "sessions-hardening-test-"));
const db = new DatabaseSync(join(dir, "index.db"));
const fake = {
  exec: (sql: string) => db.exec(sql),
  prepare: (sql: string) => db.prepare(sql),
  transaction: <T>(fn: () => T) => fn,
};
migrateDb(fake as never);

const migrationFailureDb = new DatabaseSync(join(dir, "migration-failure.db"));
const migrationFailure = {
  exec: (sql: string) => {
    if (sql.includes("ALTER TABLE sessions ADD COLUMN status")) throw new Error("SQLITE_BUSY: migration fixture");
    return migrationFailureDb.exec(sql);
  },
  prepare: (sql: string) => migrationFailureDb.prepare(sql),
  transaction: <T>(fn: () => T) => fn,
};
assert.throws(() => migrateDb(migrationFailure as never), /SQLITE_BUSY/, "required migration failures must not be treated as already applied");
migrationFailureDb.close();

const providerDb = new DatabaseSync(join(dir, "provider.db"));
providerDb.exec("CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, timestamp REAL)");
providerDb.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)").run("hermes-fixture", "user", "hello", 1);
providerDb.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)").run("hermes-fixture", "tool", JSON.stringify({ name: "shell", output: "ok" }), 2);
providerDb.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)").run("hermes-fixture", "assistant", "done", 3);
const hermesConversation = readHermesConversation(providerDb, "hermes-fixture");
assert.deepEqual(hermesConversation.trace.map((entry) => entry.kind), ["user", "tool", "assistant"], "Hermes tool messages should appear in the trace");
assert.equal(hermesConversation.trace[1]?.toolName, "shell");
providerDb.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)").run("hermes-null-payload", "user", null, 4);
const hermesNullConversation = readHermesConversation(providerDb, "hermes-null-payload");
assert.equal(hermesNullConversation.parseFailed, true, "a NULL Hermes payload must be a partial read");
const longHermesText = "h".repeat(40_000);
providerDb.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)").run("hermes-long-payload", "user", longHermesText, 5);
const longHermesConversation = readHermesConversation(providerDb, "hermes-long-payload");
assert.equal(longHermesConversation.parseFailed, false, "large valid Hermes content must parse successfully");
assert.equal(longHermesConversation.messages[0]?.text.length, longHermesText.length, "large Hermes content must not be silently truncated");

providerDb.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
providerDb.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER)");
providerDb.exec("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT, time_created INTEGER)");
providerDb.prepare("INSERT INTO session VALUES (?)").run("opencode-fixture");
providerDb.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m-user", "opencode-fixture", JSON.stringify({ role: "user", time: { created: 10 } }), 10);
providerDb.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run("p-user", "m-user", JSON.stringify({ type: "text", text: "hello" }), 10);
providerDb.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m-tool", "opencode-fixture", JSON.stringify({ role: "assistant", time: { created: 11 } }), 11);
providerDb.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run("p-tool", "m-tool", JSON.stringify({ type: "tool", tool: "shell", state: { status: "completed" }, output: "ok" }), 11);
const openCodeConversation = readOpenCodeConversation(providerDb, "opencode-fixture");
assert.deepEqual(openCodeConversation.trace.map((entry) => entry.kind), ["user", "tool"], "opencode tool parts should appear in the trace");
assert.equal(openCodeConversation.trace[1]?.toolName, "shell");
providerDb.prepare("INSERT INTO session VALUES (?)").run("opencode-multipart");
providerDb.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m-multipart", "opencode-multipart", JSON.stringify({ role: "assistant", time: { created: 12 } }), 12);
providerDb.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run("p-multipart-1", "m-multipart", JSON.stringify({ type: "text", text: "first part" }), 12);
providerDb.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run("p-multipart-2", "m-multipart", JSON.stringify({ type: "text", text: "second part" }), 13);
const multipartConversation = readOpenCodeConversation(providerDb, "opencode-multipart");
assert.equal(multipartConversation.messages.length, 1, "opencode text parts in one message should stay one transcript message");
assert.equal(multipartConversation.messages[0]?.text, "first part\nsecond part");
providerDb.prepare("INSERT INTO session VALUES (?)").run("opencode-null-payload");
providerDb.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m-null", "opencode-null-payload", null, 14);
const nullPayloadConversation = readOpenCodeConversation(providerDb, "opencode-null-payload");
assert.equal(nullPayloadConversation.parseFailed, true, "a NULL OpenCode payload must be a partial read");
providerDb.exec("INSERT INTO session VALUES ('opencode-long-payload')");
providerDb.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m-long", "opencode-long-payload", JSON.stringify({ role: "user", time: { created: 17 } }), 17);
providerDb.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run("p-long", "m-long", JSON.stringify({ type: "text", text: "o".repeat(40_000) }), 17);
const longOpenCodeConversation = readOpenCodeConversation(providerDb, "opencode-long-payload");
assert.equal(longOpenCodeConversation.parseFailed, false, "large valid OpenCode payloads must parse successfully");
assert.equal(longOpenCodeConversation.messages[0]?.text.length, 40_000, "large OpenCode text must be bounded after parsing, not before");
providerDb.prepare("INSERT INTO session VALUES (?)").run("opencode-empty-object");
providerDb.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m-empty-object", "opencode-empty-object", "{}", 15);
const emptyObjectConversation = readOpenCodeConversation(providerDb, "opencode-empty-object");
assert.equal(emptyObjectConversation.parseFailed, true, "an OpenCode payload without a role must be a partial read");
providerDb.prepare("INSERT INTO session VALUES (?)").run("opencode-no-part");
providerDb.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m-no-part", "opencode-no-part", JSON.stringify({ role: "user" }), 16);
const noPartConversation = readOpenCodeConversation(providerDb, "opencode-no-part");
assert.equal(noPartConversation.parseFailed, true, "an OpenCode message without parts must be a partial read");

const trace = [{
  id: "tool-1",
  kind: "tool" as const,
  title: "Run raretoolxyz",
  text: "Input: {}\nOutput: needle_payload_xyz",
  timestamp: Date.now(),
  status: "completed" as const,
  toolName: "raretoolxyz",
  sourceSequence: 1,
}];
const makeMeta = (id: string, filePath: string, provider: "pi" | "opencode" = "pi"): SessionMeta => ({
  id,
  provider,
  providerSessionId: id.slice(id.indexOf(":") + 1),
  filePath,
  title: "Hardening fixture",
  cwd: "/tmp/rare-session-path-xyz",
  gitRepoRoot: null,
  startedAt: Date.now(),
  updatedAt: Date.now(),
  model: "fixture-model",
  origin: "fixture",
  messageCount: 1,
  summary: null,
  firstUserMessage: "Find raretoolxyz",
  transcript: "## User\n\nFind raretoolxyz",
  truncated: false,
  sizeBytes: 42,
  mtimeMs: Date.now(),
  trace,
  analytics: {
    ...emptySessionAnalytics(),
    status: "completed",
    turnCount: 1,
    toolCalls: 1,
    totalTokens: 3,
  },
});

upsertSession(fake as never, makeMeta("pi:fixture", "/tmp/rare-session-path-xyz.jsonl"));
upsertSession(fake as never, { ...makeMeta("pi:archived-fixture", "/tmp/archived-fixture.jsonl"), archived: true });
assert.equal(
  (db.prepare("SELECT archived FROM sessions WHERE id = ?").get("pi:archived-fixture") as { archived: number }).archived,
  1,
  "archive provenance must persist in the session row",
);
deleteSession(fake as never, "pi:archived-fixture");

const indexer = createIndexer({
  db: fake as never,
  kv: { get: async () => undefined, set: async () => undefined },
  log: (message) => console.error(`QUEUE LOG: ${message}`),
  publish: (progress) => console.error(`QUEUE PROGRESS: ${progress.phase} ${progress.provider ?? ""}`),
  getSettings: async () => defaultIndexSettings(),
});

assert.equal(indexer.searchWithTotal("raretoolxyz", ["pi"], 10).total, 1, "tool names should be searchable");
assert.equal(indexer.searchWithTotal("needle_payload_xyz", ["pi"], 10).total, 1, "tool payload text should be searchable");
assert.equal(indexer.searchWithTotal("rare-session-path-xyz", ["pi"], 10).total, 1, "file paths should be searchable");
assert.equal(indexer.searchWithTotal("\u0000", ["pi"], 10).total, 0, "control-only search terms must not widen to an empty search");
upsertSession(fake as never, { ...makeMeta("pi:project-a", "/tmp/project-a/session.jsonl"), cwd: "/tmp/project-a" });
upsertSession(fake as never, { ...makeMeta("pi:project-b", "/tmp/project-b/session.jsonl"), cwd: "/tmp/project-b" });
upsertSession(fake as never, {
  ...makeMeta("pi:project-traversal", "/tmp/project-a/../secret/session.jsonl"),
  cwd: "/tmp/project-a/../secret",
});
assert.equal(indexer.searchWithTotal("fixture", ["pi"], 10, { roots: ["/tmp/project-a"] }).total, 1, "scoped search must exclude sessions from other projects");
assert.equal(buildTelemetryDashboard(fake as never, "lifetime", ["pi"], Date.now(), { roots: ["/tmp/project-a"] }).totals.sessions, 1, "scoped telemetry must exclude sessions from other projects");
assert.equal(indexer.get("pi:project-b", { roots: ["/tmp/project-a"] }), undefined, "scoped reads must exclude sessions from other projects");
assert.equal(indexer.get("pi:project-traversal", { roots: ["/tmp/project-a"] }), undefined, "scoped reads must reject traversal paths");
assert.equal(buildTelemetryDashboard(fake as never, "lifetime", ["pi"], Date.now(), { roots: ["/tmp/project-%"] }).totals.sessions, 0, "scoped telemetry must treat roots literally");
deleteSession(fake as never, "pi:project-a");
deleteSession(fake as never, "pi:project-b");
deleteSession(fake as never, "pi:project-traversal");
assert.deepEqual(indexer.searchWithTotal("fixture", [], 10), { rows: [], total: 0 }, "an explicit empty provider filter must stay empty");
assert.deepEqual(indexer.searchWithTotal("fixture", ["pi", "unknown" as never], 10), { rows: [], total: 0 }, "a mixed invalid provider filter must fail closed");
assert.equal(buildTelemetryDashboard(fake as never, "lifetime", ["unknown-provider"]).totals.sessions, 0, "unknown telemetry providers must not widen the query");
assert.equal(buildTelemetryDashboard(fake as never, "lifetime", ["pi", "unknown-provider"]).totals.sessions, 0, "a mixed invalid telemetry filter must fail closed");
assert.equal(buildRichTelemetryDashboard(fake as never, { view: "unified", range: "lifetime", providers: ["pi", "unknown-provider"] }, []).totals.sessions, 0, "rich telemetry must fail closed for mixed invalid providers");
assert.equal(
  db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'session_trace_entries'").get().c,
  0,
  "fresh indexes should not create a redundant trace table",
);

// Migration must repair a partial FTS row-set, not just an empty table.
const ftsOne = "pi:fts-repair-one";
const ftsTwo = "pi:fts-repair-two";
upsertSession(fake as never, makeMeta(ftsOne, "/tmp/fts-repair-one.jsonl"));
upsertSession(fake as never, makeMeta(ftsTwo, "/tmp/fts-repair-two.jsonl"));
const ftsRow = db.prepare("SELECT rowid FROM sessions WHERE id = ?").get(ftsTwo) as { rowid: number };
db.prepare("DELETE FROM sessions_fts WHERE rowid = ?").run(ftsRow.rowid);
assert.equal(indexer.searchWithTotal("fixture", ["pi"], 10).total, 2, "the corrupted FTS row should be absent before migration");
migrateDb(fake as never);
assert.equal(indexer.searchWithTotal("fixture", ["pi"], 10).total, 3, "migration should rebuild a partial FTS row-set");
deleteSession(fake as never, ftsOne);
deleteSession(fake as never, ftsTwo);

// Legacy Hermes stores may not have the optional model-usage table.
const legacyHermesDb = new DatabaseSync(join(dir, "legacy-hermes.db"));
legacyHermesDb.exec(`
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT,
    title TEXT,
    display_name TEXT,
    cwd TEXT,
    git_repo_root TEXT,
    started_at REAL,
    last_activity_at REAL,
    message_count INTEGER
  )
`);
legacyHermesDb.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
  "legacy-hermes",
  "fixture",
  "Legacy Hermes",
  null,
  dir,
  null,
  1,
  2,
  1,
);
const legacyHermesRows = readHermesSessions(legacyHermesDb);
assert.equal(legacyHermesRows[0]?.model, null, "legacy Hermes rows should not require session_model_usage");
legacyHermesDb.close();

const brokenRoot = join(dir, "not-a-directory");
writeFileSync(brokenRoot, "not a directory");
assert.equal(walkJsonl(join(dir, "missing-archive"), true).complete, true, "missing optional archives should not fail a scan");
assert.equal(walkJsonl(join(dir, "missing-primary"), false).complete, false, "missing primary roots must preserve existing rows");
const brokenSettings: IndexSettings = {
  ...defaultIndexSettings(),
  piEnabled: true,
  piPath: brokenRoot,
  primeEnabled: false,
  ompEnabled: false,
  hermesEnabled: false,
  codexEnabled: false,
  claudeEnabled: false,
  opencodeEnabled: false,
};
const brokenIndexer = createIndexer({
  db: fake as never,
  kv: { get: async () => undefined, set: async () => undefined },
  log: () => undefined,
  publish: () => undefined,
  getSettings: async () => brokenSettings,
});
const failedScan = await brokenIndexer.ensureIndexed({ force: true, providers: ["pi"] });
assert.equal(failedScan.removed, 0, "an incomplete JSONL scan must not prune existing rows");
assert.deepEqual(failedScan.completedProviders, [], "an incomplete source must not be marked as completed");
assert.ok(brokenIndexer.get("pi:fixture"), "existing rows must survive an incomplete scan");
assert.match(brokenIndexer.status(brokenSettings, null).error ?? "", /completed with warnings/, "partial scans should surface a durable overall error");
assert.ok(brokenIndexer.status(brokenSettings, null).providers.find((p) => p.id === "pi")?.lastWarning, "incomplete scans should be visible as warnings");
const reloadedWarningIndexer = createIndexer({
  db: fake as never,
  kv: { get: async () => undefined, set: async () => undefined },
  log: () => undefined,
  publish: () => undefined,
  getSettings: async () => brokenSettings,
});
assert.ok(reloadedWarningIndexer.status(brokenSettings, null).providers.find((p) => p.id === "pi")?.lastWarning, "source warnings should survive an indexer reload");
let cancelledRetryIndexer!: ReturnType<typeof createIndexer>;
const cancelledRetryIndexerConfig = {
  db: fake as never,
  kv: { get: async () => undefined, set: async () => undefined },
  log: () => undefined,
  publish: (progress: { phase: string }) => {
    if (progress.phase === "scanning") cancelledRetryIndexer.dispose();
  },
  getSettings: async () => brokenSettings,
};
cancelledRetryIndexer = createIndexer(cancelledRetryIndexerConfig);
await cancelledRetryIndexer.ensureIndexed({ force: true, providers: ["pi"] });
const cancelledRetryStatus = cancelledRetryIndexer.status(brokenSettings, null);
assert.ok(
  cancelledRetryStatus.providers.find((p) => p.id === "pi")?.lastWarning,
  "a cancelled retry must not erase the previous source warning",
);
assert.equal(cancelledRetryStatus.indexing.active, false, "a cancelled scan must leave indexing inactive");
assert.equal(cancelledRetryStatus.indexing.provider, null, "a cancelled scan must clear the active provider");
assert.equal(cancelledRetryStatus.indexing.phase, "done", "a cancelled scan must publish a terminal state");
const disabledSettings = { ...brokenSettings, piEnabled: false };
assert.equal(
  brokenIndexer.status(disabledSettings, null).providers.find((p) => p.id === "pi")?.lastWarning,
  null,
  "disabled sources should not retain stale warnings",
);

const symlinkTarget = join(dir, "symlink-target");
const symlinkRoot = join(dir, "symlink-root");
mkdirSync(symlinkTarget);
symlinkSync(symlinkTarget, symlinkRoot, "dir");
assert.equal(canonicalStorePath(symlinkRoot), canonicalStorePath(symlinkTarget), "provider ownership should canonicalize path aliases");
const symlinkSettings = { ...brokenSettings, piPath: symlinkRoot };
const symlinkIndexer = createIndexer({
  db: fake as never,
  kv: { get: async () => undefined, set: async () => undefined },
  log: () => undefined,
  publish: () => undefined,
  getSettings: async () => symlinkSettings,
});
const symlinkScan = await symlinkIndexer.ensureIndexed({ force: true, providers: ["pi"] });
assert.equal(symlinkScan.removed, 0, "symlink roots must not prune existing rows");
assert.ok(symlinkIndexer.status(symlinkSettings, null).providers.find((p) => p.id === "pi")?.lastWarning, "symlink roots should be reported as incomplete");

const escapedRoot = join(dir, "escaped-root");
const escapedTarget = join(dir, "escaped-target");
mkdirSync(escapedRoot);
mkdirSync(escapedTarget);
writeFileSync(join(escapedTarget, "outside.jsonl"), "{not-a-session}\n");
symlinkSync(escapedTarget, join(escapedRoot, "linked"), "dir");
const escapedWalk = walkJsonl(escapedRoot);
assert.equal(escapedWalk.files.length, 0, "JSONL traversal must not enumerate a symlinked child directory");
assert.equal(escapedWalk.complete, false, "a symlinked child directory must make the scan incomplete");

const emptyRoot = join(dir, "empty-root");
mkdirSync(emptyRoot);
const completeSettings = { ...brokenSettings, piPath: emptyRoot };
const completeIndexer = createIndexer({
  db: fake as never,
  kv: { get: async () => undefined, set: async () => undefined },
  log: () => undefined,
  publish: () => undefined,
  getSettings: async () => completeSettings,
});
const completedScan = await completeIndexer.ensureIndexed({ force: true, providers: ["pi"] });
assert.equal(completedScan.removed, 1, "a complete empty scan should prune a genuinely removed row");
assert.equal(completeIndexer.status(completeSettings, null).providers.find((p) => p.id === "pi")?.lastWarning, null, "successful scans should clear prior warnings");
assert.ok(completeIndexer.status(completeSettings, null).providers.find((p) => p.id === "pi")?.lastIndexedAt, "successful scans should persist a source completion time");

// Aggregate token metrics must disclose mixed coverage instead of producing
// ratios that look complete when one provider row has no token telemetry.
const knownTokenId = "pi:known-token-coverage";
const missingTokenId = "pi:missing-token-coverage";
upsertSession(fake as never, makeMeta(knownTokenId, "/tmp/known-token-coverage.jsonl"));
upsertSession(fake as never, {
  ...makeMeta(missingTokenId, "/tmp/missing-token-coverage.jsonl"),
  analytics: { ...emptySessionAnalytics(), status: "completed", turnCount: 1, totalTokens: null },
});
const tokenCoverageDashboard = buildRichTelemetryDashboard(
  fake as never,
  { view: "unified", range: "lifetime", providers: ["pi"] },
  [],
);
assert.deepEqual(tokenCoverageDashboard.totals.totalTokenCoverage, { known: 1, missing: 1 }, "mixed token coverage must be explicit in aggregates");
assert.equal(tokenCoverageDashboard.providers.find((provider) => provider.provider === "pi")?.totalTokenCoverage.missing, 1);
deleteSession(fake as never, knownTokenId);
deleteSession(fake as never, missingTokenId);

// An absent auto-discovered default root is a clean no-op: it preserves
// history and counts as complete for migration bookkeeping.
const piSource = PROVIDER_SOURCES.find((source) => source.id === "pi")!;
const originalPiRoots = piSource.defaultRoots;
const missingDefaultRoot = join(dir, "auto-discovered-pi-not-installed");
upsertSession(fake as never, makeMeta("pi:fixture", "/tmp/rare-session-path-xyz.jsonl"));
piSource.defaultRoots = [missingDefaultRoot];
const missingDefaultSettings: IndexSettings = { ...completeSettings, piPath: missingDefaultRoot };
const missingDefaultIndexer = createIndexer({
  db: fake as never,
  kv: { get: async () => undefined, set: async () => undefined },
  log: () => undefined,
  publish: () => undefined,
  getSettings: async () => missingDefaultSettings,
});
const missingDefaultScan = await missingDefaultIndexer.ensureIndexed({ force: true, providers: ["pi"] });
assert.equal(missingDefaultScan.removed, 0, "missing default stores must not prune history");
assert.deepEqual(missingDefaultScan.completedProviders, ["pi"], "missing default stores count as clean no-op scans");
assert.equal(missingDefaultIndexer.status(missingDefaultSettings, null).error, null, "missing default stores must not create a durable failure");
assert.ok(missingDefaultIndexer.get("pi:fixture"), "missing default stores preserve existing history");
piSource.defaultRoots = originalPiRoots;

// A missing optional Codex archive must not prevent pruning files deleted from
// the primary Codex root. Existing archive rows are preserved separately.
const codexSource = PROVIDER_SOURCES.find((source) => source.id === "codex")!;
const originalCodexArchives = codexSource.archiveRoots;
const customCodexPath = join(dir, "custom-codex");
const customCodexRoots = resolveSourceRoots(codexSource, { ...defaultIndexSettings(), codexPath: customCodexPath });
assert.equal(customCodexRoots.includes(resolveSourceRoots(codexSource, defaultIndexSettings())[1] ?? ""), false, "custom Codex stores must not import the default user archive");
const codexPrimaryRoot = join(dir, "codex-primary");
const codexArchiveRoot = join(dir, "codex-archive-not-created");
const codexFile = join(codexPrimaryRoot, "session.jsonl");
mkdirSync(codexPrimaryRoot);
writeFileSync(codexFile, [
  { type: "session_meta", payload: { session_id: "codex-archive-prune", cwd: dir } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "codex archive prune" }] } },
  { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } },
].map((record) => JSON.stringify(record)).join("\n") + "\n");
codexSource.archiveRoots = [codexArchiveRoot];
const codexSettings: IndexSettings = {
  ...defaultIndexSettings(),
  piEnabled: false,
  primeEnabled: false,
  ompEnabled: false,
  hermesEnabled: false,
  codexEnabled: true,
  codexPath: codexPrimaryRoot,
  claudeEnabled: false,
  opencodeEnabled: false,
};
const codexIndexer = createIndexer({
  db: fake as never,
  kv: { get: async () => undefined, set: async () => undefined },
  log: () => undefined,
  publish: () => undefined,
  getSettings: async () => codexSettings,
});
const codexInitial = await codexIndexer.ensureIndexed({ force: true, providers: ["codex"] });
assert.ok(codexInitial.indexed > 0, "Codex primary fixture should index");
rmSync(codexFile);
const codexPruned = await codexIndexer.ensureIndexed({ force: true, providers: ["codex"] });
assert.equal(codexPruned.removed, 1, "missing optional archives must not block primary pruning");
assert.equal(codexIndexer.get("codex:codex-archive-prune"), undefined);
codexSource.archiveRoots = originalCodexArchives;

// Malformed OpenCode payloads are partial reads, not deletions.
providerDb.exec("ALTER TABLE session ADD COLUMN title TEXT");
providerDb.exec("ALTER TABLE session ADD COLUMN directory TEXT");
providerDb.exec("ALTER TABLE session ADD COLUMN time_created INTEGER");
providerDb.exec("ALTER TABLE session ADD COLUMN time_updated INTEGER");
providerDb.prepare("INSERT INTO session (id, title, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?)").run("opencode-bad", "Bad payload", dir, 20, 20);
providerDb.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m-bad", "opencode-bad", "{not-json", 20);
upsertSession(fake as never, makeMeta("opencode:opencode-bad", "opencode-db:opencode-bad", "opencode"));
const opencodeSettings: IndexSettings = {
  ...defaultIndexSettings(),
  piEnabled: false,
  primeEnabled: false,
  ompEnabled: false,
  hermesEnabled: false,
  codexEnabled: false,
  claudeEnabled: false,
  opencodeEnabled: true,
  opencodePath: join(dir, "provider.db"),
};
const opencodeIndexer = createIndexer({
  db: fake as never,
  kv: { get: async () => undefined, set: async () => undefined },
  log: () => undefined,
  publish: () => undefined,
  getSettings: async () => opencodeSettings,
});
const malformedScan = await opencodeIndexer.ensureIndexed({ force: true, providers: ["opencode"] });
assert.equal(malformedScan.removed, 0, "malformed OpenCode data must not prune rows");
assert.ok(opencodeIndexer.get("opencode:opencode-bad"), "malformed OpenCode data preserves the prior row");
assert.ok(opencodeIndexer.status(opencodeSettings, null).providers.find((p) => p.id === "opencode")?.lastWarning, "malformed OpenCode data creates a source warning");
assert.equal(opencodeIndexer.searchWithTotal("raretoolxyz", ["opencode"], 10).total, 1, "malformed OpenCode data preserves its FTS row");

const emptyOpenCodePath = join(dir, "empty-opencode.db");
const emptyOpenCodeDb = new DatabaseSync(emptyOpenCodePath);
emptyOpenCodeDb.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
emptyOpenCodeDb.close();
const symlinkOpenCodePath = join(dir, "symlink-opencode.db");
symlinkSync(emptyOpenCodePath, symlinkOpenCodePath);
assert.equal(openOpenCodeDb(symlinkOpenCodePath), null, "SQLite source opens must reject symlinked stores");
const symlinkOpenCodeSettings = { ...opencodeSettings, opencodePath: symlinkOpenCodePath };
const symlinkOpenCodeIndexer = createIndexer({
  db: fake as never,
  kv: { get: async () => undefined, set: async () => undefined },
  log: () => undefined,
  publish: () => undefined,
  getSettings: async () => symlinkOpenCodeSettings,
});
const symlinkOpenCodeScan = await symlinkOpenCodeIndexer.ensureIndexed({ force: true, providers: ["opencode"] });
assert.equal(symlinkOpenCodeScan.removed, 0, "an unreadable symlinked SQLite store must not prune history");
assert.ok(symlinkOpenCodeIndexer.get("opencode:opencode-bad"), "history must survive a symlinked SQLite store");

// Failed JSONL parses are incomplete scans, not successful empty sessions.
const malformedPiRoot = join(dir, "malformed-pi");
mkdirSync(malformedPiRoot);
writeFileSync(join(malformedPiRoot, "broken.jsonl"), "{not-json\n");
const malformedPiSettings = { ...completeSettings, piPath: malformedPiRoot };
const malformedPiIndexer = createIndexer({
  db: fake as never,
  kv: { get: async () => undefined, set: async () => undefined },
  log: () => undefined,
  publish: () => undefined,
  getSettings: async () => malformedPiSettings,
});
const malformedPiScan = await malformedPiIndexer.ensureIndexed({ force: true, providers: ["pi"] });
assert.deepEqual(malformedPiScan.completedProviders, [], "a failed Pi parse must not be reported as successful");
assert.ok(malformedPiIndexer.status(malformedPiSettings, null).providers.find((p) => p.id === "pi")?.lastWarning, "failed Pi parses should leave a source warning");

// A malformed Claude file must not prevent healthy logical sessions from being
// indexed. The malformed file has no prior mapping, while the healthy file has
// an explicit session id.
const claudeRoot = join(dir, "claude-root");
mkdirSync(claudeRoot);
writeFileSync(join(claudeRoot, "healthy.jsonl"), [
  { type: "user", sessionId: "claude-healthy", message: { content: [{ type: "text", text: "healthy Claude session" }] } },
  { type: "assistant", sessionId: "claude-healthy", message: { content: [{ type: "text", text: "healthy response" }] } },
].map((record) => JSON.stringify(record)).join("\n") + "\n");
writeFileSync(join(claudeRoot, "malformed.jsonl"), "{not-json\n");
const claudeSettings: IndexSettings = {
  ...defaultIndexSettings(),
  piEnabled: false,
  primeEnabled: false,
  ompEnabled: false,
  hermesEnabled: false,
  codexEnabled: false,
  claudeEnabled: true,
  claudePath: claudeRoot,
  opencodeEnabled: false,
};
const claudeIndexer = createIndexer({
  db: fake as never,
  kv: { get: async () => undefined, set: async () => undefined },
  log: () => undefined,
  publish: () => undefined,
  getSettings: async () => claudeSettings,
});
const claudeScan = await claudeIndexer.ensureIndexed({ force: true, providers: ["claude"] });
assert.equal(claudeScan.completedProviders.length, 0, "Claude partial parses should remain incomplete");
assert.ok(claudeIndexer.get("claude:claude-healthy"), "healthy Claude groups should survive a different malformed file");
assert.ok(claudeIndexer.status(claudeSettings, null).providers.find((p) => p.id === "claude")?.lastWarning, "malformed Claude files should be visible as warnings");

// A direct symlink replacement is rejected at the descriptor boundary.
const symlinkFileTarget = join(dir, "outside.jsonl");
const symlinkFile = join(dir, "checked.jsonl");
writeFileSync(symlinkFileTarget, JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "outside" }] } }));
symlinkSync(symlinkFileTarget, symlinkFile);
const symlinkFileParse = await parseJsonlStreaming("pi", symlinkFile, Date.now(), 1, "symlink");
assert.equal(symlinkFileParse.disposition, "failed", "JSONL parser must not follow a replaced symlink");

const checkedJsonl = join(dir, "checked-metadata.jsonl");
writeFileSync(checkedJsonl, JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "metadata race" }] } }) + "\n");
const checkedStat = lstatSync(checkedJsonl);
const checkedParse = await parseJsonlStreaming(
  "pi",
  checkedJsonl,
  checkedStat.mtimeMs,
  checkedStat.size + 1,
  "metadata-race",
  "primary",
  undefined,
  { dev: checkedStat.dev, ino: checkedStat.ino },
);
assert.equal(checkedParse.disposition, "failed", "a file changed since directory enumeration must not overwrite history");

const emptyIdentityRoot = join(dir, "empty-identity-root");
mkdirSync(emptyIdentityRoot);
const walkedEmptyRoot = walkJsonl(emptyIdentityRoot);
rmSync(emptyIdentityRoot, { recursive: true, force: true });
mkdirSync(emptyIdentityRoot);
assert.equal(walkedRootsStable([walkedEmptyRoot]), false, "replaced empty roots must block pruning");

const hugeTail = "x".repeat(160_000);
const condensedPrompt = buildRehydratePrompt({
  ...makeMeta("pi:large", "large.jsonl"),
  firstUserMessage: hugeTail,
  transcript: ["## User", "## Assistant", "## User", "## Assistant"].map((role) => `${role}\n\n${hugeTail}`).join("\n\n"),
  messageCount: 5,
  transcriptPreviewTruncated: false,
}, "condensed");
assert.ok(condensedPrompt.length <= 120_000, "condensed rehydration prompts must honor the aggregate context cap");

const queueDir = mkdtempSync(join(tmpdir(), "sessions-queue-test-"));
const queuePiRoot = join(queueDir, "pi");
const queueOmpRoot = join(queueDir, "omp");
const queueCodexRoot = join(queueDir, "codex");
mkdirSync(queuePiRoot);
mkdirSync(queueOmpRoot);
mkdirSync(queueCodexRoot);
writeFileSync(join(queuePiRoot, "pi.jsonl"), [
  { type: "session", id: "queue-pi", cwd: queueDir },
  { type: "message", message: { role: "user", content: [{ type: "text", text: "queue pi" }] } },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
].map((record) => JSON.stringify(record)).join("\n") + "\n");
writeFileSync(join(queueOmpRoot, "omp.jsonl"), [
  { type: "session", id: "queue-omp", cwd: queueDir },
  { type: "message", message: { role: "user", content: [{ type: "text", text: "queue omp" }] } },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
].map((record) => JSON.stringify(record)).join("\n") + "\n");
const queueSettings: IndexSettings = {
  ...defaultIndexSettings(),
  piEnabled: true,
  piPath: queuePiRoot,
  codexEnabled: true,
  codexPath: queueCodexRoot,
  ompEnabled: true,
  ompPath: queueOmpRoot,
  primeEnabled: false,
  hermesEnabled: false,
  claudeEnabled: false,
  opencodeEnabled: false,
};
let releaseQueue!: () => void;
let resolveSettingsStarted!: () => void;
const settingsStarted = new Promise<void>((resolve) => { resolveSettingsStarted = resolve; });
let settingsCalls = 0;
const queuedIndexer = createIndexer({
  db: fake as never,
  kv: { get: async () => undefined, set: async () => undefined },
  log: () => undefined,
  publish: () => undefined,
  getSettings: async () => {
    settingsCalls += 1;
    if (settingsCalls === 1) {
      resolveSettingsStarted();
      await new Promise<void>((resolve) => { releaseQueue = resolve; });
    }
    return queueSettings;
  },
});
const firstScanController = new AbortController();
const firstQueuedScan = queuedIndexer.ensureIndexed({ providers: ["pi"], signal: firstScanController.signal });
await settingsStarted;
const secondQueuedScan = queuedIndexer.ensureIndexed({ force: true, providers: ["omp"] });
firstScanController.abort();
releaseQueue();
const firstResultAfterAbort = await firstQueuedScan;
const secondResult = await secondQueuedScan;
assert.deepEqual(firstResultAfterAbort, {
  indexed: 0,
  removed: 0,
  skipped: 0,
  byProvider: {},
  completedProviders: [],
}, "the first cancelled caller should not receive shared scan results");
assert.ok(secondResult.completedProviders.includes("omp"), "a queued scoped scan must run after the active scan");
assert.ok(queuedIndexer.get("omp:queue-omp"), "the queued provider must not be silently discarded");

// Cancelling one queued caller must not cancel the merged scan another caller
// is still waiting for.
let releaseCancelledQueue!: () => void;
let cancelledSettingsStarted!: () => void;
const cancelledSettingsReady = new Promise<void>((resolve) => { cancelledSettingsStarted = resolve; });
let cancelledSettingsCalls = 0;
const cancelledProviders: string[] = [];
const cancelledQueueIndexer = createIndexer({
  db: fake as never,
  kv: { get: async () => undefined, set: async () => undefined },
  log: () => undefined,
  publish: (progress) => {
    if (progress.provider && !cancelledProviders.includes(progress.provider)) cancelledProviders.push(progress.provider);
  },
  getSettings: async () => {
    cancelledSettingsCalls += 1;
    if (cancelledSettingsCalls === 1) {
      cancelledSettingsStarted();
      await new Promise<void>((resolve) => { releaseCancelledQueue = resolve; });
    }
    return queueSettings;
  },
});
const activeCancelledQueue = cancelledQueueIndexer.ensureIndexed({ providers: ["pi"] });
await cancelledSettingsReady;
const survivingQueuedCaller = cancelledQueueIndexer.ensureIndexed({ providers: ["omp"] });
const cancelledCallerController = new AbortController();
const cancelledQueuedCaller = cancelledQueueIndexer.ensureIndexed({
  force: true,
  providers: ["codex"],
  signal: cancelledCallerController.signal,
});
cancelledCallerController.abort();
releaseCancelledQueue();
await activeCancelledQueue;
const survivingQueuedResult = await survivingQueuedCaller;
const cancelledQueuedResult = await cancelledQueuedCaller;
assert.ok(survivingQueuedResult.completedProviders.includes("omp"), "a surviving queued caller must still receive the merged scan result");
assert.equal(cancelledProviders.includes("codex"), false, "a cancelled queued provider must be removed from the shared scan scope");
assert.deepEqual(cancelledQueuedResult, {
  indexed: 0,
  removed: 0,
  skipped: 0,
  byProvider: {},
  completedProviders: [],
}, "a cancelled queued caller should receive an empty result without cancelling shared work");
rmSync(queueDir, { recursive: true, force: true });

let failOnce = true;
const lifecycleIndexer = createIndexer({
  db: fake as never,
  kv: {
    get: async () => undefined,
    set: async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("one-shot index failure");
      }
    },
  },
  log: () => undefined,
  publish: () => undefined,
  getSettings: async () => completeSettings,
});
await assert.rejects(() => lifecycleIndexer.ensureIndexed({ providers: ["pi"] }), /one-shot index failure/);
assert.match(lifecycleIndexer.status(completeSettings, null).error ?? "", /Index failed/);
await lifecycleIndexer.ensureIndexed({ providers: ["pi"] });
assert.equal(lifecycleIndexer.status(completeSettings, null).error, null, "a successful pass should clear the previous index error");

assert.equal(isPathPrefix("/tmp/project", "/tmp/project/nested"), true);
assert.equal(isPathPrefix("/tmp/project", "/tmp/project/../outside"), false, "normalized path containment must reject traversal");
assert.equal(providerLabel("claude"), "Claude Code", "browser surfaces must use the canonical Claude Code label");
assert.equal(providerLabel("claude-code"), "Claude Code", "BB provider ids must use the same canonical label");
const freshnessNow = 10_000_000;
assert.equal(sourceIsStale({ enabled: true, detected: true, lastSuccessAt: freshnessNow - SOURCE_STALE_AFTER_MS - 1 }, freshnessNow), true, "old detected sources must be stale");
assert.equal(sourceIsStale({ enabled: true, detected: true, lastSuccessAt: freshnessNow }, freshnessNow), false, "recent detected sources must be fresh");
assert.equal(sourceIsStale({ enabled: true, detected: false, lastSuccessAt: null }, freshnessNow), false, "missing stores must not be presented as stale");

rmSync(dir, { recursive: true, force: true });
console.log("HARDENING OK");
