// @vitest-environment jsdom
// A press below the document's last block, in the view's bottom padding or
// handed on from the page below the view, puts the caret at the end of the
// document. Crepe keeps an empty line after a last block that is not a
// paragraph or a heading, so the end is that line, where the next key adds a
// paragraph. A Shift+press while the document has focus extends the selection
// there, unless a block or table cells are selected. These tests use the real
// editor, with the view laid out by hand, since jsdom lays nothing out.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import { CellSelection } from "@milkdown/kit/prose/tables";
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

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the document editor on `markdown` and return its view, laid out
 *  600 wide from the top of the page down to 200, with 60 of padding at the
 *  bottom, so its last block ends at 140. */
async function mount(markdown: string): Promise<EditorView> {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange: vi.fn() }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  const view = (editor as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);
  view.dom.getBoundingClientRect = () => ({ top: 0, bottom: 200, left: 0, right: 600, width: 600, height: 200, x: 0, y: 0 }) as DOMRect;
  Object.defineProperty(view.dom, "clientWidth", { configurable: true, value: 600 });
  Object.defineProperty(view.dom, "clientHeight", { configurable: true, value: 200 });
  view.dom.style.paddingBottom = "60px";
  return view;
}

/** Press the view's own element at the height `clientY`, as in its padding,
 *  and return whether the press was taken. ProseMirror's own handling, which
 *  needs a layout, does not see the press. */
function press(view: EditorView, clientY: number, shiftKey = false): boolean {
  const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 300, clientY, shiftKey });
  const stop = (pressed: Event) => pressed.stopImmediatePropagation();
  view.dom.addEventListener("mousedown", stop, { capture: true, once: true });
  view.dom.dispatchEvent(event);
  view.dom.ownerDocument.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  return event.defaultPrevented;
}

/** The position of the first node in `doc` that `test` accepts. */
function find(doc: ProseNode, test: (node: ProseNode) => boolean): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && test(node)) found = pos;
    return found < 0;
  });
  return found;
}

describe("a press below the document's last block", () => {
  it.each([
    ["a paragraph", "Last line.", "paragraph", "Last line."],
    ["a heading", "## Last heading", "heading", "Last heading"],
    ["a list", "- one\n- two", "paragraph", ""],
    ["a task list", "- [ ] one\n- [ ] two", "paragraph", ""],
    ["a quote", "> Quote text.", "paragraph", ""],
    ["a table", "| A | B |\n| --- | --- |\n| x1 | y1 |", "paragraph", ""],
    ["a code block", "```js\nconst a = 1;\n```", "paragraph", ""],
    ["a math block", "$$\nE = mc^2\n$$", "paragraph", ""],
    ["an image on its own line", "![Bar](bar.svg)", "paragraph", ""],
    ["a rule", "---", "paragraph", ""],
  ])("after %s puts the caret at the end of the last line", { timeout: 60_000 }, async (_name, last, type, text) => {
    const view = await mount(`Intro text.\n\n${last}\n`);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
    expect(press(view, 150)).toBe(true);
    const { selection, doc } = view.state;
    expect(selection.empty).toBe(true);
    expect(selection.head).toBe(doc.content.size - 1);
    expect(selection.$head.parent).toBe(doc.lastChild);
    expect(doc.lastChild!.type.name).toBe(type);
    expect(doc.lastChild!.textContent).toBe(text);
    expect(view.hasFocus()).toBe(true);
  });

  it("extends the selection to the end with Shift while the document has focus", { timeout: 60_000 }, async () => {
    const view = await mount("Intro text.\n\nLast line.\n");
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
    expect(press(view, 150, true)).toBe(true);
    expect(view.state.selection.anchor).toBe(3);
    expect(view.state.selection.head).toBe(view.state.doc.content.size - 1);
  });

  const table = "| C | D |\n| --- | --- |\n| c1 | d1 |";
  it.each([
    // A text selection from before the image started in the table's first cell.
    ["an image on its own line", `Intro text.\n\n![Bar](bar.svg)\n\n${table}\n\nLast line.\n`, (doc: ProseNode) => NodeSelection.create(doc, find(doc, (node) => node.type.name === "image-block"))],
    // A text selection from the cell selection's anchor started in d1.
    ["table cells", `Intro text.\n\n${table}\n\nLast line.\n`, (doc: ProseNode) => {
      const cell = (text: string) => doc.resolve(find(doc, (node) => node.type.spec.tableRole === "cell" && node.textContent === text));
      return new CellSelection(cell("c1"), cell("d1"));
    }],
  ])("takes a Shift+press with %s selected as a plain press", { timeout: 60_000 }, async (_name, markdown, select) => {
    const view = await mount(markdown);
    view.focus();
    view.dispatch(view.state.tr.setSelection(select(view.state.doc)));
    expect(press(view, 150, true)).toBe(true);
    const { selection, doc } = view.state;
    expect(selection.empty).toBe(true);
    expect(selection.head).toBe(doc.content.size - 1);
  });

  it("leaves a press beside the last block's text to the browser", { timeout: 60_000 }, async () => {
    const view = await mount("Intro text.\n\nLast line.\n");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
    expect(press(view, 140)).toBe(false);
    expect(view.state.selection.head).toBe(3);
  });
});
