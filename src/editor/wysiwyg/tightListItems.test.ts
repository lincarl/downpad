// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Editor, defaultValueCtx, editorViewCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { getMarkdown } from "@milkdown/kit/utils";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { toRemarkStringifyOptions } from "./serializer";
import { tightListItemJoin, tightListItemSchema } from "./tightListItems";

let editor: Editor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** An editor with Crepe's presets and md-easy's default Markdown style, then
 *  md-easy's list item schema and join on top, as in WysiwygEditor. The cursor is
 *  placed at the end of the document. */
async function open(markdown: string): Promise<EditorView> {
  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(defaultValueCtx, markdown);
      const style = toRemarkStringifyOptions(serializerStyleFromSettings(DEFAULT_SETTINGS));
      ctx.update(remarkStringifyOptionsCtx, (options) => ({ ...options, ...style }));
    })
    .config(tightListItemJoin)
    .use(commonmark)
    .use(gfm)
    .use(tightListItemSchema)
    .create();
  const view = editor.ctx.get(editorViewCtx);
  view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
  return view;
}

/** The open document as Markdown. */
const currentMarkdown = () => editor?.action(getMarkdown());

/** Type `text` one character at a time, so input rules such as "- " run. */
function type(view: EditorView, text: string): void {
  for (const char of text) {
    const { from, to } = view.state.selection;
    const insert = () => view.state.tr.insertText(char, from, to);
    if (!view.someProp("handleTextInput", (handle) => handle(view, from, to, char, insert))) view.dispatch(insert());
  }
}

/** Press a key through the editor's keymaps. */
function press(view: EditorView, key: string): void {
  view.someProp("handleKeyDown", (handle) => handle(view, new KeyboardEvent("keydown", { key })));
}

/** The position of the first text node that reads `text`. */
function positionOf(view: EditorView, text: string): number {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text === text) found = pos;
  });
  return found;
}

const KEYS = new Set(["Enter", "Backspace", "Tab"]);

/** Press each step that names a key and type every other step. */
function input(view: EditorView, steps: string[]): void {
  for (const step of steps) {
    if (KEYS.has(step)) press(view, step);
    else type(view, step);
  }
}

describe("lists typed in the document view", () => {
  it.each([
    ["a bullet list", "- ", "- A\n  - B\n"],
    ["a numbered list", "1. ", "1. A\n   1. B\n"],
    ["a task list", "- [ ] ", "- [ ] A\n  - [ ] B\n"],
  ])("writes %s with an item nested by Tab without a blank line", async (_name, start, list) => {
    const view = await open("Start.\n");
    press(view, "Enter");
    type(view, `${start}A`);
    press(view, "Enter");
    type(view, "B");
    press(view, "Tab");
    expect(currentMarkdown()).toBe(`Start.\n\n${list}`);
  });

  // The list's own spread, read from the file, keeps the blank lines between items.
  it("keeps a loose list loose when Enter adds an item", async () => {
    const view = await open("- A\n\n- B\n");
    press(view, "Enter");
    type(view, "C");
    expect(currentMarkdown()).toBe("- A\n\n- B\n\n- C\n");
  });
});

describe("blocks in a tight list item", () => {
  it.each([
    // "---" right under text would make the text a heading.
    ["a rule under the item's text", ["- A", "Enter", "Backspace", "---"], "- A\n\n  ---\n"],
    // Text right after a nested list would join its last item.
    ["text after a nested list", ["- A", "Enter", "B", "Tab", "Enter", "Enter", "Backspace", "C"], "- A\n\n  - B\n\n  C\n"],
    // Only a numbered list that starts at 1 can begin right after text.
    ["a numbered list from 2 under the item's text", ["- A", "Enter", "Backspace", "2. B"], "- A\n\n  2. B\n"],
  ])("writes %s with blank lines between the item's blocks", async (_name, steps, list) => {
    const view = await open("Start.\n");
    press(view, "Enter");
    input(view, steps);
    expect(currentMarkdown()).toBe(`Start.\n\n${list}`);
  });

  it("keeps a blank line after an item whose text was deleted", async () => {
    const view = await open("Start.\n");
    press(view, "Enter");
    input(view, ["- A", "Enter", "B", "Tab"]);
    // The emptied item is written as "<br />", which would start an HTML block
    // that takes in the nested list.
    const from = positionOf(view, "A");
    view.dispatch(view.state.tr.delete(from, from + 1));
    expect(currentMarkdown()).toBe("Start.\n\n- <br />\n\n  - B\n");
  });

  it.each([
    ["a quote after a nested list", "- A\n  - B\n  > q\n- C\n"],
    ["a heading after a quote", "- A\n  > q\n  # H\n- B\n"],
    ["a table after the item's text", "- A\n  | a | b |\n  | - | - |\n  | 1 | 2 |\n- B\n"],
  ])("keeps %s one line apart", async (_name, list) => {
    await open(list);
    expect(currentMarkdown()).toBe(list);
  });
});
