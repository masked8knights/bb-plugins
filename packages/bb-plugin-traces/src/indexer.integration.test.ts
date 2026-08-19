import Database from "better-sqlite3";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSchema, TraceIndexer, type RootSpec } from "./indexer";

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("TraceIndexer", () => {
  it("sorts the full indexed session set by collection sort", () => {
    const database = new Database(":memory:");
    databases.push(database);
    ensureSchema(database);
    database.prepare(
      "INSERT INTO trace_sessions (id, source_id, title, file_path, started_at, updated_at, event_count, duration_ms, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed')",
    ).run("short", "codex", "Short", "/tmp/short.jsonl", 300, 200, 2, 100);
    database.prepare(
      "INSERT INTO trace_sessions (id, source_id, title, file_path, started_at, updated_at, event_count, duration_ms, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed')",
    ).run("busy", "claude", "Busy", "/tmp/busy.jsonl", 100, 100, 8, 2_000);

    const indexer = new TraceIndexer(database, true);
    expect(indexer.listSessions({ sort: "events", limit: 1, offset: 0 }).sessions[0]?.id).toBe("busy");
    expect(indexer.listSessions({ sort: "duration", limit: 1, offset: 0 }).sessions[0]?.id).toBe("busy");
    expect(indexer.listSessions({ sort: "started", limit: 1, offset: 0 }).sessions[0]?.id).toBe("short");
  });

  it("indexes local sessions, preserves payloads, and rescans appends", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-traces-"));
    temporaryDirectories.push(directory);

    const sessionPath = join(directory, "session.jsonl");
    await writeFile(
      sessionPath,
      [
        {
          type: "user/message",
          timestamp: "2026-08-17T12:00:00.000Z",
          data: { role: "user", content: "Investigate local traces" },
        },
        {
          type: "tool/call",
          timestamp: "2026-08-17T12:00:01.000Z",
          data: { turn: 1, step: 1, name: "exec", arguments: '{"command":"pwd"}' },
        },
        {
          type: "assistant/message",
          timestamp: "2026-08-17T12:00:02.000Z",
          data: { role: "assistant", content: "The local index is working.", usage: { input_tokens: 10, output_tokens: 4 } },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
      "utf8",
    );
    const database = new Database(":memory:");
    databases.push(database);
    const indexer = new TraceIndexer(database, ensureSchema(database));
    const sessionRoot: RootSpec = {
      id: "fixture-sessions",
      source: "custom",
      label: "Fixture sessions",
      path: directory,
      kind: "session",
      format: "jsonl",
    };
    await indexer.scan([sessionRoot]);

    expect(indexer.roots().map((root) => root.id)).toEqual(["fixture-sessions"]);

    const first = indexer.listSessions({ limit: 10, offset: 0 });
    expect(first.total).toBe(1);
    expect(first.sessions[0]).toMatchObject({
      source: "custom",
      title: "Investigate local traces",
      eventCount: 3,
      userCount: 1,
      assistantCount: 1,
      toolCount: 1,
      inputTokens: 10,
      outputTokens: 4,
    });
    const sessionId = first.sessions[0]!.id;
    const detail = indexer.getSession(sessionId, 10, 0);
    expect(detail.totalEvents).toBe(3);
    expect(detail.events[1]).toMatchObject({
      kind: "tool",
      title: "exec",
      depth: 1,
      summary: '{"command":"pwd"}',
    });
    expect((await indexer.rawEvent(detail.events[1]!.id)).raw).toContain('"tool/call"');
    expect(indexer.listSessions({ query: "Investigate", limit: 10, offset: 0 }).total).toBe(1);
    expect(indexer.listSessions({ query: "pwd", limit: 10, offset: 0 }).total).toBe(1);
    expect(indexer.getSession(encodeURIComponent(sessionId), 10, 0).session?.id).toBe(sessionId);

    const indexedAt = database.prepare("SELECT indexed_at FROM trace_files WHERE path = ?").get(sessionPath) as { indexed_at: number };
    database.prepare("UPDATE trace_files SET parser_version = 1 WHERE path = ?").run(sessionPath);
    await indexer.scan([sessionRoot]);
    expect((database.prepare("SELECT indexed_at FROM trace_files WHERE path = ?").get(sessionPath) as { indexed_at: number }).indexed_at).toBe(indexedAt.indexed_at);

    await appendFile(
      sessionPath,
      JSON.stringify({
        type: "turn/end",
        timestamp: "2026-08-17T12:00:03.000Z",
        data: { turn: 1 },
      }) + "\n",
      "utf8",
    );
    await indexer.scan([sessionRoot]);
    expect(indexer.getSession(sessionId, 10, 0).totalEvents).toBe(4);
    expect(indexer.listSessions({ limit: 10, offset: 0 }).sessions[0]?.status).toBe("completed");

    await appendFile(sessionPath, JSON.stringify({ type: "user/message", data: { content: "partial" } }), "utf8");
    await indexer.scan([sessionRoot]);
    expect(indexer.getSession(sessionId, 10, 0).totalEvents).toBe(4);
    await appendFile(sessionPath, "\n", "utf8");
    await indexer.scan([sessionRoot]);
    expect(indexer.getSession(sessionId, 10, 0).totalEvents).toBe(5);

    await rm(directory, { recursive: true, force: true });
    await indexer.scan([sessionRoot]);
    expect(indexer.listSessions({ limit: 10, offset: 0 }).total).toBe(1);
    await mkdir(directory, { recursive: true });
    await indexer.scan([sessionRoot]);
    expect(indexer.listSessions({ limit: 10, offset: 0 }).total).toBe(0);

    await indexer.scan([]);
    expect(indexer.roots()).toEqual([]);
  });

  it("keeps indexed payloads compact while reloading the full source line", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-traces-raw-preview-"));
    temporaryDirectories.push(directory);
    const sessionPath = join(directory, "session.jsonl");
    const payload = "x".repeat(2_000);
    await writeFile(
      sessionPath,
      JSON.stringify({ type: "tool/call", data: { name: "large", arguments: payload } }) + "\n",
      "utf8",
    );

    const database = new Database(":memory:");
    databases.push(database);
    const indexer = new TraceIndexer(database, ensureSchema(database));
    const root: RootSpec = {
      id: "raw-preview-sessions",
      source: "custom",
      label: "Raw preview sessions",
      path: directory,
      kind: "session",
      format: "jsonl",
    };
    await indexer.scan([root]);

    const session = indexer.listSessions({ limit: 1, offset: 0 }).sessions[0]!;
    const event = indexer.getSession(session.id, 1, 0).events[0]!;
    expect(event.rawJson.length).toBeLessThanOrEqual(514);
    const raw = await indexer.rawEvent(event.id);
    expect(raw.raw).toContain(payload);
    expect(raw.raw?.length).toBeGreaterThan(512);
    expect(raw.truncated).toBe(false);
  });

  it("advances a bounded scan batch without restarting discovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-traces-batch-"));
    temporaryDirectories.push(directory);
    await Promise.all(
      ["one", "two", "three"].map((title) =>
        writeFile(
          join(directory, title + ".jsonl"),
          JSON.stringify({ type: "user/message", data: { role: "user", content: title } }) + "\n",
          "utf8",
        ),
      ),
    );

    const database = new Database(":memory:");
    databases.push(database);
    const indexer = new TraceIndexer(database, ensureSchema(database));
    const root: RootSpec = {
      id: "bounded-sessions",
      source: "custom",
      label: "Bounded sessions",
      path: directory,
      kind: "session",
      format: "jsonl",
    };

    const first = await indexer.scan([root], undefined, { maxFiles: 1 });
    const second = await indexer.scan([root], undefined, { maxFiles: 1 });
    const third = await indexer.scan([root], undefined, { maxFiles: 1 });

    expect(first.complete).toBe(false);
    expect(second.complete).toBe(false);
    expect(third.complete).toBe(true);
    expect(indexer.listSessions({ limit: 10, offset: 0 }).total).toBe(3);
  });

  it("fingerprints completed files and replaces stale rows when a session is rewritten", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-traces-fingerprint-"));
    temporaryDirectories.push(directory);
    const sessionPath = join(directory, "session.jsonl");
    const root: RootSpec = {
      id: "fingerprint-sessions",
      source: "custom",
      label: "Fingerprint sessions",
      path: directory,
      kind: "session",
      format: "jsonl",
    };
    const writeRecords = async (records: unknown[]) => {
      await writeFile(sessionPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
    };
    await writeRecords([
      { type: "user/message", data: { role: "user", content: "old request" } },
      { type: "assistant/message", data: { role: "assistant", content: "old response" } },
      { type: "tool/call", data: { name: "old-tool", arguments: "{}" } },
    ]);

    const database = new Database(":memory:");
    databases.push(database);
    const indexer = new TraceIndexer(database, ensureSchema(database));
    expect((await indexer.scan([root])).changed).toBe(true);

    const firstFile = database.prepare("SELECT indexed_at, mtime_ms, content_hash FROM trace_files WHERE path = ?").get(sessionPath) as {
      indexed_at: number;
      mtime_ms: number;
      content_hash: string | null;
    };
    expect(firstFile.content_hash).toMatch(/^[0-9a-f]{64}$/);
    database.prepare("UPDATE trace_files SET content_hash = NULL WHERE path = ?").run(sessionPath);
    expect((await indexer.scan([root], undefined, { forceFingerprintAll: true })).changed).toBe(true);
    expect((database.prepare("SELECT content_hash FROM trace_files WHERE path = ?").get(sessionPath) as {
      content_hash: string | null;
    }).content_hash).toMatch(/^[0-9a-f]{64}$/);
    const fingerprintedFile = database.prepare("SELECT indexed_at, mtime_ms FROM trace_files WHERE path = ?").get(sessionPath) as {
      indexed_at: number;
      mtime_ms: number;
    };
    const touchedMtime = fingerprintedFile.mtime_ms + 5_000;
    await utimes(sessionPath, new Date(touchedMtime), new Date(touchedMtime));
    expect((await indexer.scan([root])).changed).toBe(false);
    const afterTouch = database.prepare("SELECT indexed_at, mtime_ms FROM trace_files WHERE path = ?").get(sessionPath) as {
      indexed_at: number;
      mtime_ms: number;
    };
    expect(afterTouch.indexed_at).toBe(fingerprintedFile.indexed_at);
    expect(afterTouch.mtime_ms).toBe(touchedMtime);

    await writeRecords([
      { type: "user/message", data: { role: "user", content: "new request" } },
      { type: "assistant/message", data: { role: "assistant", content: "new response" } },
      { type: "tool/call", data: { name: "new-tool", arguments: "{}" } },
    ]);
    await utimes(sessionPath, new Date(touchedMtime), new Date(touchedMtime));
    const sessionId = indexer.listSessions({ limit: 10, offset: 0 }).sessions[0]!.id;
    expect((await indexer.scan([root], undefined, { forceFingerprintPaths: new Set([sessionPath]) })).changed).toBe(true);
    expect(indexer.getSession(sessionId, 10, 0).events.map((event) => event.summary)).toEqual([
      "new request",
      "new response",
      "{}",
    ]);
    expect(indexer.listSessions({ query: "old-tool", limit: 10, offset: 0 }).total).toBe(0);

    await writeRecords([
      { type: "user/message", data: { role: "user", content: "alt request" } },
      { type: "assistant/message", data: { role: "assistant", content: "alt response" } },
      { type: "tool/call", data: { name: "alt-tool", arguments: "{}" } },
    ]);
    await utimes(sessionPath, new Date(touchedMtime + 5_000), new Date(touchedMtime + 5_000));
    expect((await indexer.scan([root])).changed).toBe(true);
    expect(indexer.getSession(sessionId, 10, 0).events.map((event) => event.summary)).toEqual([
      "alt request",
      "alt response",
      "{}",
    ]);

    const detail = indexer.getSession(sessionId, 10, 0);
    expect(detail.totalEvents).toBe(3);
    expect(indexer.listSessions({ query: "new request", limit: 10, offset: 0 }).total).toBe(0);

    await writeRecords([
      { type: "user/message", data: { role: "user", content: "short replacement request" } },
      { type: "assistant/message", data: { role: "assistant", content: "short replacement response" } },
    ]);
    await utimes(sessionPath, new Date(touchedMtime + 7_500), new Date(touchedMtime + 7_500));
    expect((await indexer.scan([root])).changed).toBe(true);
    expect(indexer.getSession(sessionId, 10, 0).events.map((event) => event.summary)).toEqual([
      "short replacement request",
      "short replacement response",
    ]);

    await writeRecords([
      { type: "user/message", data: { role: "user", content: "larger replacement request" } },
      { type: "assistant/message", data: { role: "assistant", content: "larger replacement response" } },
      { type: "tool/call", data: { name: "new-tool", arguments: '{"command":"ls"}' } },
    ]);
    await utimes(sessionPath, new Date(touchedMtime + 10_000), new Date(touchedMtime + 10_000));
    expect((await indexer.scan([root])).changed).toBe(true);
    const largerDetail = indexer.getSession(sessionId, 10, 0);
    expect(largerDetail.totalEvents).toBe(3);
    expect(largerDetail.events.map((event) => event.summary)).toEqual([
      "larger replacement request",
      "larger replacement response",
      '{"command":"ls"}',
    ]);
    expect(indexer.listSessions({ query: "old response", limit: 10, offset: 0 }).total).toBe(0);
  });

  it("replaces stale prefixes when an incomplete JSONL file is rewritten", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-traces-partial-rewrite-"));
    temporaryDirectories.push(directory);
    const sessionPath = join(directory, "session.jsonl");
    const root: RootSpec = {
      id: "partial-rewrite-sessions",
      source: "custom",
      label: "Partial rewrite sessions",
      path: directory,
      kind: "session",
      format: "jsonl",
    };
    const database = new Database(":memory:");
    databases.push(database);
    const indexer = new TraceIndexer(database, ensureSchema(database));
    await writeFile(
      sessionPath,
      [
        { type: "user/message", data: { role: "user", content: "original request" } },
        { type: "assistant/message", data: { role: "assistant", content: "original response" } },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
      "utf8",
    );
    expect((await indexer.scan([root])).changed).toBe(true);
    const sessionId = indexer.listSessions({ limit: 10, offset: 0 }).sessions[0]!.id;

    await appendFile(sessionPath, JSON.stringify({ type: "user/message", data: { content: "unfinished original" } }), "utf8");
    await indexer.scan([root]);
    expect(indexer.getSession(sessionId, 10, 0).totalEvents).toBe(2);
    const partialFile = database.prepare("SELECT indexed_bytes, size_bytes FROM trace_files WHERE path = ?").get(sessionPath) as {
      indexed_bytes: number;
      size_bytes: number;
    };
    expect(partialFile.indexed_bytes).toBeLessThan(partialFile.size_bytes);
    expect((await indexer.scan([root], undefined, { forceFingerprintPaths: new Set([sessionPath]) })).changed).toBe(true);
    expect(indexer.getSession(sessionId, 10, 0).totalEvents).toBe(2);

    await writeFile(
      sessionPath,
      [
        { type: "user/message", data: { role: "user", content: "replacement request" } },
        { type: "assistant/message", data: { role: "assistant", content: "replacement response" } },
        { type: "tool/call", data: { name: "replacement-tool", arguments: "{}" } },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
      "utf8",
    );
    expect((await indexer.scan([root])).changed).toBe(true);
    expect(indexer.getSession(sessionId, 10, 0).events.map((event) => event.summary)).toEqual([
      "replacement request",
      "replacement response",
      "{}",
    ]);
    expect(indexer.listSessions({ query: "original request", limit: 10, offset: 0 }).total).toBe(0);
  });
});
