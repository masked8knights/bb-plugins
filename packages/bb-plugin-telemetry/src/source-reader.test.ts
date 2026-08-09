import { describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const bb = {
      sdk: {
        files: {
          listPaths: vi.fn(async () => ({
            paths: [{ kind: "file", path: "/tmp/codex.jsonl" }],
            truncated: true,
          })),
          read: vi.fn(async () => ({
            content: '{"type":"session","session_id":"session-1","timestamp":1760000000000}',
            contentEncoding: "utf8" as const,
            sha256: "fingerprint-1",
          })),
        },
      },
    } as unknown as BbPluginApi;

    const result = await scanProviderSource(
      bb,
      defaultSettings(),
      "codex",
      { id: "primary", name: "Primary host", homePath: "/tmp", connected: true },
    );

    expect(result.truncated).toBe(true);
    expect(result.warning).toMatch(/truncated/u);
    expect(result.records).toHaveLength(1);
  });

  it("includes archived Codex sessions and marks them archived", async () => {
    const listPaths = vi.fn(async ({ path }: { path: string }) => ({
      paths: [{
        kind: "file" as const,
        path: path.includes("archived_sessions")
          ? `${path}/archived.jsonl`
          : `${path}/regular.jsonl`,
      }],
      truncated: false,
    }));
    const read = vi.fn(async ({ path }: { path: string }) => ({
      content: JSON.stringify({
        type: "session",
        session_id: path.includes("archived_sessions") ? "archived-1" : "regular-1",
        timestamp: "2026-08-07T21:00:00Z",
      }),
      contentEncoding: "utf8" as const,
      sha256: path,
    }));
    const bb = {
      sdk: { files: { listPaths, read } },
    } as unknown as BbPluginApi;

    const result = await scanProviderSource(
      bb,
      defaultSettings(),
      "codex",
      { id: "primary", name: "Primary host", homePath: "/tmp", connected: true },
    );

    expect(listPaths).toHaveBeenCalledTimes(2);
    expect(result.records).toHaveLength(2);
    expect(result.records.find((record) => record.session.providerSessionId === "archived-1")?.session.archived).toBe(true);
    expect(result.records.find((record) => record.session.providerSessionId === "regular-1")?.session.archived).toBe(false);
  });

  it("excludes CodexBar sessions by path and working directory", async () => {
    const paths = [
      "/tmp/CodexBar/ClaudeProbe/session.jsonl",
      "/tmp/session-with-cwd-marker.jsonl",
    ];
    const read = vi.fn(async ({ path }: { path: string }) => ({
      content: path.includes("cwd")
        ? '{"type":"session_meta","timestamp":"2026-08-07T21:00:00Z","payload":{"id":"session-cwd","cwd":"/Users/patrick/Library/Application Support/CodexBar/ClaudeProbe"}}'
        : '{"type":"session_meta","timestamp":"2026-08-07T21:00:00Z","payload":{"id":"session-path"}}',
      contentEncoding: "utf8" as const,
      sha256: path,
    }));
    const bb = {
      sdk: {
        files: {
          listPaths: vi.fn(async () => ({
            paths: paths.map((path) => ({ kind: "file" as const, path })),
            truncated: false,
          })),
          read,
        },
      },
    } as unknown as BbPluginApi;

    const result = await scanProviderSource(
      bb,
      defaultSettings(),
      "claude",
      { id: "primary", name: "Primary host", homePath: "/tmp", connected: true },
    );

    expect(result.records).toHaveLength(0);
    expect(result.count).toBe(0);
    expect(result.warning).toMatch(/Excluded 2 CodexBar sessions/u);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
