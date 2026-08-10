import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { GroveStore, migrations } from "./store";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("GroveStore migrations", () => {
  it("repairs duplicate legacy bindings before enforcing source uniqueness", () => {
    const database = new Database(":memory:");
    databases.push(database);
    for (const migration of migrations.slice(0, 4)) database.exec(migration);

    const insertBinding = database.prepare(
      `INSERT INTO grove_bindings (
         id, path, source_kind, thread_id, environment_id, project_id,
         host_id, title, owner_thread_id, status, last_sha256, last_error,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertBinding.run(
      "binding-old",
      "/workspace/notes.md",
      "host",
      null,
      null,
      "project-1",
      null,
      "Notes",
      "owner-old",
      "error",
      "sha-old",
      "provider stopped",
      1,
      1,
    );
    insertBinding.run(
      "binding-new",
      "/workspace/notes.md",
      "host",
      null,
      null,
      "project-1",
      null,
      "Notes",
      "owner-new",
      "ready",
      "sha-new",
      null,
      2,
      2,
    );
    insertBinding.run(
      "workspace-old",
      "project.md",
      "workspace",
      null,
      "environment-1",
      "project-1",
      "host-legacy",
      "Project",
      "owner-workspace-old",
      "ready",
      "sha-workspace-old",
      null,
      1,
      1,
    );
    insertBinding.run(
      "workspace-new",
      "project.md",
      "workspace",
      null,
      "environment-1",
      "project-1",
      null,
      "Project",
      "owner-workspace-new",
      "ready",
      "sha-workspace-new",
      null,
      2,
      2,
    );
    database
      .prepare(
        `INSERT INTO grove_dictation_queue
           (id, binding_id, transcript, status, created_at)
         VALUES (?, ?, ?, 'queued', ?)`,
      )
      .run("queue-1", "binding-old", "Keep this passage", 3);

    database.exec(migrations[4]!);

    const store = new GroveStore(database);
    expect(store.listBindings()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "binding-new",
          ownerThreadId: "owner-new",
          status: "ready",
        }),
        expect.objectContaining({
          id: "workspace-new",
          source: expect.objectContaining({ hostId: null }),
        }),
      ]),
    );
    expect(store.listBindings()).toHaveLength(2);
    expect(
      database
        .prepare("SELECT binding_id FROM grove_dictation_queue WHERE id = ?")
        .get("queue-1"),
    ).toEqual({ binding_id: "binding-new" });

    expect(() =>
      insertBinding.run(
        "binding-third",
        "/workspace/notes.md",
        "host",
        null,
        null,
        "project-1",
        null,
        "Notes",
        "owner-third",
        "ready",
        "sha-third",
        null,
        4,
        4,
      ),
    ).toThrow(/UNIQUE/iu);

    expect(() =>
      insertBinding.run(
        "workspace-third",
        "project.md",
        "workspace",
        null,
        "environment-1",
        "project-1",
        null,
        "Project",
        "owner-workspace-third",
        "ready",
        "sha-workspace-third",
        null,
        4,
        4,
      ),
    ).toThrow(/UNIQUE/iu);
  });
});
