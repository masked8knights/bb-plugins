import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { AnalyticsStore, MIGRATIONS } from "./src/db";
import {
  LEGACY_MIGRATION_ID,
  LEGACY_PLUGIN_ID,
  migrateLegacyPluginState,
  TELEMETRY_PLUGIN_ID,
} from "./src/legacy-migration";
import { emptyCapabilities, type ProviderSessionRecord } from "./src/types";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
  for (const root of fixtureRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("legacy Telemetry state migration", () => {
  it("copies the old database and shared namespaces once, leaving the old state intact", async () => {
    const host = createFakePluginHost({ pluginId: TELEMETRY_PLUGIN_ID, settings: { autoIndex: false } });
    hosts.push(host);
    const database = host.bb.storage.database();
    host.bb.storage.migrate(database, MIGRATIONS);
    const store = new AnalyticsStore(database);
    const session: ProviderSessionRecord = {
      id: "legacy-session-1",
      source: "provider",
      provider: "codex",
      hostId: "primary",
      providerSessionId: "provider-session-1",
      bbThreadId: null,
      title: "Migrated session",
      cwd: "/workspace",
      projectId: null,
      model: "gpt-5",
      origin: "codex",
      status: "completed",
      startedAt: 1,
      updatedAt: 2,
      durationMs: 1000,
      messageCount: 2,
      turnCount: 1,
      toolCalls: 1,
      toolErrors: 0,
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 20,
      reasoningTokens: 0,
      totalTokens: 30,
      contextPeak: 0.25,
      compactionCount: 0,
      failureCount: 0,
      delegatedCount: 0,
      archived: false,
      coverage: emptyCapabilities("complete"),
      storeLabel: "legacy store",
      fingerprint: "legacy-fingerprint",
      linkState: "none",
      findingCount: 0,
    };
    store.replaceProviderSession(session, [], [], [], []);

    const fixtureRoot = mkdtempSync(join("/tmp", "telemetry-legacy-fixture-"));
    fixtureRoots.push(fixtureRoot);
    const legacyPath = join(fixtureRoot, LEGACY_PLUGIN_ID, "data.db");
    const bbPath = join(fixtureRoot, "bb.db");
    mkdirSync(join(fixtureRoot, LEGACY_PLUGIN_ID), { recursive: true });

    database.prepare("ATTACH DATABASE ? AS legacy_fixture").run(legacyPath);
    database.exec("CREATE TABLE legacy_fixture.analytics_sessions AS SELECT * FROM main.analytics_sessions WHERE 0");
    database.exec("INSERT INTO legacy_fixture.analytics_sessions SELECT * FROM main.analytics_sessions WHERE id = 'legacy-session-1'");
    database.prepare("DELETE FROM main.analytics_sessions WHERE id = ?").run(session.id);
    database.exec("DETACH DATABASE legacy_fixture");

    database.prepare("ATTACH DATABASE ? AS bb_fixture").run(bbPath);
    database.exec(`
      CREATE TABLE bb_fixture.plugin_settings (
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (plugin_id, key)
      );
      CREATE TABLE bb_fixture.plugin_kv (
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (plugin_id, key)
      );
      INSERT INTO bb_fixture.plugin_settings VALUES ('agent-analytics', 'defaultRange', '30d', 10);
      INSERT INTO bb_fixture.plugin_kv VALUES ('agent-analytics', 'lastIndexedAt', '123', 10);
    `);
    database.exec("DETACH DATABASE bb_fixture");

    const result = migrateLegacyPluginState(database, {
      bbDatabasePath: bbPath,
      legacyPluginDatabasePath: legacyPath,
    });

    expect(result).toMatchObject({
      applied: true,
      copiedDatabaseRows: 1,
      copiedSettingsRows: 1,
      copiedKvRows: 1,
    });
    expect(database.prepare("SELECT title FROM analytics_sessions WHERE id = ?").get(session.id)).toMatchObject({
      title: "Migrated session",
    });

    database.prepare("ATTACH DATABASE ? AS bb_assert").run(bbPath);
    expect(database.prepare("SELECT plugin_id, value FROM bb_assert.plugin_settings WHERE key = 'defaultRange' ORDER BY plugin_id").all()).toEqual([
      { plugin_id: LEGACY_PLUGIN_ID, value: "30d" },
      { plugin_id: TELEMETRY_PLUGIN_ID, value: "30d" },
    ]);
    expect(database.prepare("SELECT plugin_id, value FROM bb_assert.plugin_kv WHERE key = 'lastIndexedAt' ORDER BY plugin_id").all()).toEqual([
      { plugin_id: LEGACY_PLUGIN_ID, value: "123" },
      { plugin_id: TELEMETRY_PLUGIN_ID, value: "123" },
    ]);
    database.exec("DETACH DATABASE bb_assert");

    const second = migrateLegacyPluginState(database, {
      bbDatabasePath: bbPath,
      legacyPluginDatabasePath: legacyPath,
    });
    expect(second).toMatchObject({ alreadyApplied: true, applied: false });
    expect(database.prepare("SELECT id FROM telemetry_state_migrations WHERE id = ?").get(LEGACY_MIGRATION_ID)).toBeTruthy();
  });
});
