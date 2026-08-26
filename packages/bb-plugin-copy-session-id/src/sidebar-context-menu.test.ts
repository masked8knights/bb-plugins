// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COPY_MENU_LABEL,
  getSessionIdFromTarget,
  mountCopySessionIdContextMenu,
  writeClipboardText,
} from "./sidebar-context-menu";

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
  },
}));

let clipboardWriteText: ReturnType<typeof vi.fn>;

function flushDom(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function makeThreadRow(id = "thread-123"): HTMLAnchorElement {
  const row = document.createElement("a");
  row.href = "#thread";
  row.setAttribute("data-sidebar-thread-shortcut-target", "");
  row.setAttribute("data-sidebar-thread-id", id);
  row.textContent = "A thread";
  document.body.append(row);
  return row;
}

function makeNativeMenu(): HTMLDivElement {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  const item = document.createElement("div");
  item.setAttribute("role", "menuitem");
  item.setAttribute("data-radix-collection-item", "");
  item.setAttribute("tabindex", "-1");
  item.className = "native-menu-item";
  item.textContent = "Rename";
  menu.append(item);
  const separator = document.createElement("div");
  separator.setAttribute("role", "separator");
  separator.className = "native-menu-separator";
  menu.append(separator);
  document.body.append(menu);
  return menu;
}

describe("sidebar context menu", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    toastSuccess.mockReset();
    toastError.mockReset();
    clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
  });

  afterEach(() => {
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
  });

  it("reads the stable thread identifier from a sidebar row", () => {
    const row = makeThreadRow("session-abc");
    const label = document.createElement("span");
    row.append(label);

    expect(getSessionIdFromTarget(label)).toBe("session-abc");
    expect(getSessionIdFromTarget(document.body)).toBeNull();
  });

  it("adds a copy item to the host menu after a thread context-menu event", async () => {
    const controller = new AbortController();
    const cleanup = mountCopySessionIdContextMenu(
      { signal: controller.signal },
      document,
    );
    const row = makeThreadRow("session-abc");
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");

    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 20,
        clientY: 20,
      }),
    );
    menu.innerHTML =
      '<div role="menuitem" data-radix-collection-item tabindex="-1" class="native-menu-item">Rename</div><div role="separator" class="native-menu-separator"></div>';
    document.body.append(menu);
    await flushDom();

    const item = Array.from(
      menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((candidate) => candidate.textContent === COPY_MENU_LABEL);
    expect(item).toBeDefined();
    expect(item?.getAttribute("data-copy-session-id")).toBe("session-abc");
    expect(item?.classList.contains("bb-copy-session-id-menu-item")).toBe(true);
    expect(item?.hasAttribute("data-radix-collection-item")).toBe(true);
    const pluginSeparator = menu.querySelector<HTMLElement>(
      "[data-copy-session-id-separator]",
    );
    expect(pluginSeparator).not.toBeNull();
    expect(pluginSeparator?.nextElementSibling).toBe(item);
    expect(item?.querySelector("svg")).toBeNull();
    expect(
      document.querySelector("style[data-copy-session-id-styles]")?.textContent,
    ).toContain("[data-copy-session-id-item]:hover");

    const nativeItem = menu.querySelector<HTMLElement>(".native-menu-item");
    nativeItem?.setAttribute("data-last-hovered", "");
    item?.dispatchEvent(new Event("pointerover", { bubbles: true }));
    expect(item?.getAttribute("data-last-hovered")).toBe("");
    expect(nativeItem?.hasAttribute("data-last-hovered")).toBe(false);
    nativeItem?.dispatchEvent(new Event("pointerover", { bubbles: true }));
    expect(item?.hasAttribute("data-last-hovered")).toBe(false);

    nativeItem?.focus();
    const arrowDown = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    nativeItem?.dispatchEvent(arrowDown);
    expect(arrowDown.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(item);

    const home = new KeyboardEvent("keydown", {
      key: "Home",
      bubbles: true,
      cancelable: true,
    });
    item?.dispatchEvent(home);
    expect(home.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(nativeItem);

    const typeahead = new KeyboardEvent("keydown", {
      key: "c",
      bubbles: true,
      cancelable: true,
    });
    nativeItem?.dispatchEvent(typeahead);
    expect(typeahead.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(item);

    nativeItem?.focus();
    const modifiedArrowDown = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
      shiftKey: true,
    });
    nativeItem?.dispatchEvent(modifiedArrowDown);
    expect(modifiedArrowDown.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(nativeItem);

    const shiftedTypeahead = new KeyboardEvent("keydown", {
      key: "C",
      bubbles: true,
      cancelable: true,
      shiftKey: true,
    });
    nativeItem?.dispatchEvent(shiftedTypeahead);
    expect(shiftedTypeahead.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(item);

    item?.dispatchEvent(new Event("pointerover", { bubbles: true }));
    item?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(item?.hasAttribute("data-last-hovered")).toBe(false);

    item?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flushDom();

    expect(clipboardWriteText).toHaveBeenCalledWith("session-abc");
    expect(toastSuccess).toHaveBeenCalledWith("Session ID copied to clipboard");
    cleanup();
  });

  it("updates a reused host menu for the newly selected row", async () => {
    const controller = new AbortController();
    const cleanup = mountCopySessionIdContextMenu(
      { signal: controller.signal },
      document,
    );
    const menu = makeNativeMenu();
    const firstRow = makeThreadRow("first");
    firstRow.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 10,
        clientY: 10,
      }),
    );
    await flushDom();

    const firstItem = menu.querySelector<HTMLElement>(
      "[data-copy-session-id-item]",
    );
    expect(firstItem?.getAttribute("data-copy-session-id")).toBe("first");

    const secondRow = makeThreadRow("second");
    secondRow.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 10,
        clientY: 10,
      }),
    );
    await flushDom();

    const secondItem = menu.querySelector<HTMLElement>(
      "[data-copy-session-id-item]",
    );
    expect(secondItem?.getAttribute("data-copy-session-id")).toBe("second");
    cleanup();
  });

  it("removes plugin-owned menu items on abort", async () => {
    const controller = new AbortController();
    mountCopySessionIdContextMenu({ signal: controller.signal }, document);
    const row = makeThreadRow();
    const menu = makeNativeMenu();
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await flushDom();

    expect(menu.querySelector("[data-copy-session-id-item]")).not.toBeNull();
    controller.abort();
    expect(menu.querySelector("[data-copy-session-id-item]")).toBeNull();
    expect(document.querySelector("style[data-copy-session-id-styles]")).toBeNull();
  });

  it("ignores clipboard completion after the plugin is aborted", async () => {
    let resolveClipboard!: () => void;
    clipboardWriteText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClipboard = resolve;
        }),
    );
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    const controller = new AbortController();
    mountCopySessionIdContextMenu({ signal: controller.signal }, document);
    const row = makeThreadRow("session-pending");
    const menu = makeNativeMenu();
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await flushDom();

    const item = menu.querySelector<HTMLElement>("[data-copy-session-id-item]");
    const menuKeydown = vi.fn();
    menu.addEventListener("keydown", menuKeydown);
    item?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();

    controller.abort();
    resolveClipboard();
    await Promise.resolve();
    await flushDom();

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(menuKeydown).not.toHaveBeenCalled();
  });

  it("uses the clipboard API and preserves a fallback for older clients", async () => {
    await writeClipboardText("session-xyz", document);
    expect(clipboardWriteText).toHaveBeenCalledWith("session-xyz");

    clipboardWriteText.mockRejectedValueOnce(new Error("permission denied"));
    document.execCommand = vi.fn().mockReturnValue(true);
    await writeClipboardText("session-fallback", document);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });
});
