# bb-plugin-emoji-react

Emoji reactions in the assistant-message text-selection menu **and the
per-message action bar** — a port of NeonPilot's `system-reply-actions`
extension to bb.

Select any text in an agent response, and the floating selection menu (next
to "Add to chat") shows one emoji button per configured reaction. Clicking
one drafts a reply:

```
> <the highlighted text>

👍 Agree
```

and focuses the composer. Each reaction is a user-configurable emoji + label
pair, editable in **Tools → Extensions → Emoji React → Emoji reactions**.
The reaction buttons show the emoji only (the host renders plugin actions
with the plugin's compact icon — identical for every reaction — so a content
script swaps that icon for the emoji glyph in the per-message action bar and
strips it from the floating selection menu), while the drafted reply uses
the full `emoji label` text.

## Settings

- **Emoji reactions** (`emojiItems`) — comma-separated `emoji label` items.
  Each item appears as one button in the selection menu and is used verbatim
  as the drafted reply text. Empty removes all reaction buttons.
  Default: `👍 Agree, 👎 Disagree, ✅ Do it, ❓ Clarify`
- **Quote the highlighted text** (`quoteSelection`) — when enabled (default),
  reacting drafts the highlighted text as a quote block, so the agent sees
  exactly what you reacted to.
- **Quote position** (`quotePosition`) — where the quote goes relative to the
  reaction text: `before` (default) drafts the quote first, then the reaction;
  `after` drafts the reaction first, then the quote.

Edit them in the plugin's settings page (the "Emoji reactions" editor, or the
raw fields below it) or via the CLI:

```sh
bb plugin config emoji-react set emojiItems "👍 Agree, 👎 Disagree, ✅ Do it"
bb plugin config emoji-react set quoteSelection true
bb plugin config emoji-react set quotePosition before
bb plugin reload emoji-react
```

The settings editor's **Save & apply** updates the selection menu immediately
(the host only re-interprets a plugin frontend when its bundle changes, so the
editor briefly disables and re-enables the plugin to refresh the menu).
Changes made via the CLI apply on the next app reload or frontend
re-interpretation.

## How it works

- `messageAction` slots add one selection-menu entry per configured reaction
  (bb's equivalent of NeonPilot's `selectionActions` + `settingItems`).
  Registrations are static per frontend interpretation, so `app.tsx` reads
  the plugin settings synchronously at setup time (same-origin XHR to the
  plugin settings endpoint) and falls back to the defaults when the server
  is unreachable.
- A zero-visibility composer banner captures the bound `useComposer()` API
  into a module ref — `messageAction` runs are plain host-chrome callbacks
  with no hook access, and banners mount in every composer layout.
- The settings section on the plugin detail page is a live editor (rows of
  emoji + label inputs) persisting through the standard plugin settings
  endpoint.
- A content script replaces the plugin's compact icon with the reaction
  glyph: the per-message action bar renders plugin actions as icon-only
  buttons (the title lives in `aria-label`), so the script swaps the icon
  span for the emoji text; the floating selection-menu buttons already carry
  the emoji as their label, so there the icon span is simply stripped. It
  relies on the icon span's `data-plugin-icon-asset` URL, so if a future bb
  changes those internals the script degrades to leaving the icon in place.

## Development

```sh
bb plugin install .    # register
bb plugin dev          # watch loop: rebuild + reload on save
pnpm typecheck
pnpm test              # vitest for src/emoji-items parsing
pnpm build             # self-contained dist/
```
