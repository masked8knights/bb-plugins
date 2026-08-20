// bb-plugin-emoji-react — frontend.
//
// Port of NeonPilot's system-reply-actions extension for bb:
//
// 1. Reactions — one `messageAction` per configured emoji item, shown in the
//    assistant-message text-selection menu (next to "Add to chat") and as an
//    icon button in the per-message action bar. Clicking one drafts a reply:
//    the highlighted text quoted first, the reaction text (e.g. "👍 Agree")
//    below it. Both surfaces render the emoji itself, not the plugin icon —
//    see the content script at the bottom.
//
// 2. Settings — a settingsSection editor with emoji + label rows (like
//    NeonPilot's `emoji-label-list` control). Saving persists via the
//    standard plugin settings endpoint and re-applies the menu immediately
//    through a disable/enable cycle, because the host only re-interprets a
//    plugin frontend when its bundle hash changes or the plugin re-appears.
//
// The emoji list must exist at frontend-interpretation time (slot
// registrations are static), so setup reads the plugin settings
// synchronously with a same-origin XHR. Failures fall back to the defaults;
// the menu then refreshes on the next interpretation (app reload, `bb
// plugin dev` rebuild, or the editor's save & apply).
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  useComposer,
  useSettings,
  type PluginComposerApi,
  type PluginMessageActionContext,
} from "@bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  MAX_EMOJI_ITEMS,
  parseEmojiItems,
  serializeEmojiItems,
  type EmojiItem,
} from "./src/emoji-items";
import {
  composeReactionDraft,
  parseQuotePosition,
  type QuotePosition,
} from "./src/draft";

const PLUGIN_ID = "emoji-react";

// ---------------------------------------------------------------------------
// Settings snapshot read synchronously at setup (slot registrations are
// static per frontend interpretation, and `useSettings` is hook-only).
// ---------------------------------------------------------------------------

interface SettingsSnapshot {
  emojiItems: string | undefined;
  quoteSelection: boolean;
  quotePosition: QuotePosition;
  showInSelectionMenu: boolean;
  showInAssistantBar: boolean;
  showInUserBar: boolean;
}

function readSettingsSnapshot(): SettingsSnapshot {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `/api/v1/plugins/${PLUGIN_ID}/settings`, false);
    xhr.send();
    if (xhr.status !== 200) {
      return {
        emojiItems: undefined,
        quoteSelection: true,
        quotePosition: "before",
        showInSelectionMenu: true,
        showInAssistantBar: true,
        showInUserBar: true,
      };
    }
    const body = JSON.parse(xhr.responseText) as {
      values?: Record<string, unknown>;
    };
    const values = body.values ?? {};
    return {
      emojiItems:
        typeof values.emojiItems === "string" ? values.emojiItems : undefined,
      quoteSelection: values.quoteSelection !== false,
      quotePosition: parseQuotePosition(values.quotePosition),
      showInSelectionMenu: values.showInSelectionMenu !== false,
      showInAssistantBar: values.showInAssistantBar !== false,
      showInUserBar: values.showInUserBar !== false,
    };
  } catch {
    // Server unreachable / malformed response: fall back to defaults rather
    // than failing the whole frontend registration.
    return {
      emojiItems: undefined,
      quoteSelection: true,
      quotePosition: "before",
      showInSelectionMenu: true,
      showInAssistantBar: true,
      showInUserBar: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Composer bridge: `messageAction` runs are host chrome (plain callbacks, no
// hooks), so a banner component captures the bound `useComposer()` API into a
// module ref. Banners mount in every composer layout (actions do not mount in
// compact), and the bridge renders nothing.
// ---------------------------------------------------------------------------

const composerRef: { current: PluginComposerApi | null } = { current: null };

function ComposerBridge() {
  const composer = useComposer();
  useEffect(() => {
    composerRef.current = composer;
    return () => {
      if (composerRef.current === composer) composerRef.current = null;
    };
  }, [composer]);
  return null;
}

/** Draft the reaction: quote and reaction text in the configured order. */
function draftReaction(
  composer: PluginComposerApi,
  itemText: string,
  selectedText: string | null,
  quoteSelection: boolean,
  quotePosition: QuotePosition,
): void {
  const quoted =
    quoteSelection &&
    selectedText !== null &&
    selectedText.trim().length > 0;
  if (quoted) {
    // `addQuote` appends the quote block to the draft; composeReactionDraft
    // then slots the reaction text in before or after it.
    composer.addQuote(selectedText);
  }
  composer.updateText((current) =>
    composeReactionDraft(current, itemText, quoted, quotePosition),
  );
  composer.focus();
}

// ---------------------------------------------------------------------------
// Settings editor (settingsSection on the plugin detail page)
// ---------------------------------------------------------------------------

function EmojiReactionsSettings() {
  const { values, isLoading } = useSettings();
  const [items, setItems] = useState<EmojiItem[]>(() =>
    parseEmojiItems(
      typeof values?.emojiItems === "string" ? values.emojiItems : undefined,
    ),
  );
  const [quoteSelection, setQuoteSelection] = useState(
    values?.quoteSelection !== false,
  );
  const [quotePosition, setQuotePosition] = useState<QuotePosition>(
    parseQuotePosition(values?.quotePosition),
  );
  const [showInSelectionMenu, setShowInSelectionMenu] = useState(
    values?.showInSelectionMenu !== false,
  );
  const [showInAssistantBar, setShowInAssistantBar] = useState(
    values?.showInAssistantBar !== false,
  );
  const [showInUserBar, setShowInUserBar] = useState(
    values?.showInUserBar !== false,
  );
  const [saving, setSaving] = useState(false);

  // Keep local state in sync when settings change elsewhere (CLI, the
  // host-rendered settings form, or this editor's own save cycle).
  useEffect(() => {
    setItems(
      parseEmojiItems(
        typeof values?.emojiItems === "string" ? values.emojiItems : undefined,
      ),
    );
    setQuoteSelection(values?.quoteSelection !== false);
    setQuotePosition(parseQuotePosition(values?.quotePosition));
    setShowInSelectionMenu(values?.showInSelectionMenu !== false);
    setShowInAssistantBar(values?.showInAssistantBar !== false);
    setShowInUserBar(values?.showInUserBar !== false);
  }, [
    values?.emojiItems,
    values?.quoteSelection,
    values?.quotePosition,
    values?.showInSelectionMenu,
    values?.showInAssistantBar,
    values?.showInUserBar,
  ]);

  const updateItem = (index: number, patch: Partial<EmojiItem>) => {
    setItems((current) =>
      current.map((item, i) => {
        if (i !== index) return item;
        const emoji = patch.emoji ?? item.emoji;
        const label = patch.label ?? item.label;
        return { emoji, label, text: `${emoji} ${label}`.trim() };
      }),
    );
  };

  const addItem = () => {
    setItems((current) =>
      current.length >= MAX_EMOJI_ITEMS
        ? current
        : [...current, { emoji: "", label: "", text: "" }],
    );
  };

  const removeItem = (index: number) => {
    setItems((current) =>
      current.length <= 1
        ? current
        : current.filter((_, i) => i !== index),
    );
  };

  const save = async () => {
    setSaving(true);
    try {
      const cleaned = items.filter(
        (item) => item.emoji.trim().length > 0 || item.label.trim().length > 0,
      );
      const response = await fetch(`/api/v1/plugins/${PLUGIN_ID}/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          values: {
            emojiItems: serializeEmojiItems(cleaned),
            quoteSelection,
            quotePosition,
            showInSelectionMenu,
            showInAssistantBar,
            showInUserBar,
          },
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!response.ok || body?.ok !== true) {
        throw new Error(body?.error ?? `HTTP ${response.status}`);
      }
      toast.success("Emoji reactions saved");
      // Apply immediately: the host only re-interprets a frontend when its
      // bundle hash changes or the plugin re-appears, so a disable/enable
      // cycle re-runs setup, which re-reads the fresh settings.
      const disable = await fetch(`/api/v1/plugins/${PLUGIN_ID}/disable`, {
        method: "POST",
      });
      const enable = await fetch(`/api/v1/plugins/${PLUGIN_ID}/enable`, {
        method: "POST",
      });
      if (!disable.ok || !enable.ok) {
        toast.error(
          "Saved, but the selection menu could not be refreshed automatically — reload the app window to see the new reactions.",
        );
      }
    } catch (error) {
      toast.error(
        `Failed to save emoji reactions: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Each reaction appears as an emoji-only button in the assistant-message
        text-selection menu (the menu is a single horizontal row, so labels
        would make it too wide). Clicking one drafts a reply with the
        highlighted text quoted and the full reaction text — emoji + label —
        in the order chosen below. Save &amp; apply refreshes the menu
        immediately.
      </p>
      <div className="space-y-2">
        {items.map((item, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              value={item.emoji}
              onChange={(event) =>
                updateItem(index, { emoji: event.target.value })
              }
              className="w-14 shrink-0 text-center"
              aria-label={`Reaction ${index + 1} emoji`}
              placeholder="👍"
            />
            <Input
              value={item.label}
              onChange={(event) =>
                updateItem(index, { label: event.target.value })
              }
              className="flex-1"
              aria-label={`Reaction ${index + 1} label`}
              placeholder="Agree"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove reaction ${index + 1}`}
              onClick={() => removeItem(index)}
              disabled={items.length <= 1}
            >
              <Icon name="Trash2" className="size-4" />
            </Button>
          </div>
        ))}
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No reactions. Add one below — empty lists hide the emoji buttons
            in the selection menu.
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addItem}
          disabled={items.length >= MAX_EMOJI_ITEMS}
        >
          <Icon name="Plus" className="mr-1 size-4" />
          Add reaction
        </Button>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={quoteSelection}
            onChange={(event) => setQuoteSelection(event.target.checked)}
            className="size-4 accent-foreground"
          />
          Quote the highlighted text
        </label>
        <select
          value={quotePosition}
          onChange={(event) =>
            setQuotePosition(
              event.target.value === "after" ? "after" : "before",
            )
          }
          disabled={!quoteSelection}
          aria-label="Quote position"
          className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground disabled:opacity-50"
        >
          <option value="before">Quote first</option>
          <option value="after">Reaction first</option>
        </select>
      </div>

      {/* Location toggles */}
      <div className="rounded-md border border-border p-3 space-y-2">
        <p className="text-sm font-medium">Where reactions appear</p>
        <p className="text-xs text-muted-foreground">
          Toggle the surfaces where emoji reactions show up. At least one
          location must stay enabled to keep reactions visible.
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showInSelectionMenu}
            onChange={(event) => setShowInSelectionMenu(event.target.checked)}
            className="size-4 accent-foreground"
          />
          Show in text selection menu (floating menu &amp; right-click)
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showInAssistantBar}
            onChange={(event) => setShowInAssistantBar(event.target.checked)}
            className="size-4 accent-foreground"
          />
          Show at bottom of assistant messages
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showInUserBar}
            onChange={(event) => setShowInUserBar(event.target.checked)}
            className="size-4 accent-foreground"
          />
          Show at bottom of user messages
        </label>
        {!showInSelectionMenu && !showInAssistantBar && !showInUserBar ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            All locations are disabled — reactions will be hidden everywhere
            until you re-enable at least one.
          </p>
        ) : null}
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={() => void save()}
          disabled={saving || isLoading}
        >
          {saving ? "Saving…" : "Save & apply"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plugin app setup
// ---------------------------------------------------------------------------

export default definePluginApp((app) => {
  const snapshot = readSettingsSnapshot();
  const items = parseEmojiItems(snapshot.emojiItems);
  const quoteSelection = snapshot.quoteSelection;
  const quotePosition = snapshot.quotePosition;
  const showInSelectionMenu = snapshot.showInSelectionMenu;
  const showInAssistantBar = snapshot.showInAssistantBar;
  const showInUserBar = snapshot.showInUserBar;

  const anySurfaceEnabled =
    showInSelectionMenu || showInAssistantBar || showInUserBar;

  // One selection-menu action per configured reaction. The button label is
  // the emoji only (the host's selection menu is a horizontal row, so labeled
  // buttons get wide), while the drafted reply still uses the full item text
  // ("👍 Agree") captured in the run closure.
  // If every surface is disabled we skip registration entirely — the reactions
  // are hidden everywhere until the user re-enables a location.
  if (items.length > 0 && anySurfaceEnabled) {
    items.forEach((item, index) => {
      app.slots.messageAction({
        id: `emoji-react-${index + 1}`,
        title: item.emoji || item.label || item.text,
        run(context: PluginMessageActionContext) {
          const composer = composerRef.current;
          if (composer === null) {
            toast.error(
              "Emoji reactions need the thread composer open — open this thread in the main view and try again.",
            );
            return;
          }
          draftReaction(
            composer,
            item.text,
            context.selectedText ?? null,
            quoteSelection,
            quotePosition,
          );
        },
      });
    });
  }

  // Keeps `useComposer()` available to the messageAction runs above. Mounts
  // in every composer layout and renders nothing.
  app.composer.customize({
    id: "emoji-react-composer",
    banners: [
      { id: "composer-bridge", chrome: "bare", component: ComposerBridge },
    ],
  });

  app.slots.settingsSection({
    id: "emoji-reactions-editor",
    title: "Emoji reactions",
    description:
      "Reactions shown in the assistant-message text-selection menu and per-message action bar.",
    component: EmojiReactionsSettings,
  });

  // Emoji-only surfaces need the plugin's compact icon replaced by the
  // reaction glyph itself, because the host renders plugin messageActions
  // with PluginIcon (no icon-less path) and plugin stylesheets are
  // @scope-confined to plugin roots. Two surfaces, two treatments:
  //
  // - Selection menu (portaled overlay): the action title is rendered as
  //   button text next to the icon, so the icon is redundant — strip it.
  // - Per-message action bar: plugin actions render as icon-only buttons
  //   (the title lives in `aria-label`), so every reaction would show the
  //   same plugin icon. Swap the icon span for the reaction glyph.
  // The icon stays everywhere else (plugin list, hover action bar button,
  // …) — only surfaces where the emoji already says everything lose it.
  //
  // Location toggles (showInSelectionMenu / showInAssistantBar / showInUserBar)
  // are enforced here: the single `messageAction` slot drives both surfaces,
  // so we hide the DOM for disabled locations. Selection menu buttons carry
  // text, action-bar buttons are icon-only; for the action bar we attempt to
  // detect user vs assistant via ancestor attributes/classes and only hide
  // when we can confidently tell the role.
  app.contentScripts.register({
    id: "emoji-glyph-actions",
    mount({ signal }) {
      // The icon span is `<span data-plugin-icon-asset="/api/v1/plugins/
      // emoji-react/assets/icon?h=…">` — unique to this plugin, so other
      // plugins' actions in the same menu are never touched.
      const ICON_SELECTOR =
        'span[data-plugin-icon-asset*="plugins/emoji-react/assets/icon"]';
      const GLYPH_MARKER = "data-emoji-react-glyph";
      const SURFACE_ATTR = "data-emoji-react-surface";

      // Keep a set of our reaction titles to spot already-processed glyph buttons
      const reactionTitles = new Set(
        items.map((i) => (i.emoji || i.label || i.text).trim()).filter(Boolean),
      );

      const isSelectionMenuButton = (button: HTMLButtonElement): boolean =>
        (button.textContent ?? "").trim().length > 0;

      const getMessageRole = (
        button: HTMLButtonElement,
      ): "user" | "assistant" | null => {
        let el: Element | null = button;
        for (let i = 0; i < 10 && el; i++) {
          const dataRole =
            el.getAttribute("data-role") ??
            el.getAttribute("data-message-role") ??
            el.getAttribute("data-conversation-role") ??
            el.getAttribute("data-testid") ??
            "";
          const lower = dataRole.toLowerCase();
          if (lower.includes("assistant")) return "assistant";
          if (lower === "user" || lower.includes("user-message") || lower.includes("user_message")) return "user";
          // Class-based heuristics
          const cls = (el.getAttribute("class") ?? "").toLowerCase();
          if (cls.includes("assistant")) return "assistant";
          if (cls.includes("user-message") || cls.includes("role-user")) return "user";
          // Some builds put role on a nearby test id like "message-assistant"
          if (lower.includes("assistant-message") || lower.includes("assistant_message")) return "assistant";
          el = el.parentElement;
        }
        // Fallback: search ancestors for any element whose aria-label or title hints at role
        let scan: Element | null = button.parentElement;
        for (let i = 0; i < 6 && scan; i++) {
          const label = (scan.getAttribute("aria-label") ?? "").toLowerCase();
          if (label.includes("assistant")) return "assistant";
          if (label.includes("user")) return "user";
          scan = scan.parentElement;
        }
        return null;
      };

      const shouldHideForSurface = (
        surface: string | null,
        role: "user" | "assistant" | null,
        isSelection: boolean,
      ): boolean => {
        if (isSelection) return !showInSelectionMenu;
        // action-bar path
        if (role === "assistant") return !showInAssistantBar;
        if (role === "user") return !showInUserBar;
        // surface hint fallback
        if (surface === "assistant-bar") return !showInAssistantBar;
        if (surface === "user-bar") return !showInUserBar;
        // Unknown role: only hide if both bars are disabled (global action-bar off)
        if (!showInAssistantBar && !showInUserBar) return true;
        return false;
      };

      const shouldHide = (button: HTMLButtonElement): boolean => {
        if (isSelectionMenuButton(button)) {
          return !showInSelectionMenu;
        }
        // Per-message action bar (icon-only before swap, glyph after)
        const role = getMessageRole(button);
        if (role === "assistant") return !showInAssistantBar;
        if (role === "user") return !showInUserBar;
        // Unknown role: only hide if both bars are disabled (global action-bar off)
        if (!showInAssistantBar && !showInUserBar) return true;
        return false;
      };

      const sweep = () => {
        // 1) Fresh buttons that still carry the plugin icon
        for (const icon of Array.from(document.querySelectorAll(ICON_SELECTOR))) {
          const button = icon.closest("button") as HTMLButtonElement | null;
          if (button === null) {
            icon.remove();
            continue;
          }

          const isSelection = isSelectionMenuButton(button);
          const role = isSelection ? null : getMessageRole(button);
          const surface = isSelection ? "selection-menu" : role ? (role + "-bar") : "action-bar";

          if (shouldHide(button)) {
            button.style.display = "none";
            button.setAttribute("hidden", "");
            button.setAttribute(SURFACE_ATTR, surface);
            continue;
          } else {
            // Ensure button is visible if previously hidden (settings just changed via reload on same DOM)
            if (button.hasAttribute("hidden") || button.style.display === "none") {
              button.style.display = "";
              button.removeAttribute("hidden");
            }
            button.setAttribute(SURFACE_ATTR, surface);
          }

          // Selection menu: the button already carries the emoji as text
          // next to the icon — drop the redundant icon.
          if (isSelection) {
            icon.remove();
            continue;
          }
          // Per-message action bar: the button is icon-only; its accessible
          // name (the emoji) becomes the visible glyph.
          const label = button.getAttribute("aria-label");
          if (label === null || label.trim().length === 0) {
            icon.remove();
            continue;
          }
          // Avoid double-replacing if we already swapped
          if (button.querySelector(`span[${GLYPH_MARKER}]`) !== null) continue;
          const glyph = document.createElement("span");
          glyph.setAttribute("aria-hidden", "true");
          glyph.setAttribute(GLYPH_MARKER, "true");
          glyph.textContent = label.trim();
          icon.replaceWith(glyph);
        }

        // 2) Already-processed buttons: icon is gone, glyph or plain text remains.
        // Find our reaction buttons via the surface marker or via aria-label matching.
        const candidates = new Set<HTMLButtonElement>();
        for (const el of Array.from(document.querySelectorAll(`button[${SURFACE_ATTR}]`))) {
          const b = el as HTMLButtonElement;
          candidates.add(b);
        }
        for (const el of Array.from(document.querySelectorAll(`span[${GLYPH_MARKER}]`))) {
          const btn = (el as Element).closest("button") as HTMLButtonElement | null;
          if (btn) candidates.add(btn);
        }
        // Fallback: buttons whose aria-label matches a known reaction title (covers pre-marker DOM from previous generation)
        for (const btn of Array.from(document.querySelectorAll('button[aria-label]')) as HTMLButtonElement[]) {
          const aria = (btn.getAttribute("aria-label") ?? "").trim();
          if (reactionTitles.has(aria) && !candidates.has(btn)) {
            // Heuristic: only treat as ours if it looks like an action-bar or selection-menu reaction
            // (selection menu buttons after icon removal still have aria-label? Usually they do, but we can include)
            candidates.add(btn);
          }
        }

        for (const button of candidates) {
          // Skip buttons still handled by the icon loop (they have icon and were already processed)
          if (button.querySelector(ICON_SELECTOR) !== null) continue;

          const surface = button.getAttribute(SURFACE_ATTR);
          const hasGlyph = button.querySelector(`span[${GLYPH_MARKER}]`) !== null;
          // Re-derive surface/role if marker missing
          const isSelection = !hasGlyph && (button.textContent ?? "").trim().length > 0 && surface === "selection-menu";
          // For glyph buttons, they are always action-bar
          const role = hasGlyph ? getMessageRole(button) : null;
          const isSelectionCandidate = hasGlyph ? false : (surface === "selection-menu" || (!hasGlyph && (button.textContent ?? "").trim().length > 0 && reactionTitles.has((button.textContent ?? "").trim())));

          let hide = false;
          if (hasGlyph) {
            hide = shouldHideForSurface(surface, role, false);
          } else if (surface === "selection-menu" || isSelectionCandidate) {
            hide = !showInSelectionMenu;
          } else {
            // Unknown pre-marker button that matched aria-label: treat as action-bar
            hide = shouldHideForSurface(surface, role, false);
          }

          if (hide) {
            button.style.display = "none";
            button.setAttribute("hidden", "");
          } else {
            if (button.style.display === "none") button.style.display = "";
            button.removeAttribute("hidden");
          }
        }
      };

      // The menu mounts fresh per selection; watch for it and clean up as
      // soon as it appears. rAF-debounced so streaming text mutations do
      // not trigger a sweep every token.
      let frame: number | undefined;
      const schedule = () => {
        if (frame !== undefined) return;
        frame = requestAnimationFrame(() => {
          frame = undefined;
          sweep();
        });
      };
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
      sweep(); // the menu may already be open when the script mounts

      signal.addEventListener("abort", () => {
        observer.disconnect();
        if (frame !== undefined) cancelAnimationFrame(frame);
      });
    },
  });
});

