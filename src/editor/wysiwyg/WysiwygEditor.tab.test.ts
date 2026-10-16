// @vitest-environment jsdom
// Tab in the document view. Lists, tables and code blocks keep their Tab keys,
// any other Tab moves focus out of the document, and Esc then Tab leaves from
// anywhere. These tests use the real editor between two buttons.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";

// Crepe starts a code block's editor once the block is on screen, which jsdom
// cannot tell. Report every block as on screen.
type Report = (entries: Pick<IntersectionObserverEntry, "target" | "isIntersecting">[]) => void;
vi.stubGlobal("IntersectionObserver", class {
  report: Report;
  constructor(report: Report) {
    this.report = report;
  }
  observe(target: Element): void {
    setTimeout(() => this.report([{ target, isIntersecting: true }]));
  }
  unobserve(): void {}
  disconnect(): void {}
});
// jsdom has no layout, and Crepe's virtual cursor measures the caret.
Object.assign(Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() });

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the document editor on `markdown` between a button before and after it. */
async function open(markdown: string) {
  const before = document.createElement("button");
  const root = document.createElement("div");
  const after = document.createElement("button");
  document.body.append(before, root, after);
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange: () => {} }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  const view: EditorView = (editor as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);
  return { editor, view, before, after };
}

/** Put the caret `offset` characters into the first text that contains `text`, and focus the editor. */
function place(view: EditorView, text: string, offset = 0): void {
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text?.includes(text)) at = pos + node.text.indexOf(text) + offset;
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
  view.focus();
}

/** Type `text` at the caret, so the Markdown comes from the editor and not the opened file. */
function type(view: EditorView, text: string): void {
  view.dispatch(view.state.tr.insertText(text));
}

/** Press `key` on `target` with a keydown that bubbles, as the browser does.
 *  Returns whether a handler kept the browser from acting on the key. */
function press(target: Element, key: string, shiftKey = false): boolean {
  return !target.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
}

/** The text of the table cell that holds the caret. */
const cellText = (view: EditorView) => view.state.selection.$from.parent.textContent;

describe("Tab in the document view", () => {
  it("moves focus out of a paragraph without typing spaces", { timeout: 60_000 }, async () => {
    const { editor, view, before, after } = await open("First line.\n\nSecond line.\n");
    place(view, "First line.", "First line.".length);
    type(view, " Edited.");
    press(view.dom, "Tab");
    expect(document.activeElement).toBe(after);
    place(view, "First line.", 0);
    press(view.dom, "Tab", true);
    expect(document.activeElement).toBe(before);
    expect(editor.getMarkdown()).toBe("First line. Edited.\n\nSecond line.\n");
  });

  it("still nests a list item and moves between table cells", { timeout: 60_000 }, async () => {
    const { editor, view, after } = await open("- One\n- Two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
    place(view, "Two", 1);
    press(view.dom, "Tab");
    expect(editor.getMarkdown()).toMatch(/^- One\n\n? {2}- Two\n/);
    place(view, "1");
    press(view.dom, "Tab");
    expect(cellText(view)).toBe("2");
    press(view.dom, "Tab", true);
    expect(cellText(view)).toBe("1");
    expect(document.activeElement).not.toBe(after);
  });

  it("stays on the first list item and the last table cell", { timeout: 60_000 }, async () => {
    const { editor, view } = await open("- One\n- Two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
    place(view, "Two", 3);
    type(view, " edited");
    // The keys are used up, so the browser does not move focus to a control
    // inside the document either. Leaving would use them up too, so check
    // focus after each key, before `place` focuses the editor again.
    place(view, "One", 3);
    expect(press(view.dom, "Tab")).toBe(true);
    expect(document.activeElement).toBe(view.dom);
    place(view, "2", 1);
    expect(press(view.dom, "Tab")).toBe(true);
    expect(document.activeElement).toBe(view.dom);
    expect(cellText(view)).toBe("2");
    place(view, "a");
    expect(press(view.dom, "Tab", true)).toBe(true);
    expect(document.activeElement).toBe(view.dom);
    expect(cellText(view)).toBe("a");
    expect(editor.getMarkdown()).toBe("- One\n- Two edited\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
  });

  it("leaves a list item after Esc, but only within 2 seconds", { timeout: 60_000 }, async () => {
    const { editor, view, before, after } = await open("- One\n- Two\n");
    place(view, "Two", 3);
    type(view, " edited");
    press(view.dom, "Escape");
    press(view.dom, "Tab");
    expect(document.activeElement).toBe(after);
    place(view, "Two", 1);
    press(view.dom, "Escape");
    press(view.dom, "Shift", true);
    press(view.dom, "Tab", true);
    expect(document.activeElement).toBe(before);
    expect(editor.getMarkdown()).toBe("- One\n- Two edited\n");
    // Another key, or a longer pause, ends the Esc window and Tab nests the item.
    place(view, "Two", 1);
    press(view.dom, "Escape");
    press(view.dom, "ArrowLeft");
    press(view.dom, "Tab");
    expect(editor.getMarkdown()).toMatch(/^- One\n\n? {2}- Two edited\n$/);
    press(view.dom, "Tab", true);
    const now = Date.now();
    press(view.dom, "Escape");
    vi.spyOn(Date, "now").mockReturnValue(now + 2_500);
    press(view.dom, "Tab");
    expect(editor.getMarkdown()).toMatch(/^- One\n\n? {2}- Two edited\n$/);
    expect([before, after]).not.toContain(document.activeElement);
  });

  it("stays while the slash menu is open, and leaves after Esc closes it", { timeout: 60_000 }, async () => {
    const { view, after } = await open("First line.\n\nSecond line.\n");
    // Replace the second line with "/", with the caret after it.
    place(view, "Second line.", "Second line.".length);
    const end = view.state.selection.from;
    view.dispatch(view.state.tr.insertText("/", end - "Second line.".length, end));
    const menu = () => view.dom.parentElement?.querySelector<HTMLElement>(".milkdown-slash-menu")?.dataset.show;
    await vi.waitFor(() => expect(menu()).toBe("true"));
    expect(press(view.dom, "Tab")).toBe(true);
    expect(document.activeElement).not.toBe(after);
    press(view.dom, "Escape");
    expect(menu()).toBe("false");
    press(view.dom, "Tab");
    expect(document.activeElement).toBe(after);
  });

  it("still indents code on Tab, and leaves a code block through its buttons after Esc", { timeout: 60_000 }, async () => {
    const { editor, view, before, after } = await open("Intro.\n\n```js\nlet x = 1;\n```\n");
    const code = await vi.waitFor(() => {
      const found = view.dom.querySelector<HTMLElement>(".cm-content");
      if (!found) throw new Error("The code block has no editor yet");
      return found;
    });
    // The code block passes its edits on to the document only while focused.
    code.focus();
    press(code, "Tab");
    expect(editor.getMarkdown()).toBe("Intro.\n\n```js\n  let x = 1;\n```\n");
    // Esc then Tab reaches the block's language and Copy buttons before leaving.
    const language = view.dom.querySelector<HTMLElement>(".milkdown-code-block .language-button")!;
    const copy = view.dom.querySelector<HTMLElement>(".milkdown-code-block .tools-button-group > button")!;
    press(code, "Escape");
    press(code, "Tab");
    expect(document.activeElement).toBe(language);
    press(language, "Tab");
    expect(document.activeElement).toBe(copy);
    press(copy, "Tab");
    expect(document.activeElement).toBe(after);
    // Shift+Tab goes back from the buttons into the code, and out before the document.
    language.focus();
    press(language, "Tab", true);
    expect(document.activeElement).toBe(code);
    press(code, "Escape");
    press(code, "Tab", true);
    expect(document.activeElement).toBe(before);
    expect(editor.getMarkdown()).toBe("Intro.\n\n```js\n  let x = 1;\n```\n");
  });
});
