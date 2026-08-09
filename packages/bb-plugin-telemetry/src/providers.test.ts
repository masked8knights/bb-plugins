import { describe, expect, it } from "vitest";
import { parseProviderJsonl, parseProviderMetadataSession } from "./providers";
import { mergeParsedRecords } from "./source-reader";

describe("provider record normalization", () => {
  it("keeps structured JSONL metrics when Prime metadata has the same id", () => {
    const jsonl = parseProviderJsonl(
      "prime",
      "primary",
      "/tmp/prime-session.jsonl",
      [
        JSON.stringify({ type: "session", session_id: "same-session", timestamp: 1_700_000_000_000 }),
        JSON.stringify({ type: "tool_call", id: "tool-1", name: "shell", status: "completed", timestamp: 1_700_000_001_000 }),
      ].join("\n"),
      "jsonl-fingerprint",
    );
    const metadata = parseProviderMetadataSession({
      provider: "prime",
      hostId: "primary",
      providerSessionId: "same-session",
      path: "/tmp/prime.db",
      title: "Metadata title",
      cwd: "/workspace",
      model: "prime-model",
      startedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
      messageCount: 4,
      fingerprint: "sqlite-fingerprint",
    });
    if (!jsonl) throw new Error("expected JSONL record");

    const [merged] = mergeParsedRecords([jsonl, metadata]);
    expect(merged.session.title).toBe("Metadata title");
    expect(merged.session.model).toBe("prime-model");
    expect(merged.session.cwd).toBe("/workspace");
    expect(merged.items).toHaveLength(1);
    expect(merged.session.toolCalls).toBe(1);
    expect(merged.session.messageCount).toBe(4);
    expect(merged.session.fingerprint).not.toBe("jsonl-fingerprint");
  });

  it("derives tool errors from the final update for a deduplicated item", () => {
    const parsed = parseProviderJsonl(
      "codex",
      "primary",
      "/tmp/codex-session.jsonl",
      [
        JSON.stringify({ type: "session", session_id: "counter-session", timestamp: 1_700_000_000_000 }),
        JSON.stringify({ type: "tool_call", id: "tool-1", name: "shell", status: "failed", error: { type: "timeout" }, timestamp: 1_700_000_001_000 }),
        JSON.stringify({ type: "tool_call", id: "tool-1", name: "shell", status: "completed", timestamp: 1_700_000_002_000 }),
      ].join("\n"),
      "fingerprint",
    );
    if (!parsed) throw new Error("expected parsed record");

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.status).toBe("completed");
    expect(parsed.items[0]?.errorCategory).toBeNull();
    expect(parsed.session.toolCalls).toBe(1);
    expect(parsed.session.toolErrors).toBe(0);
    expect(parsed.session.failureCount).toBe(0);
  });
});
