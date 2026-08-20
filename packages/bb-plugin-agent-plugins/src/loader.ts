/**
 * Pure loader for Agent Plugins — vendored schemas, fixture-testable.
 * Implements spec-correct validation per 1.0.0 + 1.1.0 (preview).
 * No fs side-effects here; callers pass already-read JSON/text.
 */
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const SUPPORTED_SPEC_VERSIONS = ["1.0.0", "1.1.0"] as const;
export type SupportedSpecVersion = (typeof SUPPORTED_SPEC_VERSIONS)[number];

const PLUGIN_NAME_RE = /^(?!.*(?:--|\\.\\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

// Null-prototype safe copy for untrusted JSON maps ( __proto__ guard )
export function safeRecord(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return Object.create(null);
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(input)) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Manifest validation (plugin.json)
// Spec §5: closed but tolerant for unknown top-level + non-object extensions.
// ---------------------------------------------------------------------------

export interface ManifestResult {
  valid: boolean;
  fatal: boolean; // if true, reject plugin entirely
  specVersion: SupportedSpecVersion | null;
  name: string | null;
  version: string | null;
  description: string | null;
  warnings: string[]; // reported but non-fatal (unknown fields, non-object extensions, unimplemented namespace without validation)
  errors: string[];
  manifest: Record<string, unknown> | null;
}

const ALLOWED_MANIFEST_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);

export function validateManifest(raw: unknown): ManifestResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return { valid: false, fatal: true, specVersion: null, name: null, version: null, description: null, warnings, errors: ["plugin.json must be an object"], manifest: null };
  }

  const rec = safeRecord(raw);

  // Unknown top-level → report+ignore (non-fatal) per spec
  for (const k of Object.keys(rec)) {
    if (!ALLOWED_MANIFEST_FIELDS.has(k)) {
      warnings.push(`unknown top-level field: ${k}`);
    }
  }

  // extensions non-object → report+ignore per §8.1
  if ("extensions" in rec && rec.extensions !== undefined) {
    const ext = rec.extensions;
    if (ext !== null && typeof ext !== "object") {
      warnings.push("extensions is non-object; ignoring");
      // treat as if absent for validation
    } else if (ext !== null && typeof ext === "object" && Array.isArray(ext)) {
      warnings.push("extensions is array, expected object; ignoring");
    } else if (ext !== null && typeof ext === "object") {
      // Each unimplemented namespace must be ignored WITHOUT validating its value — we don't validate values here at all for extensions.
      // Just note that we saw extensions; core doesn't care.
      // If caller wants to validate its own namespace, they would — but we ignore.
    }
  }

  // Required fields (after warnings)
  const schema = rec.$schema;
  let specVersion: SupportedSpecVersion | null = null;
  if (typeof schema !== "string" || schema.length === 0) {
    errors.push("missing required $schema");
  } else if (schema === "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") {
    specVersion = "1.0.0";
  } else if (schema === "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json") {
    specVersion = "1.1.0";
  } else {
    errors.push(`unsupported $schema: ${schema}`);
  }

  const name = rec.name;
  let nameOk: string | null = null;
  if (typeof name !== "string" || name.length === 0) {
    errors.push("missing required name");
  } else if (name.length > 64 || !PLUGIN_NAME_RE.test(name)) {
    errors.push(`invalid name: ${name}`);
  } else {
    nameOk = name;
  }

  // Metadata fields validated only by JSON type (not semantics) — don't over-validate URLs/SemVer/SPDX
  if ("version" in rec && rec.version !== undefined && typeof rec.version !== "string") errors.push("version must be string");
  if ("description" in rec && rec.description !== undefined && typeof rec.description !== "string") errors.push("description must be string");
  if ("homepage" in rec && rec.homepage !== undefined && typeof rec.homepage !== "string") errors.push("homepage must be string");
  if ("repository" in rec && rec.repository !== undefined && typeof rec.repository !== "string") errors.push("repository must be string");
  if ("license" in rec && rec.license !== undefined && typeof rec.license !== "string") errors.push("license must be string");
  if ("keywords" in rec && rec.keywords !== undefined) {
    if (!Array.isArray(rec.keywords) || !rec.keywords.every((v) => typeof v === "string")) errors.push("keywords must be string[]");
  }
  if ("author" in rec && rec.author !== undefined) {
    const a = rec.author;
    if (!isRecord(a)) errors.push("author must be object");
    else {
      const allowed = new Set(["name", "email", "url"]);
      for (const k of Object.keys(a)) {
        if (!allowed.has(k)) errors.push(`author unknown field: ${k}`);
        else if (typeof a[k] !== "string") errors.push(`author.${k} must be string`);
      }
    }
  }

  const fatal = errors.length > 0;
  return {
    valid: !fatal,
    fatal,
    specVersion,
    name: nameOk,
    version: typeof rec.version === "string" ? rec.version : null,
    description: typeof rec.description === "string" ? rec.description : null,
    warnings,
    errors,
    manifest: fatal ? null : rec,
  };
}

// ---------------------------------------------------------------------------
// SKILL.md frontmatter validation (agentskills.io)
// ---------------------------------------------------------------------------

export interface SkillFrontmatterResult {
  valid: boolean;
  name: string | null;
  description: string | null;
  errors: string[];
  warnings: string[];
}

export function validateSkillFrontmatter(frontmatter: unknown, dirname: string): SkillFrontmatterResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(frontmatter)) {
    return { valid: false, name: null, description: null, errors: ["frontmatter must be an object"], warnings };
  }
  const rec = safeRecord(frontmatter);
  const name = rec.name;
  const description = rec.description;
  let nameOk: string | null = null;
  let descOk: string | null = null;

  if (typeof name !== "string" || name.length === 0) {
    errors.push("missing required frontmatter name");
  } else if (name.length > 64 || !SKILL_NAME_RE.test(name)) {
    errors.push(`invalid skill name: ${name}`);
  } else if (name !== dirname) {
    errors.push(`skill name must match directory: ${name} != ${dirname}`);
  } else {
    nameOk = name;
  }

  if (typeof description !== "string" || description.trim().length === 0) {
    errors.push("missing required frontmatter description");
  } else if (description.length > 1024) {
    errors.push("description too long (max 1024)");
  } else {
    descOk = description;
  }

  // Optional fields — type checks only
  if ("license" in rec && rec.license !== undefined && typeof rec.license !== "string") errors.push("license must be string");
  if ("compatibility" in rec && rec.compatibility !== undefined) {
    if (typeof rec.compatibility !== "string" || rec.compatibility.length === 0 || rec.compatibility.length > 500) errors.push("compatibility must be string 1-500");
  }
  if ("allowed-tools" in rec && rec["allowed-tools"] !== undefined && typeof rec["allowed-tools"] !== "string") errors.push("allowed-tools must be string");
  if ("metadata" in rec && rec.metadata !== undefined) {
    const m = rec.metadata;
    if (!isRecord(m)) errors.push("metadata must be object");
    else {
      for (const [k, v] of Object.entries(m)) {
        if (typeof v !== "string") errors.push(`metadata.${k} must be string`);
      }
    }
  }

  return { valid: errors.length === 0, name: nameOk, description: descOk, errors, warnings };
}

// ---------------------------------------------------------------------------
// MCP validation — split envelope vs per-server so one bad server doesn't
// kill the rest (spec §7.2.2).
// ---------------------------------------------------------------------------

export type McpServerType = "stdio" | "streamable-http" | "sse";

export interface McpEnvelopeResult {
  valid: boolean;
  envelopeErrors: string[];
  warnings: string[];
  specVersion: SupportedSpecVersion | null;
  servers: Record<string, unknown>; // raw server configs keyed by id
}

export interface McpServerResult {
  serverId: string;
  valid: boolean;
  type: McpServerType | null;
  errors: string[];
  config: Record<string, unknown> | null;
}

const ALLOWED_MCP_TOP = new Set(["$schema", "mcpServers"]);

export function validateMcpEnvelope(raw: unknown, expectedSpecVersion: SupportedSpecVersion | null): McpEnvelopeResult {
  const warnings: string[] = [];
  const envelopeErrors: string[] = [];
  if (!isRecord(raw)) {
    return { valid: false, envelopeErrors: ["mcp.json must be an object"], warnings, specVersion: null, servers: Object.create(null) };
  }
  const rec = safeRecord(raw);
  for (const k of Object.keys(rec)) {
    if (!ALLOWED_MCP_TOP.has(k)) envelopeErrors.push(`unknown top-level mcp.json field: ${k}`);
  }
  const schema = rec.$schema;
  let specVersion: SupportedSpecVersion | null = null;
  if (typeof schema !== "string") {
    envelopeErrors.push("missing required $schema in mcp.json");
  } else if (schema === "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json") specVersion = "1.0.0";
  else if (schema === "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json") specVersion = "1.1.0";
  else envelopeErrors.push(`unsupported mcp $schema: ${schema}`);

  if (expectedSpecVersion && specVersion && specVersion !== expectedSpecVersion) {
    envelopeErrors.push(`mcp $schema version ${specVersion} mismatches plugin.json ${expectedSpecVersion}`);
  }

  const mcpServers = rec.mcpServers;
  let servers: Record<string, unknown> = Object.create(null);
  if (mcpServers === undefined) {
    envelopeErrors.push("missing required mcpServers");
  } else if (!isRecord(mcpServers)) {
    envelopeErrors.push("mcpServers must be object");
  } else {
    servers = safeRecord(mcpServers);
  }

  return { valid: envelopeErrors.length === 0, envelopeErrors, warnings, specVersion, servers };
}

export function validateMcpServer(serverId: string, raw: unknown): McpServerResult {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { serverId, valid: false, type: null, errors: ["server entry must be object"], config: null };
  }
  const rec = safeRecord(raw);
  const type = rec.type;
  if (type !== "stdio" && type !== "streamable-http" && type !== "sse") {
    return { serverId, valid: false, type: null, errors: [`invalid type: ${String(type)}`], config: null };
  }

  // Closed variant: unknown fields belonging to other variants make invalid
  const allowedByType: Record<McpServerType, Set<string>> = {
    stdio: new Set(["type", "command", "args", "env", "cwd"]),
    "streamable-http": new Set(["type", "url", "headers"]),
    sse: new Set(["type", "url", "headers"]),
  };
  const allowed = allowedByType[type as McpServerType];
  for (const k of Object.keys(rec)) {
    if (!allowed.has(k)) errors.push(`unknown field for ${type}: ${k}`);
  }

  if (type === "stdio") {
    const command = rec.command;
    if (typeof command !== "string" || command.length === 0) errors.push("stdio command must be non-empty string");
    else {
      if (command.includes("\0")) errors.push("invalid command: NUL");
      // Spec: command MUST be bare executable name or ./-prefixed plugin-relative path, single token, no shell, no placeholder expansion
      if (command.includes("${PLUGIN_ROOT}") || command.includes("${PLUGIN_DATA}")) errors.push("command must not contain placeholders");
      const isPluginRelative = command.startsWith("./");
      // Proper bare check: single token, no slash at start, no "../", no "./", only allowed chars, no spaces/shell metachars
      const hasShellMeta = /[\s|&;`$()<>\"']/.test(command);
      if (hasShellMeta) errors.push("command must be single token without shell metachars");
      if (!isPluginRelative) {
        // Bare executable: must not contain "/" or "\\" and must not be empty; allow names like "node", "python3", "my-tool"
        if (command.includes("/") || command.includes("\\")) {
          errors.push("command must be bare name or ./-prefixed path");
        } else if (!/^[a-zA-Z0-9._-]+$/.test(command)) {
          errors.push("command must be bare name (alphanumeric, dot, hyphen, underscore) or ./-prefixed path");
        }
      } else {
        // Plugin-relative: must start with ./ and remain plausible, no "../" escape segment
        if (command.includes("..")) {
          // Allow ".." inside name? spec forbids escapes, so any ".." segment is suspect
          const segments = command.split("/");
          if (segments.includes("..")) errors.push("command must not contain .. segments");
        }
        if (command.length > 1024) errors.push("command too long");
      }
    }
    if ("args" in rec && rec.args !== undefined) {
      if (!Array.isArray(rec.args) || !rec.args.every((v) => typeof v === "string")) errors.push("args must be string[]");
    }
    if ("env" in rec && rec.env !== undefined) {
      if (!isRecord(rec.env)) errors.push("env must be object");
      else {
        for (const [k, v] of Object.entries(rec.env)) {
          if (typeof v !== "string") errors.push(`env.${k} must be string`);
          // Reserved environment names are case-insensitive on Windows. Reject
          // every casing so the same package cannot override client-owned
          // values on one platform while being accepted on another.
          const reserved = k.toUpperCase();
          if (reserved === "PLUGIN_ROOT" || reserved === "PLUGIN_DATA") errors.push(`env must not contain ${k}`);
        }
      }
    }
    if ("cwd" in rec && rec.cwd !== undefined) {
      if (typeof rec.cwd !== "string" || rec.cwd.length === 0) errors.push("cwd must be non-empty string");
      else {
        const c = rec.cwd as string;
        const ok = c.startsWith("./") || c === "${PLUGIN_ROOT}" || c.startsWith("${PLUGIN_ROOT}/") || c === "${PLUGIN_DATA}" || c.startsWith("${PLUGIN_DATA}/");
        if (!ok) errors.push(`cwd must be ./… or \${PLUGIN_ROOT}… or \${PLUGIN_DATA}…: ${c}`);
        else if (c.startsWith("./") && c.split("/").includes("..")) errors.push(`cwd must not contain .. segments: ${c}`);
      }
    }
  } else {
    // http types
    const url = rec.url;
    if (typeof url !== "string" || url.length === 0) errors.push("url must be non-empty string");
    else {
      // Validate absolute http/https, no userinfo/fragment, http only localhost/loopback — done without throwing on bad URL
      try {
        const u = new URL(url);
        if (u.protocol !== "https:" && u.protocol !== "http:") errors.push("url must be http or https");
        if (u.username || u.password) errors.push("url must not contain userinfo");
        if (u.hash) errors.push("url must not contain fragment");
        if (u.protocol === "http:") {
          const host = u.hostname.toLowerCase();
          const isLocalhost = host === "localhost";
          const isLoopback = host === "127.0.0.1" || host === "::1" || host.startsWith("127.") || host === "[::1]";
          if (!isLocalhost && !isLoopback) errors.push("non-loopback url must be https");
        }
        // also reject CRLF in url
        if (url.includes("\r") || url.includes("\n")) errors.push("url must not contain CRLF");
      } catch {
        errors.push(`invalid url: ${url}`);
      }
    }
    if ("headers" in rec && rec.headers !== undefined) {
      if (!isRecord(rec.headers)) errors.push("headers must be object");
      else {
        const seenLower = new Set<string>();
        for (const [k, v] of Object.entries(rec.headers)) {
          if (typeof v !== "string") { errors.push(`headers.${k} must be string`); continue; }
          const lower = k.toLowerCase();
          if (seenLower.has(lower)) errors.push(`duplicate header (case-insensitive): ${k}`);
          seenLower.add(lower);
          // header name/value syntax + CRLF
          if (!/^[!#$%&'*+\-.0-9A-Za-z^_`|~]+$/.test(k)) errors.push(`invalid header name: ${k}`);
          if (k.includes("\r") || k.includes("\n") || v.includes("\r") || v.includes("\n")) errors.push(`header must not contain CRLF: ${k}`);
          // values: no CRLF already, also check field value chars
          if (/[\0\r\n]/.test(v)) errors.push(`invalid header value for ${k}`);
        }
      }
    }
  }

  return { serverId, valid: errors.length === 0, type: type as McpServerType, errors, config: errors.length === 0 ? rec : null };
}

// ---------------------------------------------------------------------------
// Placeholders — exactly once, only in args/env values/cwd; never in command/URL/headers
// ---------------------------------------------------------------------------

export function expandPlaceholders(input: string, pluginRoot: string, pluginData: string): string {
  // Single non-recursive pass per spec §9.2 — simultaneous replacement, not sequential, so text introduced by one replacement is not rescanned.
  return input.replace(/\$\{PLUGIN_ROOT\}|\$\{PLUGIN_DATA\}/g, (m) => (m === "${PLUGIN_ROOT}" ? pluginRoot : pluginData));
}
