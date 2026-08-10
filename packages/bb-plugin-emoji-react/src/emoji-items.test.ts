import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMOJI_ITEMS,
  MAX_EMOJI_ITEMS,
  parseEmojiItem,
  parseEmojiItems,
  serializeEmojiItems,
  splitEmojiItemList,
} from "./emoji-items";

describe("splitEmojiItemList", () => {
  it("splits on commas, semicolons, and newlines", () => {
    expect(splitEmojiItemList("👍 Agree, 👎 Disagree; ✅ Do it\n❓ Clarify")).toEqual([
      "👍 Agree",
      "👎 Disagree",
      "✅ Do it",
      "❓ Clarify",
    ]);
  });

  it("trims and drops empty parts", () => {
    expect(splitEmojiItemList("  👍 Agree ,, ; \n 👎 Disagree ")).toEqual([
      "👍 Agree",
      "👎 Disagree",
    ]);
  });

  it("returns [] for empty input", () => {
    expect(splitEmojiItemList("")).toEqual([]);
    expect(splitEmojiItemList("   ")).toEqual([]);
  });
});

describe("parseEmojiItem", () => {
  it("splits the first token as the emoji", () => {
    expect(parseEmojiItem("👍 Agree")).toEqual({
      emoji: "👍",
      label: "Agree",
      text: "👍 Agree",
    });
  });

  it("handles multi-word labels", () => {
    expect(parseEmojiItem("📋 Summarize this please")).toEqual({
      emoji: "📋",
      label: "Summarize this please",
      text: "📋 Summarize this please",
    });
  });

  it("treats a bare token as emoji-only", () => {
    expect(parseEmojiItem("🎉")).toEqual({ emoji: "🎉", label: "", text: "🎉" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseEmojiItem("  👎 Disagree  ")).toEqual({
      emoji: "👎",
      label: "Disagree",
      text: "👎 Disagree",
    });
  });
});

describe("parseEmojiItems", () => {
  it("parses the default list", () => {
    const items = parseEmojiItems(DEFAULT_EMOJI_ITEMS);
    expect(items).toHaveLength(4);
    expect(items[0]).toEqual({ emoji: "👍", label: "Agree", text: "👍 Agree" });
    expect(items[3]).toEqual({ emoji: "❓", label: "Clarify", text: "❓ Clarify" });
  });

  it("returns [] for unset, empty, and garbage values", () => {
    expect(parseEmojiItems(undefined)).toEqual([]);
    expect(parseEmojiItems("")).toEqual([]);
    expect(parseEmojiItems("   ")).toEqual([]);
    expect(parseEmojiItems(",,;")).toEqual([]);
  });

  it("caps at MAX_EMOJI_ITEMS", () => {
    const many = Array.from(
      { length: MAX_EMOJI_ITEMS + 5 },
      (_, index) => `${index + 1} item`,
    ).join(", ");
    expect(parseEmojiItems(many)).toHaveLength(MAX_EMOJI_ITEMS);
  });
});

describe("serializeEmojiItems", () => {
  it("round-trips parsed items", () => {
    const items = parseEmojiItems(DEFAULT_EMOJI_ITEMS);
    expect(serializeEmojiItems(items)).toBe(DEFAULT_EMOJI_ITEMS);
  });

  it("joins with commas and drops empty rows", () => {
    expect(
      serializeEmojiItems([
        { emoji: "👍", label: "Agree", text: "👍 Agree" },
        { emoji: "", label: "", text: "" },
        { emoji: "🎉", label: "", text: "🎉" },
      ]),
    ).toBe("👍 Agree, 🎉");
  });

  it("caps at MAX_EMOJI_ITEMS", () => {
    const many = Array.from({ length: MAX_EMOJI_ITEMS + 3 }, (_, index) => ({
      emoji: String(index),
      label: "item",
      text: `${index} item`,
    }));
    expect(serializeEmojiItems(many).split(", ")).toHaveLength(MAX_EMOJI_ITEMS);
  });
});
