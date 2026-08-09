import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";

export const LEGACY_PLUGIN_ID = "agent-analytics";
export const TELEMETRY_PLUGIN_ID = "telemetry";
export const LEGACY_MIGRATION_ID = `${LEGACY_PLUGIN_ID}-to-${TELEMETRY_PLUGIN_ID}-v1`;

const LEGACY_TABLES = [
  "analytics_sources",
  "analytics_sessions",
  "analytics_turns",
  "analytics_items",
  "analytics_usage",
  "analytics_events",
  "analytics_evidence",
  "analytics_session_links",
  "analytics_findings",
] as const;

type SqlRow = Record<string, unknown>;

export interface LegacyMigrationOptions {
  /** Overrides the path derived from the current plugin database. Tests use this. */
  bbDatabasePath?: string;
  /** Overrides the old plugin database path. Tests use this. */
  legacyPluginDatabasePath?: string;
}

export interface LegacyMigrationResult {
  alreadyApplied: boolean;
  currentDatabasePath: string | null;
  legacyPluginDatabasePath: string | null;
  bbDatabasePath: string | null;
  copiedDatabaseRows: number;
  copiedSettingsRows: number;
  copiedKvRows: number;
  applied: boolean;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function databasePath(database: Database.Database): string | null {
  const row = (database.prepare("PRAGMA database_list").all() as SqlRow[])
    .find((candidate) => candidate.name === "main");
  return typeof row?.file === "string" && row.file.length > 0 ? row.file : null;
}

function defaultLegacyPluginDatabasePath(currentPath: string): string {
  return join(dirname(dirname(currentPath)), LEGACY_PLUGIN_ID, "data.db");
}

function defaultBbDatabasePath(currentPath: string): string {
  return join(dirname(dirname(dirname(currentPath))), "bb.db");
}

function hasTable(database: Database.Database, schema: string, table: string): boolean {
  return Boolean(database
    .prepare(`SELECT 1 AS present FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
    .get(table));
}

function tableColumns(database: Database.Database, schema: string, table: string): string[] {
  return (database
    .prepare(`PRAGMA ${schema}.table_info(${quoteIdentifier(table)})`)
    .all() as SqlRow[])
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string");
}

function copyAnalyticsTable(database: Database.Database, table: string): number {
  if (!hasTable(database, "legacy_plugin", table) || !hasTable(database, "main", table)) return 0;
  const legacyColumns = new Set(tableColumns(database, "legacy_plugin", table));
  const columns = tableColumns(database, "main", table).filter((column) => legacyColumns.has(column));
  if (columns.length === 0) return 0;
  const quotedColumns = columns.map(quoteIdentifier).join(", ");
  return database
    .prepare(`INSERT OR IGNORE INTO main.${quoteIdentifier(table)} (${quotedColumns}) SELECT ${quotedColumns} FROM legacy_plugin.${quoteIdentifier(table)}`)
    .run().changes;
}

function copyNamespacedRows(
  database: Database.Database,
  table: "plugin_settings" | "plugin_kv",
): number {
  if (!hasTable(database, "bb_state", table)) return 0;
  return database
    .prepare(`
      INSERT OR IGNORE INTO bb_state.${quoteIdentifier(table)} (plugin_id, key, value, updated_at)
      SELECT ?, key, value, updated_at
      FROM bb_state.${quoteIdentifier(table)}
      WHERE plugin_id = ?
    `)
    .run(TELEMETRY_PLUGIN_ID, LEGACY_PLUGIN_ID).changes;
}

function oldNamespacedRowCount(
  database: Database.Database,
  table: "plugin_settings" | "plugin_kv",
): number {
  if (!hasTable(database, "bb_state", table)) return 0;
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM bb_state.${quoteIdentifier(table)} WHERE plugin_id = ?`)
    .get(LEGACY_PLUGIN_ID) as SqlRow | undefined;
  return Number(row?.count ?? 0);
}

/**
 * Preserve state from the pre-rename plugin ID on the first Telemetry load.
 *
 * The SDK intentionally exposes only the current plugin's storage namespace,
 * so this uses the current SQLite handle to attach the old database and the
 * shared bb database. Both copies happen in one transaction; the old files and
 * old namespace remain untouched so a rollback can still use them.
 */
export function migrateLegacyPluginState(
  database: Database.Database,
  options: LegacyMigrationOptions = {},
): LegacyMigrationResult {
  const currentPath = databasePath(database);
  const empty: LegacyMigrationResult = {
    alreadyApplied: false,
    currentDatabasePath: currentPath,
    legacyPluginDatabasePath: null,
    bbDatabasePath: null,
    copiedDatabaseRows: 0,
    copiedSettingsRows: 0,
    copiedKvRows: 0,
    applied: false,
  };
  if (!currentPath) return empty;

  database.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_state_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
  if (database
    .prepare("SELECT 1 FROM telemetry_state_migrations WHERE id = ? LIMIT 1")
    .get(LEGACY_MIGRATION_ID)) {
    return { ...empty, alreadyApplied: true };
  }

  const legacyPath = options.legacyPluginDatabasePath ?? defaultLegacyPluginDatabasePath(currentPath);
  const bbPath = options.bbDatabasePath ?? defaultBbDatabasePath(currentPath);
  const legacyExists = existsSync(legacyPath) && legacyPath !== currentPath;
  const bbExists = existsSync(bbPath) && bbPath !== currentPath;
  if (!legacyExists && !bbExists) {
    return { ...empty, legacyPluginDatabasePath: legacyPath, bbDatabasePath: bbPath };
  }

  let legacyAttached = false;
  let bbAttached = false;
  let copiedDatabaseRows = 0;
  let copiedSettingsRows = 0;
  let copiedKvRows = 0;
  let hasLegacyState = legacyExists;
  try {
    if (legacyExists) {
      database.prepare("ATTACH DATABASE ? AS legacy_plugin").run(legacyPath);
      legacyAttached = true;
      hasLegacyState = LEGACY_TABLES.some((table) => hasTable(database, "legacy_plugin", table));
    }
    if (bbExists) {
      database.prepare("ATTACH DATABASE ? AS bb_state").run(bbPath);
      bbAttached = true;
      hasLegacyState = hasLegacyState
        || oldNamespacedRowCount(database, "plugin_settings") > 0
        || oldNamespacedRowCount(database, "plugin_kv") > 0;
    }
    if (!hasLegacyState) {
      return {
        ...empty,
        legacyPluginDatabasePath: legacyPath,
        bbDatabasePath: bbPath,
      };
    }

    const migrate = database.transaction(() => {
      if (legacyAttached) {
        for (const table of LEGACY_TABLES) copiedDatabaseRows += copyAnalyticsTable(database, table);
      }
      if (bbAttached) {
        copiedSettingsRows = copyNamespacedRows(database, "plugin_settings");
        copiedKvRows = copyNamespacedRows(database, "plugin_kv");
      }
      database
        .prepare("INSERT INTO telemetry_state_migrations (id, applied_at) VALUES (?, ?)")
        .run(LEGACY_MIGRATION_ID, Date.now());
    });
    migrate();
    return {
      alreadyApplied: false,
      currentDatabasePath: currentPath,
      legacyPluginDatabasePath: legacyPath,
      bbDatabasePath: bbPath,
      copiedDatabaseRows,
      copiedSettingsRows,
      copiedKvRows,
      applied: true,
    };
  } finally {
    if (bbAttached) {
      try { database.exec("DETACH DATABASE bb_state"); } catch { /* best effort */ }
    }
    if (legacyAttached) {
      try { database.exec("DETACH DATABASE legacy_plugin"); } catch { /* best effort */ }
    }
  }
}
