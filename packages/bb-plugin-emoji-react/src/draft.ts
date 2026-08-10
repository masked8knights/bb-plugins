// Draft composition for emoji reactions — shared, pure, unit-tested.
//
// The reaction draft shape is: an optional quote block of the highlighted
// text plus the reaction text ("👍 Agree"). The setting `quotePosition`
// decides the order:
//
//   "before" (default) → quote first, then the reaction text
//   "after"            → reaction text first, then the quote

export type QuotePosition = "before" | "after";

export const DEFAULT_QUOTE_POSITION: QuotePosition = "before";

/** Parse a stored settings value into a valid QuotePosition. */
export function parseQuotePosition(raw: unknown): QuotePosition {
  return raw === "after" ? "after" : "before";
}

/**
 * Compose the next draft text after a reaction. `current` is the draft as it
 * stands once the quote block (if any) has been added; `reaction` is the
 * trimmed reaction text; `hasQuote` tells whether a quote block is present
 * (the position only applies when there is a quote to position).
 */
export function composeReactionDraft(
  current: string,
  reaction: string,
  hasQuote: boolean,
  quotePosition: QuotePosition,
): string {
  const trimmed = reaction.trim();
  if (trimmed.length === 0) return current;
  if (current.length === 0) return trimmed;
  // "after" = the quote sits AFTER the reaction text → reaction goes first.
  return hasQuote && quotePosition === "after"
    ? `${trimmed}\n\n${current}`
    : `${current}\n\n${trimmed}`;
}
