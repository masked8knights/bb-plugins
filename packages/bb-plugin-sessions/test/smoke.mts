// Smoke test: parse real provider files and run the indexer against a temp db.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createIndexer, migrateDb } from "../src/indexer.ts";
import { isIgnoredSessionPath } from "../src/sources.ts";
import { buildRichTelemetryDashboard, buildTelemetryDashboard } from "../src/telemetry.ts";
import type { IndexSettings } from "../src/types.ts";

const settings: IndexSettings = {
  piEnabled: true,
  piPath: "~/.pi/agent/sessions",
  primeEnabled: true,
  primePath: "~/.prime/agent/sessions",
  ompEnabled: true,
  ompPath: "~/.omp/agent/sessions",
  hermesEnabled: true,
  hermesPath: "~/.hermes/state.db",
  codexEnabled: true,
  codexPath: "~/.codex/sessions",
  claudeEnabled: true,
  claudePath: "~/.claude/projects",
  opencodeEnabled: true,
  opencodePath: "~/.local/share/opencode/opencode.db",
};

assert.equal(isIgnoredSessionPath("claude", "/tmp/CodexBar-ClaudeProbe/session.jsonl"), true);
assert.equal(isIgnoredSessionPath("claude", "/Users/patrick/workingdir/neon-pilot/session.jsonl"), false);

// node:sqlite does not implement better-sqlite3's API identically; the indexer
// uses db.prepare().run/.get/.all — close enough for a smoke test.
const dir = mkdtempSync(join(tmpdir(), "sessions-test-"));
const db = new DatabaseSync(join(dir, "test.db"));
// Provide the better-sqlite3-ish surface used by migrateDb/indexer.
const fake = {
  exec: (sql) => { db.exec(sql); },
  prepare: (sql) => db.prepare(sql),
  transaction: (fn) => fn,
};
migrateDb(fake);

const events = [];
const indexer = createIndexer({
  db: fake,
  kv: { get: async () => undefined, set: async () => {} },
  log: (m) => console.log("LOG:", m),
  publish: (p) => events.push(p),
  getSettings: async () => settings,
});

const started = Date.now();
const res = await indexer.ensureIndexed({ force: true });
console.log("INDEX RESULT:", JSON.stringify(res));
console.log("elapsed ms:", Date.now() - started);
console.log("last event:", JSON.stringify(events[events.length - 1]));

const status = indexer.status(settings, Date.now());
console.log("STATUS:", JSON.stringify(status, null, 1));

const indexedProviders = new Set(status.providers.filter((p) => p.count > 0).map((p) => p.id));
for (const expected of ["pi", "prime", "omp", "hermes", "codex", "claude"] as const) {
  assert.equal(indexedProviders.has(expected), true, `expected indexed provider ${expected}`);
}
assert.equal(status.providers.find((p) => p.id === "pi")?.detected, true, "Pi store should be detected");
assert.equal(status.providers.find((p) => p.id === "prime")?.detected, true, "Prime Agent store should be detected");
assert.equal(indexer.search("", ["prime"], 10).length > 0, true, "Prime Agent sessions should stay attributed to Prime Agent");
const hermesRows = indexer.search("", ["hermes"], 1_000);
assert.equal(hermesRows.length > 0, true, "Hermes sessions should be indexed");
assert.equal(hermesRows.every((row) => row.id.startsWith("hermes:") && row.filePath?.startsWith("hermes-db:")), true, "Hermes ids must stay distinct from Pi");
const dashboard = buildTelemetryDashboard(fake, "lifetime");
assert.equal(dashboard.totals.sessions, status.totalSessions, "telemetry and search must share one session count");
assert.equal(dashboard.providers.some((row) => row.provider === "hermes"), true, "telemetry must retain Hermes as its own provider");
const richDashboard = buildRichTelemetryDashboard(
  fake as never,
  { view: "provider", range: "7d" },
  [],
);
assert.equal(richDashboard.range, "7d", "rich telemetry should preserve the selected range");
assert.equal(richDashboard.totals.sessions <= status.totalSessions, true, "rich telemetry should apply the range filter");
assert.equal(richDashboard.daily.length > 0, true, "rich telemetry should expose daily series data");
assert.equal(Array.isArray(richDashboard.models), true, "rich telemetry should expose model breakdown data");
const piDashboard = buildRichTelemetryDashboard(
  fake as never,
  { view: "provider", range: "lifetime", providers: ["pi"] },
  [],
);
assert.equal(piDashboard.totals.sessions, status.providers.find((p) => p.id === "pi")?.count, "provider filters should constrain rich telemetry to the selected source");
for (const q of ["neon", "sidebar", "ds4", "protocol probe"]) {
  const rows = indexer.search(q, undefined, 5);
  console.log(`\nSEARCH "${q}": ${rows.length} hits`);
  for (const r of rows.slice(0, 5)) {
    console.log(`  [${r.provider}] ${r.title} | ${r.cwd ?? ""} | ${r.messageCount} msgs | ${r.id}`);
  }
}

const any = indexer.search("", undefined, 5);
if (any.length) {
  const one = indexer.get(any[0].id);
  console.log("\nGET:", one.id, "| msgs:", one.messageCount, "| transcript len:", one.transcript.length, "| first:", JSON.stringify(one.firstUserMessage?.slice(0, 120)));
}
for (const r of any) {
  console.log(`  [${r.provider}] ${r.title.slice(0, 60)} | msgs=${r.messageCount} | updated=${r.updatedAt ? new Date(r.updatedAt).toISOString().slice(0,10) : "?"}`);
}

// Incremental pass: should re-parse ~nothing.
const t0 = Date.now();
const res2 = await indexer.ensureIndexed({ force: false });
console.log("\nINCREMENTAL:", JSON.stringify(res2.byProvider), "elapsed:", Date.now() - t0, "ms");

// Third pass: should converge toward ~0 for quiet stores.
const t1 = Date.now();
const res3 = await indexer.ensureIndexed({ force: false });
console.log("\nPASS3:", JSON.stringify(res3.byProvider), "elapsed:", Date.now() - t1, "ms");

// Sample one codex transcript for quality.
const codexRows = indexer.search("", ["codex"], 3);
if (codexRows.length) {
  const c = indexer.get(codexRows[0].id);
  assert.equal(c.truncated, 0, "stored transcripts should not use the old 300 KB cap");
  console.log("\nCODEX SAMPLE:", c.id, "|", c.title);
  console.log(c.transcript.slice(0, 900));
}

indexer.dispose();
rmSync(dir, { recursive: true, force: true });
console.log("\nSMOKE OK");
