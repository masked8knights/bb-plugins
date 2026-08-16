export type JsonRecord = Record<string, unknown>;

export type McpTransportKind = "http" | "stdio";

export interface McpServerRecord {
  id: string;
  name: string;
  description: string;
  transport: McpTransportKind;
  url: string | null;
  command: string | null;
  args: string[];
  cwd: string | null;
  headers: Record<string, string>;
  env: Record<string, string>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CliToolRecord {
  id: string;
  name: string;
  description: string;
  command: string;
  argsTemplate: string[];
  inputSchema: JsonRecord;
  cwd: string | null;
  env: Record<string, string>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CliSourceRecord {
  id: string;
  name: string;
  description: string;
  command: string;
  cwd: string | null;
  env: Record<string, string>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonRecord;
  sourceId: string;
  sourceName: string;
  sourceKind: "mcp" | "cli" | "cli-source";
  remoteName?: string;
}

export interface CatalogTool extends ToolDefinition {
  exposedName: string;
  status: "ready" | "error";
  error?: string;
}

export interface SourceSummary {
  id: string;
  name: string;
  description: string;
  transport: McpTransportKind;
  endpoint: string | null;
  command: string | null;
  args: string[];
  cwd: string | null;
  enabled: boolean;
  hasHeaders: boolean;
  hasEnv: boolean;
  toolCount: number;
  status: "idle" | "ready" | "error" | "disabled";
  lastError: string | null;
  updatedAt: number;
}

export interface CliSummary {
  id: string;
  name: string;
  description: string;
  command: string;
  argsTemplate: string[];
  inputSchema: JsonRecord;
  cwd: string | null;
  enabled: boolean;
  hasEnv: boolean;
  status: "ready" | "disabled";
  updatedAt: number;
}

export interface CliSourceSummary {
  id: string;
  name: string;
  description: string;
  command: string;
  cwd: string | null;
  enabled: boolean;
  hasEnv: boolean;
  status: "ready" | "disabled";
  updatedAt: number;
}

export interface ToolboxSnapshot {
  mcpServers: SourceSummary[];
  cliTools: CliSummary[];
  cliSources: CliSourceSummary[];
  tools: CatalogTool[];
  mcpEndpoint: string;
}

export interface McpUpsertInput {
  id?: string | null;
  name: string;
  description: string;
  transport: McpTransportKind;
  url?: string | null;
  command?: string | null;
  args?: string[];
  cwd?: string | null;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  enabled: boolean;
}

export interface CliUpsertInput {
  id?: string | null;
  name: string;
  description: string;
  command: string;
  argsTemplate: string[];
  inputSchema: JsonRecord;
  cwd?: string | null;
  env?: Record<string, string>;
  enabled: boolean;
}

export interface CliSourceUpsertInput {
  id?: string | null;
  name: string;
  description: string;
  command: string;
  cwd?: string | null;
  env?: Record<string, string>;
  enabled: boolean;
}
