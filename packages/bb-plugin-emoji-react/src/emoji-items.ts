// Emoji reaction item parsing — shared by the backend (settings) and the
// frontend (selection-menu actions, settings editor).
//
// The setting is a comma/semicolon/newline separated list of "emoji label"
// items, exactly like NeonPilot's system-reply-actions `emojiPickerItems`
// (control `emoji-label-list`). Each item is used both as the selection-menu
// button label and as the drafted reply text. Example:
//
//   "👍 Agree, 👎 Disagree, ✅ Do it, ❓ Clarify, 💡 Explain, 📋 Summarize"

export interface EmojiItem {
  /** First whitespace-delimited token of the raw item (e.g. "👍"). */
  emoji: string;
  /** The rest of the raw item (e.g. "Agree"). Empty when the item is a bare token. */
  label: string;
  /** The full trimmed item as the user wrote it (e.g. "👍 Agree"). */
  text: string;
}

/** Default list, mirroring NeonPilot's system-reply-actions default (trimmed to 4 so the selection menu stays narrow). */
export const DEFAULT_EMOJI_ITEMS = "👍 Agree, 👎 Disagree, ✅ Do it, ❓ Clarify";

/**
 * Cap on items: the selection menu is a single horizontal row of buttons, so
 * a long list overflows the viewport.
 */
export const MAX_EMOJI_ITEMS = 8;

/** Split an item string on commas, semicolons, and newlines. */
export function splitEmojiItemList(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Parse one raw item into emoji + label (first whitespace token = emoji). */
export function parseEmojiItem(raw: string): EmojiItem {
  const text = raw.trim();
  const match = text.match(/^(\S+)(?:\s+(.*))?$/s);
  const emoji = match?.[1] ?? text;
  const label = (match?.[2] ?? "").trim();
  return { emoji, label, text };
}

/**
 * Parse a stored settings value into reaction items. Handles undefined
 * (unset), empty strings (all reactions hidden), and garbage values
 * (treated as empty). Capped at {@link MAX_EMOJI_ITEMS}.
 */
export function parseEmojiItems(raw: string | undefined): EmojiItem[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  return splitEmojiItemList(raw)
    .slice(0, MAX_EMOJI_ITEMS)
    .map(parseEmojiItem)
    .filter((item) => item.emoji.length > 0 || item.label.length > 0);
}

/** Serialize items back into the comma-separated settings string. */
export function serializeEmojiItems(items: readonly EmojiItem[]): string {
  return items
    .map((item) => {
      const trimmed = item.text.trim();
      return trimmed.length > 0 ? trimmed : `${item.emoji} ${item.label}`.trim();
    })
    .filter((text) => text.length > 0)
    .slice(0, MAX_EMOJI_ITEMS)
    .join(", ");
}
