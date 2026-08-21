import { describe, it, expect } from "vitest";
import { validateManifest, validateMcpEnvelope, validateMcpServer, validateSkillFrontmatter, expandPlaceholders } from "./loader.js";

describe("validateManifest", () => {
  it("accepts minimal", () => {
    const r = validateManifest({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "hello-plugin" });
    expect(r.valid).toBe(true); expect(r.fatal).toBe(false);
  });
  it("unknown top-level is non-fatal warning", () => {
    const r = validateManifest({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "ok", unknownField: 123 });
    expect(r.valid).toBe(true); expect(r.warnings.some(w => w.includes("unknownField"))).toBe(true);
  });
  it("non-object extensions is non-fatal", () => {
    const r = validateManifest({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "ok", extensions: "bad" });
    expect(r.valid).toBe(true); expect(r.warnings.some(w => w.includes("extensions"))).toBe(true);
  });
  it("invalid name is fatal", () => {
    const r = validateManifest({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "Bad_Plugin" });
    expect(r.fatal).toBe(true);
  });
  it("rejects ambiguous consecutive separators", () => {
    for (const name of ["bad--plugin", "bad..plugin"]) {
      expect(validateManifest({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name }).fatal).toBe(true);
    }
  });
  it("unsupported $schema is fatal", () => {
    const r = validateManifest({ $schema: "https://example.com/bad.json", name: "ok" });
    expect(r.fatal).toBe(true);
  });
  it("accepts 1.1.0", () => {
    const r = validateManifest({ $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json", name: "ok" });
    expect(r.valid).toBe(true); expect(r.specVersion).toBe("1.1.0");
  });
});

describe("validateSkillFrontmatter", () => {
  it("valid", () => {
    const r = validateSkillFrontmatter({ name: "greet", description: "hello" }, "greet");
    expect(r.valid).toBe(true);
  });
  it("name must match dirname", () => {
    const r = validateSkillFrontmatter({ name: "other", description: "x" }, "greet");
    expect(r.valid).toBe(false);
  });
  it("rejects uppercase", () => {
    const r = validateSkillFrontmatter({ name: "Greet", description: "x" }, "Greet");
    expect(r.valid).toBe(false);
  });
  it("rejects long description", () => {
    const r = validateSkillFrontmatter({ name: "ok", description: "a".repeat(1025) }, "ok");
    expect(r.valid).toBe(false);
  });
});

describe("validateMcpEnvelope", () => {
  it("valid envelope", () => {
    const r = validateMcpEnvelope({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {} }, "1.0.0");
    expect(r.valid).toBe(true);
  });
  it("mismatch version disables", () => {
    const r = validateMcpEnvelope({ $schema: "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json", mcpServers: {} }, "1.0.0");
    expect(r.valid).toBe(false);
  });
  it("per-server isolation", () => {
    const r = validateMcpEnvelope({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { a: { type: "stdio", command: "echo" }, b: { type: "stdio", command: "${PLUGIN_ROOT}/bad" } } }, "1.0.0");
    expect(r.valid).toBe(true);
    const ra = validateMcpServer("a", r.servers["a"]);
    const rb = validateMcpServer("b", r.servers["b"]);
    expect(ra.valid).toBe(true); expect(rb.valid).toBe(false);
  });
});

describe("validateMcpServer", () => {
  it("rejects placeholder in command", () => {
    const r = validateMcpServer("x", { type: "stdio", command: "${PLUGIN_ROOT}/bin" });
    expect(r.valid).toBe(false);
  });
  it("rejects PLUGIN_ROOT env", () => {
    const r = validateMcpServer("x", { type: "stdio", command: "echo", env: { PLUGIN_ROOT: "bad" } });
    expect(r.valid).toBe(false);
  });
  it("rejects reserved env names in any casing", () => {
    const r = validateMcpServer("x", { type: "stdio", command: "echo", env: { plugin_root: "bad" } });
    expect(r.valid).toBe(false);
  });
  it("accepts localhost http", () => {
    const r = validateMcpServer("x", { type: "streamable-http", url: "http://localhost:3000/mcp" });
    expect(r.valid).toBe(true);
  });
  it("rejects non-loopback http", () => {
    const r = validateMcpServer("x", { type: "streamable-http", url: "http://example.com/mcp" });
    expect(r.valid).toBe(false);
  });
  it("accepts legacy SSE and exact loopback hosts", () => {
    expect(validateMcpServer("sse", { type: "sse", url: "https://example.com/sse" }).valid).toBe(true);
    expect(validateMcpServer("ipv6", { type: "streamable-http", url: "http://[::1]:3000/mcp" }).valid).toBe(true);
  });
  it("does not treat lookalike hosts as loopback", () => {
    const r = validateMcpServer("x", { type: "streamable-http", url: "http://127.0.0.1.example.com/mcp" });
    expect(r.valid).toBe(false);
  });
  it("rejects duplicate headers case-insensitive", () => {
    const r = validateMcpServer("x", { type: "streamable-http", url: "https://example.com/mcp", headers: { "X-Test": "a", "x-test": "b" } });
    expect(r.valid).toBe(false);
  });
  it("rejects bad cwd", () => {
    const r = validateMcpServer("x", { type: "stdio", command: "echo", cwd: "data" });
    expect(r.valid).toBe(false);
  });
  it("accepts ./ cwd", () => {
    const r = validateMcpServer("x", { type: "stdio", command: "echo", cwd: "./data" });
    expect(r.valid).toBe(true);
  });
  it("rejects command with shell meta", () => {
    const r = validateMcpServer("x", { type: "stdio", command: "echo; rm -rf /" });
    expect(r.valid).toBe(false);
  });
  it("accepts bare and ./", () => {
    expect(validateMcpServer("a", { type: "stdio", command: "echo" }).valid).toBe(true);
    expect(validateMcpServer("b", { type: "stdio", command: "./bin/server" }).valid).toBe(true);
  });
});

describe("expandPlaceholders", () => {
  it("expands once", () => {
    expect(expandPlaceholders("${PLUGIN_ROOT}/a:${PLUGIN_DATA}/b", "/r", "/d")).toBe("/r/a:/d/b");
    expect(expandPlaceholders("${PLUGIN_ROOT}", "/r", "/d")).toBe("/r");
  });
  it("non-recursive", () => {
    // If pluginData contains placeholder string, should not double-expand
    expect(expandPlaceholders("${PLUGIN_ROOT}", "${PLUGIN_DATA}", "/d")).toBe("${PLUGIN_DATA}");
  });
});
