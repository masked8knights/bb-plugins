import Database from "better-sqlite3";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultArtifactRoots, ensureSchema, TraceIndexer, type RootSpec } from "./indexer";

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("TraceIndexer", () => {
  it("does not treat a home-directory host cwd as a workspace root", () => {
    expect(defaultArtifactRoots("/Users/tester", "/Users/tester").map((root) => root.id)).toEqual([
      "bb-thread-storage",
    ]);
    expect(defaultArtifactRoots("/Users/tester", "/Users/tester/project").map((root) => root.id)).toContain("current-workspace");
  });

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

  it("indexes local sessions, preserves payloads, rescans appends, and indexes decisions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-traces-"));
    temporaryDirectories.push(directory);
    const workspace = join(directory, "workspace");
    const plans = join(workspace, ".plans");
    await mkdir(plans, { recursive: true });

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
    const decisionPath = join(plans, "checkpoint.md");
    await writeFile(decisionPath, "# Local trace checkpoint\n\nKeep the source files private.\n", "utf8");

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
    const artifactRoot: RootSpec = {
      id: "fixture-artifacts",
      source: "artifacts",
      label: "Fixture artifacts",
      path: workspace,
      kind: "artifact",
    };

    await indexer.scan([sessionRoot], [artifactRoot]);

    expect(indexer.roots().map((root) => root.id)).toEqual(["fixture-artifacts", "fixture-sessions"]);

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
    expect(indexer.rawEvent(detail.events[1]!.id).raw).toContain('"tool/call"');
    expect(indexer.listSessions({ query: "Investigate", limit: 10, offset: 0 }).total).toBe(1);
    expect(indexer.listSessions({ query: "pwd", limit: 10, offset: 0 }).total).toBe(1);
    expect(indexer.getSession(encodeURIComponent(sessionId), 10, 0).session?.id).toBe(sessionId);

    const indexedAt = database.prepare("SELECT indexed_at FROM trace_files WHERE path = ?").get(sessionPath) as { indexed_at: number };
    database.prepare("UPDATE trace_files SET parser_version = 1 WHERE path = ?").run(sessionPath);
    await indexer.scan([sessionRoot], [artifactRoot]);
    expect((database.prepare("SELECT indexed_at FROM trace_files WHERE path = ?").get(sessionPath) as { indexed_at: number }).indexed_at).toBe(indexedAt.indexed_at);

    const artifacts = indexer.listArtifacts({ limit: 10, offset: 0 });
    expect(artifacts.total).toBe(1);
    expect(artifacts.artifacts[0]).toMatchObject({
      kind: "decision",
      title: "Local trace checkpoint",
      preview: expect.stringContaining("Keep the source files private."),
    });

    await appendFile(
      sessionPath,
      JSON.stringify({
        type: "turn/end",
        timestamp: "2026-08-17T12:00:03.000Z",
        data: { turn: 1 },
      }) + "\n",
      "utf8",
    );
    await indexer.scan([sessionRoot], [artifactRoot]);
    expect(indexer.getSession(sessionId, 10, 0).totalEvents).toBe(4);
    expect(indexer.listSessions({ limit: 10, offset: 0 }).sessions[0]?.status).toBe("completed");

    await appendFile(sessionPath, JSON.stringify({ type: "user/message", data: { content: "partial" } }), "utf8");
    await indexer.scan([sessionRoot], []);
    expect(indexer.getSession(sessionId, 10, 0).totalEvents).toBe(4);
    await appendFile(sessionPath, "\n", "utf8");
    await indexer.scan([sessionRoot], []);
    expect(indexer.getSession(sessionId, 10, 0).totalEvents).toBe(5);

    await rm(directory, { recursive: true, force: true });
    await indexer.scan([sessionRoot], []);
    expect(indexer.listSessions({ limit: 10, offset: 0 }).total).toBe(1);
    await mkdir(directory, { recursive: true });
    await indexer.scan([sessionRoot], []);
    expect(indexer.listSessions({ limit: 10, offset: 0 }).total).toBe(0);

    await indexer.scan([], []);
    expect(indexer.listArtifacts({ limit: 10, offset: 0 }).total).toBe(0);
    expect(indexer.roots()).toEqual([]);
  });
});
