import { describe, expect, it } from "vitest";
import {
  composeReactionDraft,
  DEFAULT_QUOTE_POSITION,
  parseQuotePosition,
} from "./draft";

describe("parseQuotePosition", () => {
  it("accepts both values", () => {
    expect(parseQuotePosition("before")).toBe("before");
    expect(parseQuotePosition("after")).toBe("after");
  });

  it("falls back to the default for anything else", () => {
    expect(parseQuotePosition(undefined)).toBe(DEFAULT_QUOTE_POSITION);
    expect(parseQuotePosition("")).toBe(DEFAULT_QUOTE_POSITION);
    expect(parseQuotePosition("sideways")).toBe(DEFAULT_QUOTE_POSITION);
    expect(parseQuotePosition(42)).toBe(DEFAULT_QUOTE_POSITION);
  });
});

describe("composeReactionDraft", () => {
  const quote = "> selected text";

  it("places the quote first with quotePosition before (default)", () => {
    expect(composeReactionDraft(quote, "👍 Agree", true, "before")).toBe(
      "> selected text\n\n👍 Agree",
    );
  });

  it("places the reaction first with quotePosition after", () => {
    expect(composeReactionDraft(quote, "👍 Agree", true, "after")).toBe(
      "👍 Agree\n\n> selected text",
    );
  });

  it("appends the reaction when there is no quote, regardless of position", () => {
    expect(composeReactionDraft("existing draft", "👍 Agree", false, "before")).toBe(
      "existing draft\n\n👍 Agree",
    );
    expect(composeReactionDraft("existing draft", "👍 Agree", false, "after")).toBe(
      "existing draft\n\n👍 Agree",
    );
  });

  it("handles an empty draft", () => {
    expect(composeReactionDraft("", "👍 Agree", false, "before")).toBe("👍 Agree");
  });

  it("keeps the draft unchanged for an empty reaction", () => {
    expect(composeReactionDraft(quote, "   ", true, "before")).toBe(quote);
  });
});
