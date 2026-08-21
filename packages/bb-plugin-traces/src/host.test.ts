import Database from "better-sqlite3";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import hostEntry from "../host";
import { ensureSchema, TraceIndexer } from "./indexer";

const harnesses: Array<ReturnType<typeof experimental_createHostEntryHarness>> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.experimental_dispose();
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("trace host worker", () => {
  it("preserves failed paths in the scan result for retry", async () => {
    const database = new Database(":memory:");
    ensureSchema(database);
    const indexer = new TraceIndexer(database);
    const failedSessionPaths = new Set(["/tmp/failed-session.jsonl"]);

    await expect(indexer.scan([], undefined, { failedSessionPaths })).resolves.toMatchObject({
      complete: true,
      failedPaths: ["/tmp/failed-session.jsonl"],
    });
    database.close();
  });

  it("indexes and reads source payloads through the host entry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-traces-host-"));
    temporaryDirectories.push(directory);
    const sessions = join(directory, "sessions");
    const temp = join(directory, "worker-temp");
    await mkdir(sessions);
    await mkdir(temp);
    const sessionPath = join(sessions, "session.jsonl");
    await writeFile(
      sessionPath,
      JSON.stringify({ type: "user/message", data: { role: "user", content: "worker payload" } }) + "\n",
      "utf8",
    );

    const harness = experimental_createHostEntryHarness(hostEntry, {
      experimental_paths: { dataDir: join(directory, "host-data"), tempDir: temp },
    });
    harnesses.push(harness);

    const result = await harness.experimental_call("scan", {
      roots: [{ id: "worker-sessions", source: "custom", label: "Worker sessions", path: sessions, kind: "session", format: "jsonl" }],
      forceFingerprintPaths: [],
      maxFiles: 64,
    });
    expect(result).toMatchObject({ changed: true, complete: true });
    expect(result.processedPaths).toEqual([sessionPath]);

    await expect(harness.experimental_call("stats", { lastScanAt: null, indexing: false, lastError: null })).resolves.toMatchObject({
      sessions: 1,
      events: 1,
      bytes: expect.any(Number),
      indexing: false,
    });

    const database = new Database(join(directory, "data.db"), { readonly: true });
    const event = database.prepare("SELECT id, session_id FROM trace_events LIMIT 1").get() as { id: string; session_id: string };
    expect(database.prepare("SELECT COUNT(*) AS count FROM trace_sessions").get()).toMatchObject({ count: 1 });
    database.close();

    await expect(harness.experimental_call("listSessions", { limit: 10, offset: 0 })).resolves.toMatchObject({
      total: 1,
      sessions: [{ id: event.session_id }],
    });
    await expect(harness.experimental_call("getSession", { id: event.session_id, limit: 10, offset: 0 })).resolves.toMatchObject({
      session: { id: event.session_id },
      events: [{ id: event.id, rawJson: "", rawTruncated: true }],
      totalEvents: 1,
    });
    await expect(harness.experimental_call("getSessionFacets", { id: event.session_id })).resolves.toMatchObject({
      totalEvents: 1,
      categories: [{ value: "user", count: 1 }],
    });
    await expect(harness.experimental_call("rawEvent", { id: event.id })).resolves.toMatchObject({
      raw: expect.stringContaining("worker payload"),
      truncated: false,
    });
  });
});
