// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppStore } from "./createAppStore";
import {
  installAppShortcuts,
  type AppShortcutActions,
} from "./installAppShortcuts";

const installed: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of installed.splice(0)) cleanup();
  document.body.replaceChildren();
});

function setup(): AppShortcutActions & { printOpen: boolean; findOpen: boolean } {
  type ShortcutHarness = AppShortcutActions & { printOpen: boolean; findOpen: boolean };
  const state: ShortcutHarness = {
    printOpen: false,
    findOpen: false,
    store: createAppStore(),
    isPrintOpen: () => state.printOpen,
    isFindOpen: () => state.findOpen,
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    showFind: vi.fn(),
    focusRecentSearch: vi.fn(),
    save: vi.fn(),
    open: vi.fn(),
    create: vi.fn(),
    print: vi.fn(),
  };
  installed.push(installAppShortcuts(state));
  return state;
}

function keydown(
  key: string,
  init: KeyboardEventInit = {},
  target: EventTarget = window,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe("installAppShortcuts", () => {
  it("routes file and print commands and removes them on cleanup", () => {
    const actions = setup();

    expect(keydown("s").defaultPrevented).toBe(true);
    keydown("s", { shiftKey: true });
    keydown("o");
    keydown("n");
    expect(keydown("p").defaultPrevented).toBe(true);

    expect(actions.save).toHaveBeenNthCalledWith(1, false);
    expect(actions.save).toHaveBeenNthCalledWith(2, true);
    expect(actions.open).toHaveBeenCalledOnce();
    expect(actions.create).toHaveBeenCalledOnce();
    expect(actions.print).toHaveBeenCalledOnce();

    installed.pop()?.();
    keydown("s");
    expect(actions.save).toHaveBeenCalledTimes(2);
  });

  it("routes search to Recent or the editor's find card", () => {
    const actions = setup();
    actions.store.set({ view: "recent" });
    keydown("f");
    expect(actions.focusRecentSearch).toHaveBeenCalledOnce();

    actions.store.set({ view: "wysiwyg", editorLayout: "document" });
    keydown("f");
    keydown("h");
    expect(actions.showFind).toHaveBeenNthCalledWith(1, "find");
    expect(actions.showFind).toHaveBeenNthCalledWith(2, "replace");

    // The raw editor's own keymap listens on its content element, as
    // CodeMirror's search keymap does, and must never see Ctrl+F.
    const raw = document.createElement("div");
    raw.className = "cm-editor";
    const rawInput = document.createElement("textarea");
    const editorKeymap = vi.fn();
    rawInput.addEventListener("keydown", editorKeymap);
    raw.append(rawInput);
    document.body.append(raw);
    expect(keydown("f", {}, rawInput).defaultPrevented).toBe(true);
    expect(actions.showFind).toHaveBeenNthCalledWith(3, "find");
    expect(editorKeymap).not.toHaveBeenCalled();

    actions.store.set({ editorLayout: "markdown" });
    expect(keydown("f").defaultPrevented).toBe(true);
    expect(actions.showFind).toHaveBeenNthCalledWith(4, "find");
  });

  it("does nothing behind an open modal dialog but still blocks browser printing", () => {
    const actions = setup();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.dataset.state = "open";
    document.body.append(dialog);

    keydown("n");
    keydown("f");
    expect(keydown("p").defaultPrevented).toBe(true);
    expect(actions.create).not.toHaveBeenCalled();
    expect(actions.showFind).not.toHaveBeenCalled();
    expect(actions.print).not.toHaveBeenCalled();

    dialog.remove();
    keydown("n");
    expect(actions.create).toHaveBeenCalledOnce();
  });

  it("steps WYSIWYG matches with F3 and yields while print is open", () => {
    const actions = setup();
    actions.findOpen = true;

    keydown("F3", { ctrlKey: false });
    keydown("F3", { ctrlKey: false, shiftKey: true });
    expect(actions.findNext).toHaveBeenCalledOnce();
    expect(actions.findPrevious).toHaveBeenCalledOnce();

    actions.printOpen = true;
    keydown("s");
    keydown("F3", { ctrlKey: false });
    expect(actions.save).not.toHaveBeenCalled();
    expect(actions.findNext).toHaveBeenCalledOnce();
  });
});
