// bb-plugin-auto-new-tab — a BB plugin frontend entry.
//
// Behavior: when the workspace side panel would show its default "Info" page
// (because the panel is open and there are no tabs), automatically open the
// "New Tab" page instead — the same as clicking the "+" in the tab strip.
//
// bb opens the Info tab (kind `thread-info`) whenever the panel state has no
// valid active tab. The app itself already swaps Info for a New Tab on the
// root-compose surface, but thread/workspace views keep showing Info. There
// is no plugin SDK API for workspace tabs, so this content script drives the
// app's own "Open new tab" button, which is exactly the action the user would
// take manually.
import { definePluginApp } from "@bb/plugin-sdk/app";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "auto-open-new-tab",
    mount({ signal }) {
      // The Info tab pill renders only when the panel is open and
      // showInfoTab is enabled; the testid sits on a wrapper div and
      // aria-pressed reflects "Info is the active tab and no file tab is
      // active" — i.e. the Info page is on screen.
      const INFO_TAB_PILL =
        '[data-testid="thread-info-tab"] button[aria-pressed="true"]';
      // The "+" button in the panel tab strip. Desktop chrome appends the
      // shortcut hint to the label ("Open new tab (⌘T)"), so match by prefix.
      const NEW_TAB_BUTTON = 'button[aria-label^="Open new tab"]';
      // Real tabs (file previews, browser, terminal, plugin panels) render a
      // close button on their pill; fixed tabs (Info, new-tab) do not.
      const REAL_TAB_PILL = "[data-tab-pill-close]";

      let timer: number | undefined;

      const clickNewTabIfInfoPageShown = () => {
        // Info page not shown → nothing to do.
        if (!document.querySelector(INFO_TAB_PILL)) return;
        // Some tab is actually open → leave the panel alone.
        if (document.querySelector(REAL_TAB_PILL)) return;
        const button = document.querySelector<HTMLButtonElement>(NEW_TAB_BUTTON);
        if (!button) return;
        if (timer !== undefined) return; // already queued
        timer = window.setTimeout(() => {
          timer = undefined;
          // Re-validate right before clicking so a fast user action wins.
          if (!document.querySelector(INFO_TAB_PILL)) return;
          if (document.querySelector(REAL_TAB_PILL)) return;
          document.querySelector<HTMLButtonElement>(NEW_TAB_BUTTON)?.click();
        }, 300);
      };

      const observer = new MutationObserver(clickNewTabIfInfoPageShown);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-pressed"],
      });

      // Panel may already be open with the Info page before we mounted.
      clickNewTabIfInfoPageShown();

      signal.addEventListener("abort", () => {
        observer.disconnect();
        if (timer !== undefined) window.clearTimeout(timer);
      });
    },
  });
});
