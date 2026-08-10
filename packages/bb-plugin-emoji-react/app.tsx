// bb-plugin-emoji-react — frontend.
//
// Port of NeonPilot's system-reply-actions extension for bb:
//
// 1. Selection menu — one `messageAction` per configured emoji item appears
//    in the assistant-message text-selection menu (next to "Add to chat").
//    Clicking one drafts a reply: the highlighted text quoted first, the
//    reaction text (e.g. "👍 Agree") below it.
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
}

function readSettingsSnapshot(): SettingsSnapshot {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `/api/v1/plugins/${PLUGIN_ID}/settings`, false);
    xhr.send();
    if (xhr.status !== 200) {
      return { emojiItems: undefined, quoteSelection: true, quotePosition: "before" };
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
    };
  } catch {
    // Server unreachable / malformed response: fall back to defaults rather
    // than failing the whole frontend registration.
    return { emojiItems: undefined, quoteSelection: true, quotePosition: "before" };
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
  }, [values?.emojiItems, values?.quoteSelection, values?.quotePosition]);

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
        <Button
          type="button"
          size="sm"
          onClick={() => void save()}
          disabled={saving || isLoading}
          className="ml-auto"
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

  // One selection-menu action per configured reaction. The button label is
  // the emoji only (the host's selection menu is a horizontal row, so labeled
  // buttons get wide), while the drafted reply still uses the full item text
  // ("👍 Agree") captured in the run closure.
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
      "Reactions shown in the assistant-message text-selection menu.",
    component: EmojiReactionsSettings,
  });

  // Strip the plugin's compact icon from the emoji-only selection-menu
  // buttons. The menu is host-rendered chrome: it always renders the
  // plugin's icon next to the action label (PluginIcon has no icon-less
  // path), and plugin stylesheets are @scope-confined to plugin roots, so
  // this full-trust script removes the icon span inside portaled overlays.
  // The icon stays everywhere else (hover action bar, plugin list, …) —
  // only the floating menu loses it, because only that surface shows the
  // icon next to an emoji that already says everything.
  app.contentScripts.register({
    id: "selection-menu-icons",
    mount({ signal }) {
      // The icon span is `<span data-plugin-icon-asset="/api/v1/plugins/
      // emoji-react/assets/icon?h=…">` — unique to this plugin, so other
      // plugins' actions in the same menu are never touched.
      const ICON_SELECTOR =
        'span[data-plugin-icon-asset*="plugins/emoji-react/assets/icon"]';

      const sweep = () => {
        for (const overlay of Array.from(
          document.querySelectorAll("[data-bb-portaled-overlay]"),
        )) {
          for (const icon of Array.from(overlay.querySelectorAll(ICON_SELECTOR))) {
            icon.remove();
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
