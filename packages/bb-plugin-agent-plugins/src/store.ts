import type Database from "better-sqlite3";
import type { PluginRecord, PluginSkillRecord, McpServerRecord } from "./types.js";

export class AgentPluginsStore {
  constructor(
    readonly db: Database.Database,
    migrate: (db: Database.Database, statements: string[]) => void,
  ) {
    // Enable foreign_keys for ON DELETE CASCADE
    try { db.exec("PRAGMA foreign_keys = ON"); } catch {}
    migrate(db, [
      `PRAGMA foreign_keys = ON`,
      `CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT,
        description TEXT,
        specVersion TEXT NOT NULL,
        sourceType TEXT NOT NULL CHECK(sourceType IN ('path','git','npm')),
        sourceIntent TEXT NOT NULL,
        sourceResolved TEXT,
        sourceRef TEXT,
        tagPrefix TEXT,
        pluginRoot TEXT NOT NULL,
        pluginData TEXT NOT NULL,
        activeGen INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK(status IN ('active','error','needs-approval')),
        approval TEXT NOT NULL CHECK(approval IN ('pending','approved','disabled')),
        lastError TEXT,
        contentHash TEXT,
        installedAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS plugin_skills (
        pluginId TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
        skillName TEXT NOT NULL,
        skillDir TEXT NOT NULL,
        frontmatterJson TEXT NOT NULL,
        bodyHash TEXT NOT NULL,
        materializedPath TEXT,
        status TEXT NOT NULL,
        lastError TEXT,
        PRIMARY KEY (pluginId, skillName)
      )`,
      `CREATE TABLE IF NOT EXISTS mcp_servers (
        pluginId TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
        serverId TEXT NOT NULL,
        type TEXT NOT NULL,
        configJson TEXT NOT NULL,
        status TEXT NOT NULL,
        lastError TEXT,
        approved INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (pluginId, serverId)
      )`,
      `CREATE TABLE IF NOT EXISTS generations (
        pluginId TEXT NOT NULL,
        gen INTEGER NOT NULL,
        pluginRoot TEXT NOT NULL,
        contentHash TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (pluginId, gen),
        FOREIGN KEY (pluginId) REFERENCES plugins(id) ON DELETE CASCADE
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_plugins_name ON plugins(name)`,
    ]);
  }

  listPlugins(): PluginRecord[] {
    return this.db.prepare(`SELECT * FROM plugins ORDER BY installedAt DESC`).all() as PluginRecord[];
  }

  getPlugin(id: string): PluginRecord | undefined {
    return this.db.prepare(`SELECT * FROM plugins WHERE id = ?`).get(id) as PluginRecord | undefined;
  }

  getPluginByName(name: string): PluginRecord | undefined {
    return this.db.prepare(`SELECT * FROM plugins WHERE name = ?`).get(name) as PluginRecord | undefined;
  }

  upsertPlugin(record: PluginRecord): void {
    this.db
      .prepare(
        `INSERT INTO plugins (id, name, version, description, specVersion, sourceType, sourceIntent, sourceResolved, sourceRef, tagPrefix, pluginRoot, pluginData, activeGen, status, approval, lastError, contentHash, installedAt, updatedAt)
         VALUES (@id, @name, @version, @description, @specVersion, @sourceType, @sourceIntent, @sourceResolved, @sourceRef, @tagPrefix, @pluginRoot, @pluginData, @activeGen, @status, @approval, @lastError, @contentHash, @installedAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, version=excluded.version, description=excluded.description, specVersion=excluded.specVersion,
           sourceType=excluded.sourceType, sourceIntent=excluded.sourceIntent, sourceResolved=excluded.sourceResolved, sourceRef=excluded.sourceRef, tagPrefix=excluded.tagPrefix,
           pluginRoot=excluded.pluginRoot, pluginData=excluded.pluginData, activeGen=excluded.activeGen, status=excluded.status, approval=excluded.approval,
           lastError=excluded.lastError, contentHash=excluded.contentHash, updatedAt=excluded.updatedAt`,
      )
      .run(record as unknown as Record<string, unknown>);
  }

  deletePlugin(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM plugins WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  listSkills(pluginId?: string): PluginSkillRecord[] {
    if (pluginId) {
      return this.db.prepare(`SELECT * FROM plugin_skills WHERE pluginId = ?`).all(pluginId) as PluginSkillRecord[];
    }
    return this.db.prepare(`SELECT * FROM plugin_skills`).all() as PluginSkillRecord[];
  }

  upsertSkill(record: PluginSkillRecord): void {
    this.db
      .prepare(
        `INSERT INTO plugin_skills (pluginId, skillName, skillDir, frontmatterJson, bodyHash, materializedPath, status, lastError)
         VALUES (@pluginId, @skillName, @skillDir, @frontmatterJson, @bodyHash, @materializedPath, @status, @lastError)
         ON CONFLICT(pluginId, skillName) DO UPDATE SET
           skillDir=excluded.skillDir, frontmatterJson=excluded.frontmatterJson, bodyHash=excluded.bodyHash,
           materializedPath=excluded.materializedPath, status=excluded.status, lastError=excluded.lastError`,
      )
      .run(record as unknown as Record<string, unknown>);
  }

  listMcpServers(pluginId?: string): McpServerRecord[] {
    if (pluginId) {
      return this.db.prepare(`SELECT * FROM mcp_servers WHERE pluginId = ?`).all(pluginId) as McpServerRecord[];
    }
    return this.db.prepare(`SELECT * FROM mcp_servers`).all() as McpServerRecord[];
  }

  upsertMcpServer(record: McpServerRecord): void {
    this.db
      .prepare(
        `INSERT INTO mcp_servers (pluginId, serverId, type, configJson, status, lastError, approved)
         VALUES (@pluginId, @serverId, @type, @configJson, @status, @lastError, @approved)
         ON CONFLICT(pluginId, serverId) DO UPDATE SET
           type=excluded.type, configJson=excluded.configJson, status=excluded.status, lastError=excluded.lastError, approved=excluded.approved`,
      )
      .run(record as unknown as Record<string, unknown>);
  }

  snapshot() {
    return {
      plugins: this.listPlugins(),
      skills: this.listSkills(),
      mcpServers: this.listMcpServers(),
    };
  }

  transaction<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return tx();
  }
}
