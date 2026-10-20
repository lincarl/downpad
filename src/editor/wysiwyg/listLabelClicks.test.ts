// @vitest-environment jsdom
// A press on a list item's bullet or number puts the caret at the start of
// the item's text, and a Shift+press while the document has focus extends the
// selection to there. A task's box is Crepe's. These tests press the labels of
// the real editor.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";

// Crepe's code block view watches whether it is on screen, which jsdom cannot tell.
vi.stubGlobal("IntersectionObserver", class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});
// jsdom lays nothing out, so ProseMirror finds no position under a press it
// handles, as on a task's box.
document.elementFromPoint = () => null;

const markdown = "Intro.\n\n- one\n- two\n\n1. first\n\n- [ ] task\n\nLast line.\n";

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the document editor and return its view once the list item views
 *  have put back the selection they saw, a frame after they are drawn. */
async function open(): Promise<EditorView> {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange: () => {} }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  await new Promise((resolve) => requestAnimationFrame(resolve));
  return (editor as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);
}

/** The position at the start of the paragraph that reads `text`. */
function textStart(view: EditorView, text: string): number {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isTextblock && node.textContent === text) found = pos + 1;
  });
  return found;
}

/** Press and release the label of the list item that reads `text`, and
 *  return whether the press was cancelled. */
function pressLabel(view: EditorView, text: string, shiftKey = false): boolean {
  const item = [...view.dom.querySelectorAll(".milkdown-list-item-block")].find((element) => element.querySelector("p")?.textContent === text)!;
  const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey });
  item.querySelector(".label-wrapper")!.dispatchEvent(event);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  return event.defaultPrevented;
}

describe("listLabelClicks", () => {
  it("puts the caret at the start of the item's text for a press on a bullet or number", async () => {
    const view = await open();
    expect(pressLabel(view, "two")).toBe(true);
    expect(view.state.selection.toJSON()).toEqual({ type: "text", anchor: textStart(view, "two"), head: textStart(view, "two") });
    expect(pressLabel(view, "first")).toBe(true);
    expect(view.state.selection.toJSON()).toEqual({ type: "text", anchor: textStart(view, "first"), head: textStart(view, "first") });
  });

  it("extends the selection to the start of the item's text on a Shift+press while the view has focus", async () => {
    const view = await open();
    const anchor = textStart(view, "Last line.") + 4;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor)));
    view.focus();
    expect(view.hasFocus()).toBe(true);
    expect(pressLabel(view, "one", true)).toBe(true);
    expect(view.state.selection.toJSON()).toEqual({ type: "text", anchor, head: textStart(view, "one") });
  });

  it("leaves a press on a task's box to Crepe", async () => {
    const view = await open();
    const before = view.state.selection;
    expect(pressLabel(view, "task")).toBe(false);
    expect(view.state.selection.eq(before)).toBe(true);
  });
});
