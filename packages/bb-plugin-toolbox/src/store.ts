import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  CliSourceRecord,
  CliSourceUpsertInput,
  JsonRecord,
  McpServerRecord,
  McpUpsertInput,
} from "./types";

export const migrations = [
  `CREATE TABLE IF NOT EXISTS toolbox_mcp_servers (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     transport TEXT NOT NULL,
     url TEXT,
     command TEXT,
     args_json TEXT NOT NULL DEFAULT '[]',
     cwd TEXT,
     headers_json TEXT NOT NULL DEFAULT '{}',
     env_json TEXT NOT NULL DEFAULT '{}',
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS toolbox_cli_tools (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     command TEXT NOT NULL,
     args_template_json TEXT NOT NULL DEFAULT '[]',
     input_schema_json TEXT NOT NULL DEFAULT '{"type":"object","properties":{},"additionalProperties":false}',
     cwd TEXT,
     env_json TEXT NOT NULL DEFAULT '{}',
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_toolbox_mcp_name ON toolbox_mcp_servers(name)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_toolbox_cli_name ON toolbox_cli_tools(name)`,
  `CREATE TABLE IF NOT EXISTS toolbox_cli_sources (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     command TEXT NOT NULL,
     cwd TEXT,
     env_json TEXT NOT NULL DEFAULT '{}',
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_toolbox_cli_source_name ON toolbox_cli_sources(name)`,
];

const mcpRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    transport: z.enum(["http", "stdio"]),
    url: z.string().nullable(),
    command: z.string().nullable(),
    args_json: z.string(),
    cwd: z.string().nullable(),
    headers_json: z.string(),
    env_json: z.string(),
    enabled: z.number(),
    created_at: z.number(),
    updated_at: z.number(),
  })
  .strict();

const cliSourceRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    command: z.string(),
    cwd: z.string().nullable(),
    env_json: z.string(),
    enabled: z.number(),
    created_at: z.number(),
    updated_at: z.number(),
  })
  .strict();

const jsonRecordSchema = z.record(z.string(), z.unknown());
const stringArraySchema = z.array(z.string());

function parseJson<T>(value: string, fallback: T, parse: (input: unknown) => T): T {
  try {
    return parse(JSON.parse(value));
  } catch {
    return fallback;
  }
}

function rowToMcp(row: unknown): McpServerRecord {
  const parsed = mcpRowSchema.parse(row);
  return {
    id: parsed.id,
    name: parsed.name,
    description: parsed.description,
    transport: parsed.transport,
    url: parsed.url,
    command: parsed.command,
    args: parseJson(parsed.args_json, [], (value) => stringArraySchema.parse(value)),
    cwd: parsed.cwd,
    headers: parseJson(parsed.headers_json, {}, (value) => jsonRecordSchema.parse(value) as Record<string, string>),
    env: parseJson(parsed.env_json, {}, (value) => jsonRecordSchema.parse(value) as Record<string, string>),
    enabled: parsed.enabled === 1,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
}

function rowToCliSource(row: unknown): CliSourceRecord {
  const parsed = cliSourceRowSchema.parse(row);
  return {
    id: parsed.id,
    name: parsed.name,
    description: parsed.description,
    command: parsed.command,
    cwd: parsed.cwd,
    env: parseJson(parsed.env_json, {}, (value) => jsonRecordSchema.parse(value) as Record<string, string>),
    enabled: parsed.enabled === 1,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function normalizeStringMap(value: Record<string, string> | undefined): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [nonEmpty(key, "Environment variable name"), String(item)]),
  );
}

export class ToolboxStore {
  constructor(private readonly db: Database.Database, applyMigrations: (db: Database.Database, statements: string[]) => void) {
    applyMigrations(db, migrations);
  }

  listMcpServers(): McpServerRecord[] {
    return mcpRowSchema
      .array()
      .parse(this.db.prepare("SELECT * FROM toolbox_mcp_servers ORDER BY name COLLATE NOCASE").all())
      .map(rowToMcp);
  }

  getMcpServer(id: string): McpServerRecord | null {
    const row = this.db.prepare("SELECT * FROM toolbox_mcp_servers WHERE id = ?").get(id);
    return row === undefined ? null : rowToMcp(row);
  }

  upsertMcp(input: McpUpsertInput): McpServerRecord {
    const now = Date.now();
    const id = input.id?.trim() || `mcp_${randomUUID()}`;
    const name = nonEmpty(input.name, "MCP name");
    const description = input.description.trim();
    const args = input.args ?? [];
    if (input.transport === "http") {
      const url = nonEmpty(input.url ?? "", "MCP URL");
      new URL(url);
    } else {
      nonEmpty(input.command ?? "", "MCP command");
    }
    const existing = this.getMcpServer(id);
    const record = {
      id,
      name,
      description,
      transport: input.transport,
      url: input.transport === "http" ? input.url!.trim() : null,
      command: input.transport === "stdio" ? input.command!.trim() : null,
      args: JSON.stringify(args),
      cwd: input.cwd?.trim() || null,
      headers: JSON.stringify(normalizeStringMap(input.headers)),
      env: JSON.stringify(normalizeStringMap(input.env)),
      enabled: input.enabled ? 1 : 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO toolbox_mcp_servers
           (id, name, description, transport, url, command, args_json, cwd,
            headers_json, env_json, enabled, created_at, updated_at)
         VALUES (@id, @name, @description, @transport, @url, @command, @args,
            @cwd, @headers, @env, @enabled, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           transport = excluded.transport,
           url = excluded.url,
           command = excluded.command,
           args_json = excluded.args_json,
           cwd = excluded.cwd,
           headers_json = excluded.headers_json,
           env_json = excluded.env_json,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(record);
    return this.getMcpServer(id)!;
  }

  deleteMcp(id: string): boolean {
    return this.db.prepare("DELETE FROM toolbox_mcp_servers WHERE id = ?").run(id).changes > 0;
  }

  listCliSources(): CliSourceRecord[] {
    return cliSourceRowSchema
      .array()
      .parse(this.db.prepare("SELECT * FROM toolbox_cli_sources ORDER BY name COLLATE NOCASE").all())
      .map(rowToCliSource);
  }

  getCliSource(id: string): CliSourceRecord | null {
    const row = this.db.prepare("SELECT * FROM toolbox_cli_sources WHERE id = ?").get(id);
    return row === undefined ? null : rowToCliSource(row);
  }

  upsertCliSource(input: CliSourceUpsertInput): CliSourceRecord {
    const now = Date.now();
    const id = input.id?.trim() || `cli_source_${randomUUID()}`;
    const name = nonEmpty(input.name, "CLI source name");
    const command = nonEmpty(input.command, "CLI command");
    const existing = this.getCliSource(id);
    const record = {
      id,
      name,
      description: input.description.trim(),
      command,
      cwd: input.cwd?.trim() || null,
      env: JSON.stringify(normalizeStringMap(input.env)),
      enabled: input.enabled ? 1 : 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO toolbox_cli_sources
           (id, name, description, command, cwd, env_json, enabled, created_at, updated_at)
         VALUES (@id, @name, @description, @command, @cwd, @env, @enabled, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           command = excluded.command,
           cwd = excluded.cwd,
           env_json = excluded.env_json,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(record);
    return this.getCliSource(id)!;
  }

  deleteCliSource(id: string): boolean {
    return this.db.prepare("DELETE FROM toolbox_cli_sources WHERE id = ?").run(id).changes > 0;
  }
}
