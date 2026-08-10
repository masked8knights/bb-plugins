import { describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { defaultSettings } from "./source-registry";
import { databaseFingerprint, resolveHost, scanProviderSource } from "./source-reader";

describe("telemetry source host resolution", () => {
  it("invalidates SQLite fingerprints when the WAL sidecar changes", () => {
    const root = mkdtempSync(join("/tmp", "telemetry-wal-fingerprint-"));
    try {
      const databasePath = join(root, "provider.db");
      writeFileSync(databasePath, "database");
      const before = databaseFingerprint(databasePath);
      writeFileSync(`${databasePath}-wal`, "frame-1");
      const afterFirstFrame = databaseFingerprint(databasePath);
      appendFileSync(`${databasePath}-wal`, "frame-2");
      const afterSecondFrame = databaseFingerprint(databasePath);
      expect(afterFirstFrame).not.toBe(before);
      expect(afterSecondFrame).not.toBe(afterFirstFrame);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("treats the primary host sentinel as the local host", async () => {
    const list = vi.fn(async () => []);
    const bb = {
      sdk: { hosts: { list } },
    } as unknown as BbPluginApi;

    await expect(resolveHost(bb, "primary")).resolves.toMatchObject({
      id: "primary",
      connected: true,
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("fails closed when a configured host is unavailable", async () => {
    const listPaths = vi.fn();
    const bb = {
      sdk: {
        hosts: {
          list: vi.fn(async () => [{ id: "other", name: "Other", status: "connected" }]),
        },
        files: { listPaths },
      },
    } as unknown as BbPluginApi;
    const settings = defaultSettings();
    settings.sources.codex.hostId = "missing";

    await expect(resolveHost(bb, "missing")).resolves.toMatchObject({
      id: "missing",
      connected: false,
      homePath: "",
    });
    const result = await scanProviderSource(
      bb,
      settings,
      "codex",
      { id: "primary", name: "Primary host", homePath: "/tmp", connected: true },
    );

    expect(result.error).toMatch(/unavailable/u);
    expect(listPaths).not.toHaveBeenCalled();
  });

  it("surfaces truncated JSONL listings as partial scans", async () => {
    const root = mkdtempSync(join("/tmp", "telemetry-truncated-"));
    try {
      const sessionPath = join(root, "codex.jsonl");
      writeFileSync(sessionPath, '{"type":"session","session_id":"session-1","timestamp":1760000000000}');
      const bb = {
        sdk: {
          files: {
            listPaths: vi.fn(async () => ({
              paths: [{ kind: "file", path: sessionPath }],
              truncated: true,
            })),
          },
        },
      } as unknown as BbPluginApi;

      const result = await scanProviderSource(
        bb,
        defaultSettings(),
        "codex",
        { id: "primary", name: "Primary host", homePath: root, connected: true },
      );

      expect(result.truncated).toBe(true);
      expect(result.warning).toMatch(/truncated/u);
      expect(result.records).toHaveLength(1);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("includes archived Codex sessions and marks them archived", async () => {
    const root = mkdtempSync(join("/tmp", "telemetry-archived-"));
    try {
      const sessionsDir = join(root, ".codex", "sessions");
      const archiveDir = join(root, ".codex", "archived_sessions");
      mkdirSync(sessionsDir, { recursive: true });
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(join(sessionsDir, "regular.jsonl"), '{"type":"session","session_id":"regular-1","timestamp":"2026-08-07T21:00:00Z"}');
      writeFileSync(join(archiveDir, "archived.jsonl"), '{"type":"session","session_id":"archived-1","timestamp":"2026-08-07T21:00:00Z"}');
      const listPaths = vi.fn(async ({ path }: { path: string }) => ({
        paths: [{
          kind: "file" as const,
          path: path.includes("archived_sessions")
            ? join(archiveDir, "archived.jsonl")
            : join(sessionsDir, "regular.jsonl"),
        }],
        truncated: false,
      }));
      const bb = {
        sdk: { files: { listPaths } },
      } as unknown as BbPluginApi;

      const result = await scanProviderSource(
        bb,
        defaultSettings(),
        "codex",
        { id: "primary", name: "Primary host", homePath: root, connected: true },
      );

      expect(listPaths).toHaveBeenCalledTimes(2);
      expect(result.records).toHaveLength(2);
      expect(result.records.find((record) => record.session.providerSessionId === "archived-1")?.session.archived).toBe(true);
      expect(result.records.find((record) => record.session.providerSessionId === "regular-1")?.session.archived).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("excludes CodexBar sessions by path and working directory", async () => {
    const root = mkdtempSync(join("/tmp", "telemetry-codexbar-"));
    try {
      const sessionsDir = join(root, ".claude", "projects");
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, "session.jsonl"), '{"type":"session_meta","timestamp":"2026-08-07T21:00:00Z","payload":{"id":"session-path"}}');
      writeFileSync(join(sessionsDir, "cwd-marker.jsonl"), '{"type":"session_meta","timestamp":"2026-08-07T21:00:00Z","payload":{"id":"session-cwd","cwd":"/Users/patrick/Library/Application Support/CodexBar/ClaudeProbe"}}');
      const bb = {
        sdk: {
          files: {
            listPaths: vi.fn(async () => ({
              paths: [
                { kind: "file" as const, path: join(root, "CodexBar", "ClaudeProbe", "session.jsonl") },
                { kind: "file" as const, path: join(sessionsDir, "cwd-marker.jsonl") },
              ],
              truncated: false,
            })),
          },
        },
      } as unknown as BbPluginApi;

      const result = await scanProviderSource(
        bb,
        defaultSettings(),
        "claude",
        { id: "primary", name: "Primary host", homePath: root, connected: true },
      );

      expect(result.records).toHaveLength(0);
      expect(result.count).toBe(0);
      expect(result.warning).toMatch(/Excluded 2 CodexBar sessions/u);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("skips unchanged files via stat fingerprints on incremental scans", async () => {
    const root = mkdtempSync(join("/tmp", "telemetry-unchanged-"));
    try {
      const sessionsDir = join(root, ".codex", "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      const sessionPath = join(sessionsDir, "session-1.jsonl");
      writeFileSync(sessionPath, '{"type":"session","session_id":"session-1","timestamp":1760000000000}');
      const bb = {
        sdk: {
          files: {
            listPaths: vi.fn(async () => ({ paths: [{ kind: "file", path: sessionPath }], truncated: false })),
          },
        },
      } as unknown as BbPluginApi;
      const host = { id: "primary", name: "Primary host", homePath: root, connected: true };

      // First scan has nothing stored, so the file is read and fingerprinted.
      const first = await scanProviderSource(bb, defaultSettings(), "codex", host);
      expect(first.records).toHaveLength(1);
      const storedFingerprint = first.records[0]!.session.fingerprint;
      if (!storedFingerprint) throw new Error("expected a stat fingerprint");
      expect(storedFingerprint).toMatch(/:\d+:\d+:\d+:\d+$/); // stat-based, not a content hash
      const storedFiles = new Map([[sessionPath, { fingerprint: storedFingerprint, sessionId: "session-1" }]]);

      // Incremental scan with a matching stored fingerprint skips the file.
      const incremental = await scanProviderSource(bb, defaultSettings(), "codex", host, {
        full: false,
        existingFiles: storedFiles,
      });
      expect(incremental.records).toHaveLength(0);
      expect(incremental.skippedStoreLabels).toContain("session-1.jsonl");
      expect(incremental.files.get(sessionPath)).toEqual({ fingerprint: storedFingerprint, sessionId: "session-1" });

      // A changed file (different mtime) is re-read.
      writeFileSync(sessionPath, '{"type":"session","session_id":"session-1","timestamp":1760000000001}');
      utimesSync(sessionPath, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
      const changed = await scanProviderSource(bb, defaultSettings(), "codex", host, {
        full: false,
        existingFiles: storedFiles,
      });
      expect(changed.records).toHaveLength(1);
      expect(changed.records[0]!.session.fingerprint).not.toBe(storedFingerprint);

      // A full scan ignores the stored fingerprint and re-reads.
      const full = await scanProviderSource(bb, defaultSettings(), "codex", host, {
        full: true,
        existingFiles: storedFiles,
      });
      expect(full.records).toHaveLength(1);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("requests file listings up to bb's server-side cap", async () => {
    const listPaths = vi.fn(async () => ({ paths: [], truncated: false }));
    const bb = {
      sdk: { files: { listPaths } },
    } as unknown as BbPluginApi;

    await scanProviderSource(
      bb,
      defaultSettings(),
      "codex",
      { id: "primary", name: "Primary host", homePath: "/tmp", connected: true },
    );

    expect(listPaths).toHaveBeenCalledWith(expect.objectContaining({ limit: 10_000 }));
  });
});
