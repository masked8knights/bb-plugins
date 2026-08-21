import { afterEach, describe, expect, it } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../host.js";

const harnesses: Array<{ experimental_dispose(): Promise<void> }> = [];

const FIXTURE = String.raw`
let buffer = "";
function send(id, result, error) {
  const message = { jsonrpc: "2.0", id };
  if (error) message.error = error; else message.result = result;
  process.stdout.write(JSON.stringify(message) + "\n");
}
function handle(message) {
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send(message.id, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "host-fixture", version: "1" } });
    return;
  }
  if (message.method === "tools/list") {
    send(message.id, { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] });
    return;
  }
  if (message.method === "prompts/list") { send(message.id, { prompts: [] }); return; }
  if (message.method === "resources/list") { send(message.id, { resources: [] }); return; }
  if (message.method === "resources/templates/list") { send(message.id, { resourceTemplates: [] }); return; }
  if (message.method === "tools/call") { send(message.id, { content: [{ type: "text", text: "host" }] }); return; }
  send(message.id, {});
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
`;

function createHarness() {
  const harness = experimental_createHostEntryHarness(hostEntry);
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.experimental_dispose()));
});

describe("isolated Agent Plugins MCP host", () => {
  it("owns stdio MCP connections and exposes their catalog and calls", async () => {
    const harness = createHarness();
    const input = {
      key: "plugin:fixture",
      command: process.execPath,
      args: ["-e", FIXTURE],
      cwd: "/tmp",
      env: { PATH: process.env.PATH ?? "" },
    };
    const catalog = await harness.experimental_call("start", input);
    expect(catalog.tools).toEqual([expect.objectContaining({ name: "echo" })]);
    const result = await harness.experimental_call("callTool", {
      key: input.key,
      name: "echo",
      args: {},
    });
    expect(result).toEqual(expect.objectContaining({ content: [{ type: "text", text: "host" }] }));
    await expect(harness.experimental_call("close", { key: input.key })).resolves.toEqual({ closed: true });
  }, 15_000);

  it("cancels a stalled stdio handshake and leaves no live connection", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const call = harness.experimental_call("start", {
      key: "plugin:stalled",
      command: process.execPath,
      args: ["-e", "process.stdin.resume()"],
      cwd: "/tmp",
      env: { PATH: process.env.PATH ?? "" },
    }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 40);
    await expect(call).rejects.toThrow();
    await expect(harness.experimental_call("close", { key: "plugin:stalled" })).resolves.toEqual({ closed: false });
  }, 5_000);
});
