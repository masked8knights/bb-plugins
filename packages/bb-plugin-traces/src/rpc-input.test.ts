import { describe, expect, it } from "vitest";
import { getSessionInput, listSessionsInput } from "./rpc-input";

describe("trace RPC inputs", () => {
  it("omits empty optional fields instead of sending undefined over RPC", () => {
    expect(listSessionsInput("", "")).toEqual({ limit: 100, offset: 0 });
    expect(JSON.stringify(listSessionsInput("", ""))).not.toContain("undefined");
  });

  it("keeps non-empty filters and trims them", () => {
    expect(listSessionsInput("  tool call ", "  codex ")).toEqual({
      query: "tool call",
      source: "codex",
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
  });

  it("builds collection health filters without sending inactive defaults", () => {
    expect(listSessionsInput("", "", "errors", 0, 100, { errorFilter: "only", status: "active", hasTools: true })).toEqual({
      errorFilter: "only",
      status: "active",
      hasTools: true,
      sort: "errors",
      limit: 100,
      offset: 0,
    });
  });

  it("builds trajectory filter requests with deduplicated values", () => {
    expect(getSessionInput("session-one", 2_000, 0, {
      query: "  permission denied ",
      categories: ["tool", "tool"],
      toolTypes: [" exec ", "exec"],
      errorFilter: "only",
    })).toEqual({
      id: "session-one",
      query: "permission denied",
      categories: ["tool"],
      toolTypes: ["exec"],
      errorFilter: "only",
      limit: 2_000,
      offset: 0,
    });
  });
});
