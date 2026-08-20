export type JsonRecord = Record<string, unknown>;

export type SpecVersion = "1.0.0" | "1.1.0";
export type SourceType = "path" | "git" | "npm";

export interface PluginRecord {
  id: string;
  name: string;
  version: string | null;
  description: string | null;
  specVersion: SpecVersion;
  sourceType: SourceType;
  sourceIntent: string;
  sourceResolved: string | null;
  sourceRef: string | null;
  tagPrefix: string | null;
  pluginRoot: string;
  pluginData: string;
  activeGen: number;
  status: "active" | "error" | "needs-approval";
  approval: "pending" | "approved" | "disabled";
  lastError: string | null;
  contentHash: string | null;
  installedAt: number;
  updatedAt: number;
}

export interface PluginSkillRecord {
  pluginId: string;
  skillName: string;
  skillDir: string;
  frontmatterJson: string;
  bodyHash: string;
  materializedPath: string | null;
  status: "active" | "conflicted" | "skipped" | "error";
  lastError: string | null;
}

export interface McpServerRecord {
  pluginId: string;
  serverId: string;
  type: "stdio" | "streamable-http" | "sse";
  configJson: string;
  status: "idle" | "ready" | "error" | "disabled" | "needs-approval";
  lastError: string | null;
  approved: number; // 0/1
}

export interface AgentPluginSnapshot {
  plugins: PluginRecord[];
  skills: PluginSkillRecord[];
  mcpServers: McpServerRecord[];
}

export interface CatalogTool {
  opaqueId: string;
  pluginId: string;
  pluginName: string;
  serverId: string;
  serverType: string;
  name: string;
  description: string;
  inputSchema: JsonRecord;
  status: "ready" | "error";
  error?: string;
}
