// @vitest-environment jsdom
// Crepe's slash menu in the real document editor. While open it reads Enter
// and the arrow keys from the whole window, so it closes when focus leaves the
// document.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";

// jsdom has no layout, and Crepe's virtual cursor and menu measure the caret.
Object.assign(Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() });

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the document editor before a button, type "/" on its second line, and
 *  wait for the slash menu. */
async function openMenu() {
  const root = document.createElement("div");
  const after = document.createElement("button");
  document.body.append(root, after);
  editor = new WysiwygEditor();
  await editor.mount(root, "First line.\n\nSecond line.\n", { onChange: () => {} }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  const view: EditorView = (editor as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);
  const end = view.state.doc.content.size - 1;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
  view.focus();
  view.dispatch(view.state.tr.insertText("/", end - "Second line.".length, end));
  // Crepe adds the menu once the typing pauses.
  const menu = await vi.waitFor(() => {
    const found = root.querySelector<HTMLElement>('.milkdown-slash-menu[data-show="true"]');
    if (!found) throw new Error("The slash menu is not open");
    return found;
  });
  return { view, menu, after };
}

/** Press Enter on `target`. Returns whether a handler kept the browser from acting on it. */
const pressEnter = (target: Element) =>
  !target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

describe("the slash menu in the document editor", () => {
  it("closes when focus leaves the document, and leaves Enter to the control that has it", { timeout: 60_000 }, async () => {
    const { view, menu, after } = await openMenu();
    // When the window loses focus, the editor stays the active element and
    // takes focus back with the window.
    view.dom.dispatchEvent(new FocusEvent("blur"));
    expect(menu.dataset.show).toBe("true");
    // Crepe's menu takes no focus, but focus that moves into it keeps it open.
    const item = menu.querySelector<HTMLElement>("li[data-index]")!;
    item.tabIndex = -1;
    item.focus();
    expect(menu.dataset.show).toBe("true");

    view.focus();
    after.focus();
    expect(menu.dataset.show).toBe("false");
    // The menu stops reading keys before the next one arrives.
    await new Promise((resolve) => setTimeout(resolve));
    expect(pressEnter(after)).toBe(false);
  });
});
