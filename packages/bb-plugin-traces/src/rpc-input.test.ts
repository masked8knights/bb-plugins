import { describe, expect, it } from "vitest";
import { listArtifactsInput, listSessionsInput } from "./rpc-input";

describe("trace RPC inputs", () => {
  it("omits empty optional fields instead of sending undefined over RPC", () => {
    expect(listSessionsInput("", "")).toEqual({ limit: 100, offset: 0 });
    expect(listArtifactsInput("  ")).toEqual({ limit: 100, offset: 0 });
    expect(JSON.stringify(listSessionsInput("", ""))).not.toContain("undefined");
  });

  it("keeps non-empty filters and trims them", () => {
    expect(listSessionsInput("  tool call ", "  codex ")).toEqual({
      query: "tool call",
      source: "codex",
      limit: 100,
      offset: 0,
    });
    expect(listArtifactsInput(" decision ")).toEqual({
      query: "decision",
      limit: 100,
      offset: 0,
    });
  });

  it("passes non-default session sorting without adding an unnecessary default field", () => {
    expect(listSessionsInput("", "", "duration")).toEqual({
      sort: "duration",
      limit: 100,
      offset: 0,
    });
  });

  it("builds continuation requests without losing the active filters", () => {
    expect(listSessionsInput("tool", "codex", "events", 100, 50)).toEqual({
      query: "tool",
      source: "codex",
      sort: "events",
      limit: 50,
      offset: 100,
    });
    expect(listArtifactsInput("plan", "decision", 25, 50)).toEqual({
      query: "plan",
      kind: "decision",
      limit: 50,
      offset: 25,
    });
  });
});
