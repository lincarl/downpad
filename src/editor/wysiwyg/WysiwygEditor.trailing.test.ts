// @vitest-environment jsdom
// Crepe keeps an empty paragraph after a final list, code block, quote, table,
// rule or image so there is a line to type on. These tests use the real editor
// to check that this line never reaches the Markdown or the undo history.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { undo, undoDepth } from "@milkdown/kit/prose/history";
import { TextSelection } from "@milkdown/kit/prose/state";
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
  vi.useRealTimers();
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the document editor on `markdown`, recording its change reports. The
 *  timers and animation frames are fake from before the mount, so Crepe's first
 *  frame runs on the fake clock. Faked after the mount, it would never run. */
async function open(markdown: string): Promise<{ editor: WysiwygEditor; onChange: ReturnType<typeof vi.fn> }> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  const root = document.createElement("div");
  document.body.append(root);
  const onChange = vi.fn();
  editor = new WysiwygEditor();
  const mounting = editor.mount(root, markdown, { onChange }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  let settled = false;
  void mounting.then(() => (settled = true), () => (settled = true));
  while (!settled) await vi.advanceTimersByTimeAsync(1);
  await mounting;
  return { editor, onChange };
}

/** Wait past a list's first frame and the 200ms change report. */
const settle = () => vi.advanceTimersByTimeAsync(300);

/** The editor's ProseMirror view, for undo checks the public API cannot make. */
const viewOf = (opened: WysiwygEditor) =>
  (opened as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);

/** The reported Markdown that differs from `markdown`. */
const differing = (onChange: ReturnType<typeof vi.fn>, markdown: string) =>
  onChange.mock.calls.map(([reported]) => reported as string).filter((reported) => reported !== markdown);

describe("the empty line Crepe keeps at the end", () => {
  it.each([
    // The editor adds the line while it opens.
    ["a list", "First line.\n\n- Last item\n"],
    ["a code block", "First line.\n\n```js\nlet x = 1;\n```\n"],
    // The heading id update adds it while the editor opens.
    ["a quote after a heading", "# Notes\n\nFirst line.\n\n> Quote\n"],
    // A rule or image has no content either, but it is not an empty line.
    ["a rule", "First line.\n\n---\n"],
    ["a standalone image", "First line.\n\n![Alt](picture.png)\n"],
    // An empty line inside the list keeps its <br /> form.
    ["a list that ends in an empty line", "- A\n\n  <br />\n"],
    // An empty line between paragraphs is not the end of the document.
    ["paragraphs around an empty line", "Hello\n\n<br />\n\nWorld\n"],
  ])("leaves the Markdown of a file that ends in %s unchanged", { timeout: 60_000 }, async (_name, markdown) => {
    const { editor, onChange } = await open(markdown);
    expect(editor.getMarkdown()).toBe(markdown);
    await settle();
    editor.clearSearch();
    await settle();
    expect(editor.getMarkdown()).toBe(markdown);
    expect(differing(onChange, markdown)).toEqual([]);
  });

  it("drops only the last of two empty lines at the end of an edited file", { timeout: 60_000 }, async () => {
    const { editor } = await open("Hello\n\n<br />\n\n<br />\n");
    // An unedited file keeps its exact text, so edit it first.
    const options = { caseSensitive: true, wholeWord: false, regex: false };
    editor.search("Hello", options);
    editor.replaceAll("Hi", "Hello", options);
    expect(editor.getMarkdown()).toBe("Hi\n\n<br />\n");
  });

  it("mirrors a split edit that ends in a list without an extra blank line", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open("Start.\n");
    await settle();
    editor.setMarkdown("First line.\n\n- Last item\n");
    expect(editor.getMarkdown()).toBe("First line.\n\n- Last item\n");
    await settle();
    expect(differing(onChange, "First line.\n\n- Last item\n")).toEqual([]);
  });
});

describe("undo right after opening", () => {
  it.each([
    // Crepe's list view sets the selection a frame after the list is drawn.
    ["a list", "First line.\n\n- Last item\n"],
    // A code block has no such frame, so the click is the first change.
    ["a code block", "First line.\n\n```js\nlet x = 1;\n```\n"],
  ])("has nothing to undo in a file that ends in %s", { timeout: 60_000 }, async (_name, markdown) => {
    const { editor, onChange } = await open(markdown);
    const view = viewOf(editor);
    await settle();
    // Click at the end of the first line.
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 12)));
    await settle();
    // Ctrl+Z changes nothing and leaves the caret where the click put it.
    expect(undo(view.state, view.dispatch)).toBe(false);
    expect(view.state.selection.from).toBe(12);
    // The empty line is not an edit to report.
    expect(onChange).not.toHaveBeenCalled();

    // The first edit undoes in one step.
    const opened = view.state.doc;
    view.dispatch(view.state.tr.insertText("X"));
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.eq(opened)).toBe(true);
    expect(undoDepth(view.state)).toBe(0);
  });
});

describe("change reports", () => {
  it("skip a list label fix that follows a selection change", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open("1. a\n2. b\n\nEnd.\n");
    const view = viewOf(editor);
    await settle();
    // A paste can leave a stale label. The label sync skips the paste and
    // fixes the label in the next plain transaction.
    view.dispatch(view.state.tr.setNodeAttribute(1, "label", "7.").setMeta("uiEvent", "paste"));
    await settle();
    expect(view.state.doc.nodeAt(1)?.attrs.label).toBe("7.");
    onChange.mockClear();

    // An arrow key gets the label fix, which is kept out of undo history.
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    await settle();
    expect(view.state.doc.nodeAt(1)?.attrs.label).toBe("1.");
    expect(onChange).not.toHaveBeenCalled();
  });
});
