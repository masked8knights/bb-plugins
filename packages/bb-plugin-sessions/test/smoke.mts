// Smoke test: parse real provider files and run the indexer against a temp db.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIndexer, migrateDb } from "../src/indexer.ts";
import type { IndexSettings } from "../src/types.ts";

const settings: IndexSettings = {
  codexEnabled: true,
  codexPath: "~/.codex/sessions",
  claudeEnabled: true,
  claudePath: "~/.claude/projects",
  primeEnabled: true,
  primePath: "~/.prime/agent/sessions",
  primeDbPath: "~/.hermes/state.db",
  opencodeEnabled: true,
  opencodePath: "~/.local/share/opencode/opencode.db",
  ompEnabled: true,
  ompPath: "~/.omp/agent/sessions",
};

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
  console.log("\nCODEX SAMPLE:", c.id, "|", c.title);
  console.log(c.transcript.slice(0, 900));
}

indexer.dispose();
rmSync(dir, { recursive: true, force: true });
console.log("\nSMOKE OK");
