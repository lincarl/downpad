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
import { tightListItemSchema } from "./tightListItems";

let editor: Editor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** An editor with Crepe's presets and md-easy's default Markdown style, then
 *  md-easy's list item schema on top, as in WysiwygEditor. The cursor is placed
 *  at the end of the document. */
async function open(markdown: string): Promise<EditorView> {
  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(defaultValueCtx, markdown);
      const style = toRemarkStringifyOptions(serializerStyleFromSettings(DEFAULT_SETTINGS));
      ctx.update(remarkStringifyOptionsCtx, (options) => ({ ...options, ...style }));
    })
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

  it("keeps a loose list loose when Enter adds an item", async () => {
    const view = await open("- A\n\n- B\n");
    press(view, "Enter");
    type(view, "C");
    expect(currentMarkdown()).toBe("- A\n\n- B\n\n- C\n");
  });
});
