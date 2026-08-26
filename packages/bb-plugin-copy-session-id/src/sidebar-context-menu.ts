import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

export const COPY_MENU_LABEL = "Copy session ID";

const THREAD_ROW_SELECTOR =
  "[data-sidebar-thread-id], [data-thread-id], [data-session-id]";
const MENU_SELECTOR = '[role="menu"], [data-radix-menu-content]';
const MENU_SEPARATOR_SELECTOR =
  '[role="separator"], [data-radix-menu-separator]';
const MENU_ITEM_SELECTOR =
  '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [data-radix-collection-item], button';
const ITEM_MARKER = "data-copy-session-id-item";
const ITEM_SESSION_ATTRIBUTE = "data-copy-session-id";
const SEPARATOR_MARKER = "data-copy-session-id-separator";
const ITEM_CLASS = "bb-copy-session-id-menu-item";
const ITEM_LABEL_CLASS = "bb-copy-session-id-menu-label";
const STYLES_MARKER = "data-copy-session-id-styles";
const MENU_NAVIGATION_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
  "PageDown",
  "PageUp",
]);
const TYPEAHEAD_TIMEOUT_MS = 700;

const ITEM_STYLES = `
[${ITEM_MARKER}] {
  cursor: default;
  transition: background-color 150ms cubic-bezier(0.4, 0, 0.2, 1),
    color 150ms cubic-bezier(0.4, 0, 0.2, 1);
}

[${ITEM_MARKER}]:hover,
[${ITEM_MARKER}]:focus,
[${ITEM_MARKER}]:focus-visible,
[${ITEM_MARKER}][data-highlighted],
[${ITEM_MARKER}][data-last-hovered] {
  background-color: var(--state-hover, rgba(127, 127, 127, 0.14)) !important;
  color: var(--foreground, currentColor) !important;
}

[${ITEM_MARKER}] > .${ITEM_LABEL_CLASS} {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  [${ITEM_MARKER}] {
    transition: none;
  }
}
`;

type PendingContextMenu = {
  sessionId: string;
  clientX: number;
  clientY: number;
  knownMenus: Set<HTMLElement>;
};

function eventTargetElement(target: EventTarget | null): Element | null {
  if (typeof Element !== "undefined" && target instanceof Element) {
    return target;
  }
  if (typeof Node !== "undefined" && target instanceof Node) {
    return target.parentElement;
  }
  return null;
}

export function getSessionIdFromTarget(
  target: EventTarget | null,
): string | null {
  const element = eventTargetElement(target);
  const row = element?.closest<HTMLElement>(THREAD_ROW_SELECTOR);
  if (!row) return null;

  for (const attribute of [
    "data-sidebar-thread-id",
    "data-thread-id",
    "data-session-id",
  ]) {
    const value = row.getAttribute(attribute)?.trim();
    if (value) return value;
  }
  return null;
}

function isVisible(element: HTMLElement, document: Document): boolean {
  if (element.hidden || element.getAttribute("aria-hidden") === "true") {
    return false;
  }
  if (element.getAttribute("data-state") === "closed") return false;

  const style = document.defaultView?.getComputedStyle(element);
  return style?.display !== "none" && style?.visibility !== "hidden";
}

function visibleMenus(document: Document): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(MENU_SELECTOR),
  ).filter((menu) => isVisible(menu, document));
}

function menuScore(menu: HTMLElement, pending: PendingContextMenu): number {
  let score = pending.knownMenus.has(menu) ? 0 : 100;

  if (menu.getAttribute("data-state") === "open") score += 20;
  if (menu.getAttribute("aria-hidden") === "false") score += 10;
  if (menu.querySelector(MENU_ITEM_SELECTOR)) score += 5;

  const rect = menu.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    const containsPointer =
      pending.clientX >= rect.left &&
      pending.clientX <= rect.right &&
      pending.clientY >= rect.top &&
      pending.clientY <= rect.bottom;
    if (containsPointer) score += 40;
  }

  return score;
}

function findContextMenu(
  document: Document,
  pending: PendingContextMenu,
): HTMLElement | null {
  const menus = visibleMenus(document).filter(
    (menu) => !menu.hasAttribute(ITEM_MARKER),
  );
  const newMenus = menus.filter((menu) => !pending.knownMenus.has(menu));
  if (newMenus.length > 0) {
    return (
      newMenus.sort(
        (left, right) =>
          menuScore(right, pending) - menuScore(left, pending),
      )[0] ?? null
    );
  }

  const pointedMenus = menus.filter((menu) => {
    const rect = menu.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      pending.clientX >= rect.left &&
      pending.clientX <= rect.right &&
      pending.clientY >= rect.top &&
      pending.clientY <= rect.bottom
    );
  });
  if (pointedMenus.length > 0) {
    return pointedMenus[0] ?? null;
  }

  // A jsdom test and a few embedded clients report zero-sized layout rects.
  // Fall back to the only visible menu in that case, but never guess when
  // several unrelated menus are open.
  return menus.length === 1 ? (menus[0] ?? null) : null;
}

function menuItemTemplate(menu: HTMLElement): HTMLElement | null {
  return (
    Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).find(
      (item) => !item.hasAttribute(ITEM_MARKER),
    ) ?? null
  );
}

function menuSeparatorTemplate(menu: HTMLElement): HTMLElement | null {
  return (
    Array.from(
      menu.querySelectorAll<HTMLElement>(MENU_SEPARATOR_SELECTOR),
    ).find((separator) => !separator.hasAttribute(SEPARATOR_MARKER)) ?? null
  );
}

function menuItems(menu: HTMLElement, document: Document): HTMLElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR),
  ).filter((item, index, all) => {
    if (item.closest<HTMLElement>(MENU_SELECTOR) !== menu) return false;
    if (all.indexOf(item) !== index) return false;
    if (!isVisible(item, document)) return false;
    return (
      !item.hasAttribute("disabled") &&
      item.getAttribute("aria-disabled") !== "true" &&
      !item.hasAttribute("data-disabled")
    );
  });
}

function menuItemLabel(item: HTMLElement): string {
  return (item.getAttribute("aria-label") ?? item.textContent ?? "")
    .trim()
    .toLocaleLowerCase();
}

function clearCloneIdentity(element: HTMLElement): void {
  element.removeAttribute("id");
  element.removeAttribute("aria-describedby");
  element.removeAttribute("aria-labelledby");
  element.removeAttribute("aria-disabled");
  for (const attribute of [
    "data-state",
    "data-highlighted",
    "data-disabled",
    "data-last-hovered",
    ITEM_MARKER,
    ITEM_SESSION_ATTRIBUTE,
  ]) {
    element.removeAttribute(attribute);
  }
}

function installItemStyles(document: Document): HTMLStyleElement {
  const style =
    document.querySelector<HTMLStyleElement>(
      "style[" + STYLES_MARKER + "]",
    ) ?? document.createElement("style");
  if (!style.hasAttribute(STYLES_MARKER)) {
    style.setAttribute(STYLES_MARKER, "");
  }
  style.textContent = ITEM_STYLES;
  if (!style.isConnected) {
    (document.head ?? document.documentElement ?? document.body)?.append(style);
  }
  return style;
}

function updateMenuItem(item: HTMLElement, sessionId: string): void {
  item.setAttribute(ITEM_MARKER, "");
  item.setAttribute(ITEM_SESSION_ATTRIBUTE, sessionId);
  item.classList.add(ITEM_CLASS);
  item.setAttribute("role", "menuitem");
  item.setAttribute("tabindex", "-1");
  item.setAttribute("aria-label", COPY_MENU_LABEL);

  const label = item.ownerDocument.createElement("span");
  label.className = ITEM_LABEL_CLASS;
  label.textContent = COPY_MENU_LABEL;
  item.replaceChildren(label);
}

export async function writeClipboardText(
  value: string,
  document: Document = globalThis.document,
): Promise<void> {
  if (!value) throw new Error("Cannot copy an empty session ID");

  const clipboard = document.defaultView?.navigator.clipboard;
  let clipboardError: unknown;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(value);
      return;
    } catch (error) {
      clipboardError = error;
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";

  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];

  try {
    document.body.append(textarea);
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    if (
      typeof document.execCommand !== "function" ||
      !document.execCommand("copy")
    ) {
      throw new Error("Clipboard writing is not supported");
    }
  } catch (error) {
    throw clipboardError ?? error;
  } finally {
    textarea.remove();
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}

type MountContext = Pick<PluginContentScriptContext, "signal">;

export function mountCopySessionIdContextMenu(
  { signal }: MountContext,
  document: Document = globalThis.document,
): () => void {
  const view = document.defaultView;
  if (!view || signal.aborted) return () => {};

  let disposed = false;
  let pending: PendingContextMenu | null = null;
  let scanTimer: number | null = null;
  let expiryTimer: number | null = null;
  let typeaheadBuffer = "";
  let typeaheadTimer: number | null = null;
  const dismissTimers = new Set<number>();
  const ownedItems = new Map<HTMLElement, HTMLElement>();
  const itemStyles = installItemStyles(document);

  const removeItem = (item: HTMLElement): void => {
    ownedItems.delete(item);
    item.remove();
  };

  const removeOwnedItems = (): void => {
    for (const item of Array.from(ownedItems.keys())) removeItem(item);
    for (const item of Array.from(
      document.querySelectorAll<HTMLElement>("[" + ITEM_MARKER + "]"),
    )) {
      item.remove();
    }
    for (const separator of Array.from(
      document.querySelectorAll<HTMLElement>(
        "[" + SEPARATOR_MARKER + "]",
      ),
    )) {
      separator.remove();
    }
  };

  const clearPending = (): void => {
    pending = null;
    if (scanTimer !== null) {
      view.clearTimeout(scanTimer);
      scanTimer = null;
    }
    if (expiryTimer !== null) {
      view.clearTimeout(expiryTimer);
      expiryTimer = null;
    }
  };

  const clearTypeahead = (): void => {
    typeaheadBuffer = "";
    if (typeaheadTimer !== null) {
      view.clearTimeout(typeaheadTimer);
      typeaheadTimer = null;
    }
  };

  const armTypeahead = (): void => {
    if (typeaheadTimer !== null) view.clearTimeout(typeaheadTimer);
    typeaheadTimer = view.setTimeout(() => {
      typeaheadTimer = null;
      typeaheadBuffer = "";
    }, TYPEAHEAD_TIMEOUT_MS);
  };

  const syncHoverState = (
    menu: HTMLElement,
    hoveredMenuItem: HTMLElement,
  ): void => {
    for (const menuItem of menuItems(menu, document)) {
      if (menuItem === hoveredMenuItem) {
        menuItem.setAttribute("data-last-hovered", "");
      } else {
        menuItem.removeAttribute("data-last-hovered");
      }
    }
  };

  const focusMenuItem = (menuItem: HTMLElement): void => {
    menuItem.focus({ preventScroll: true });
  };

  const closeMenu = (menu: HTMLElement): void => {
    if (disposed) return;
    menu.dispatchEvent(
      new view.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    const timer = view.setTimeout(() => {
      dismissTimers.delete(timer);
      if (disposed) return;
      for (const [item, itemMenu] of ownedItems) {
        if (itemMenu === menu) removeItem(item);
      }
      for (const separator of Array.from(
        menu.querySelectorAll<HTMLElement>("[" + SEPARATOR_MARKER + "]"),
      )) {
        separator.remove();
      }
    }, 0);
    dismissTimers.add(timer);
  };

  const copyFromItem = async (item: HTMLElement): Promise<void> => {
    const sessionId = item.getAttribute(ITEM_SESSION_ATTRIBUTE)?.trim();
    const menu = ownedItems.get(item);
    if (!sessionId || !menu || disposed) return;

    try {
      await writeClipboardText(sessionId, document);
      if (
        disposed ||
        ownedItems.get(item) !== menu ||
        item.getAttribute(ITEM_SESSION_ATTRIBUTE)?.trim() !== sessionId
      ) {
        return;
      }
      toast.success("Session ID copied to clipboard");
      closeMenu(menu);
    } catch (error) {
      if (
        disposed ||
        ownedItems.get(item) !== menu ||
        item.getAttribute(ITEM_SESSION_ATTRIBUTE)?.trim() !== sessionId
      ) {
        return;
      }
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to copy session ID to the clipboard",
      );
    }
  };

  const installMenuItem = (
    menu: HTMLElement,
    sessionId: string,
  ): boolean => {
    const ensureSeparator = (before?: HTMLElement): void => {
      if (menu.querySelector("[" + SEPARATOR_MARKER + "]")) return;
      const template = menuSeparatorTemplate(menu);
      if (!template) return;

      const separator = template.cloneNode(true) as HTMLElement;
      clearCloneIdentity(separator);
      separator.setAttribute(SEPARATOR_MARKER, "");
      separator.setAttribute("role", "separator");
      if (before?.parentElement === menu) {
        menu.insertBefore(separator, before);
      } else {
        menu.append(separator);
      }
    };

    const existing = menu.querySelector<HTMLElement>(
      "[" + ITEM_MARKER + "]",
    );
    if (existing) {
      ensureSeparator(existing);
      updateMenuItem(existing, sessionId);
      ownedItems.set(existing, menu);
      return true;
    }

    const template = menuItemTemplate(menu);
    if (!template) return false;

    const item = template.cloneNode(true) as HTMLElement;
    clearCloneIdentity(item);
    updateMenuItem(item, sessionId);
    ensureSeparator();

    const handleClick = (event: MouseEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      void copyFromItem(item);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      void copyFromItem(item);
    };

    item.addEventListener("click", handleClick);
    item.addEventListener("keydown", handleKeyDown);
    menu.append(item);
    ownedItems.set(item, menu);
    return true;
  };

  const scheduleScan = (): void => {
    if (scanTimer !== null || !pending || disposed) return;
    scanTimer = view.setTimeout(() => {
      scanTimer = null;
      if (!pending || disposed) return;

      const menu = findContextMenu(document, pending);
      if (menu && installMenuItem(menu, pending.sessionId)) {
        clearPending();
        return;
      }
      scheduleScan();
    }, 0);
  };

  const handleContextMenu = (event: MouseEvent): void => {
    clearTypeahead();
    removeOwnedItems();
    clearPending();

    const sessionId = getSessionIdFromTarget(event.target);
    if (!sessionId) return;

    pending = {
      sessionId,
      clientX: event.clientX,
      clientY: event.clientY,
      knownMenus: new Set(visibleMenus(document)),
    };
    expiryTimer = view.setTimeout(clearPending, 2_000);
    scheduleScan();
  };

  const handlePointerDown = (event: PointerEvent): void => {
    const target = eventTargetElement(event.target);
    if (target?.closest("[" + ITEM_MARKER + "]")) return;
    if (event.button === 2 || !target?.closest(MENU_SELECTOR)) {
      clearTypeahead();
      removeOwnedItems();
      clearPending();
    }
  };

  const handlePointerOver = (event: PointerEvent): void => {
    const target = eventTargetElement(event.target);
    const hoveredMenuItem = target?.closest<HTMLElement>(MENU_ITEM_SELECTOR);
    const menu = hoveredMenuItem?.closest<HTMLElement>(MENU_SELECTOR);
    if (!hoveredMenuItem || !menu) return;

    syncHoverState(menu, hoveredMenuItem);
    if (ownedItems.get(hoveredMenuItem) === menu) {
      hoveredMenuItem.focus({ preventScroll: true });
    }
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      clearTypeahead();
      removeOwnedItems();
      clearPending();
      return;
    }

    const target = eventTargetElement(event.target);
    const menu = target?.closest<HTMLElement>(MENU_SELECTOR);
    if (!menu) return;

    const activeTarget =
      target?.closest<HTMLElement>(MENU_ITEM_SELECTOR) ??
      eventTargetElement(document.activeElement)?.closest<HTMLElement>(
        MENU_ITEM_SELECTOR,
      );
    const items = menuItems(menu, document);
    const currentIndex = activeTarget ? items.indexOf(activeTarget) : -1;
    const currentItem = currentIndex >= 0 ? items[currentIndex] : null;

    if (
      MENU_NAVIGATION_KEYS.has(event.key) &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey
    ) {
      clearTypeahead();
      for (const menuItem of menuItems(menu, document)) {
        menuItem.removeAttribute("data-last-hovered");
      }

      let nextIndex = currentIndex;
      if (event.key === "ArrowDown") nextIndex += 1;
      if (event.key === "ArrowUp") nextIndex -= 1;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = items.length - 1;
      if (event.key === "PageDown") nextIndex = items.length - 1;
      if (event.key === "PageUp") nextIndex = 0;

      const nextItem = items[nextIndex];
      const pluginNavigation =
        currentItem?.hasAttribute(ITEM_MARKER) ||
        nextItem?.hasAttribute(ITEM_MARKER);
      if (pluginNavigation) {
        event.preventDefault();
        event.stopPropagation();
        if (nextItem) focusMenuItem(nextItem);
        return;
      }
    }

    if (
      event.key.length !== 1 ||
      event.key === " " ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return;
    }

    const typed = event.key.toLocaleLowerCase();
    let search = typeaheadBuffer + typed;
    let match = items.find((item) => menuItemLabel(item).startsWith(search));
    if (!match && typeaheadBuffer) {
      search = typed;
      match = items.find((item) => menuItemLabel(item).startsWith(search));
    }
    typeaheadBuffer = search;
    armTypeahead();

    if (!match || !match.hasAttribute(ITEM_MARKER)) return;
    event.preventDefault();
    event.stopPropagation();
    for (const menuItem of menuItems(menu, document)) {
      menuItem.removeAttribute("data-last-hovered");
    }
    focusMenuItem(match);
  };

  const observer = new view.MutationObserver(() => {
    for (const [item, menu] of ownedItems) {
      if (!menu.isConnected) removeItem(item);
    }
    if (pending) scheduleScan();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-hidden", "class", "data-state", "hidden", "style"],
  });

  document.addEventListener("contextmenu", handleContextMenu, true);
  document.addEventListener("pointerdown", handlePointerDown, true);
  document.addEventListener("pointerover", handlePointerOver, true);
  document.addEventListener("keydown", handleKeyDown, true);

  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    document.removeEventListener("contextmenu", handleContextMenu, true);
    document.removeEventListener("pointerdown", handlePointerDown, true);
    document.removeEventListener("pointerover", handlePointerOver, true);
    document.removeEventListener("keydown", handleKeyDown, true);
    clearTypeahead();
    clearPending();
    for (const timer of dismissTimers) view.clearTimeout(timer);
    dismissTimers.clear();
    removeOwnedItems();
    itemStyles.remove();
    signal.removeEventListener("abort", cleanup);
  };

  signal.addEventListener("abort", cleanup, { once: true });
  return cleanup;
}
