// @vitest-environment jsdom
// Replace and Insert link in the document view, with the real editor. Replace
// moves on to the next match, and an autolink's target follows its text.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { undo, undoDepth } from "@milkdown/kit/prose/history";
import { TextSelection } from "@milkdown/kit/prose/state";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";
import type { FindOptions } from "./findEngine";

// Crepe's code block view watches whether it is on screen, which jsdom cannot tell.
vi.stubGlobal("IntersectionObserver", class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});

const opts: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the document editor on `markdown`. */
async function open(markdown: string): Promise<WysiwygEditor> {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange: () => {} }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  return editor;
}

/** The text of the block that holds the current match. */
const currentBlock = () => document.querySelector(".md-find-current")?.closest("p, h1")?.textContent;

describe("replace in the document view", () => {
  it("moves on to the next match after Replace", { timeout: 60_000 }, async () => {
    const editor = await open("# Heading alpha\n\nalpha one\n\nalpha two\n\nalpha three\n");
    expect(editor.search("alpha", opts)).toEqual({ current: 1, total: 4 });
    editor.findNext();
    expect(editor.findNext()).toEqual({ current: 3, total: 4 });

    expect(editor.replaceCurrent("BETA", "alpha", opts)).toEqual({ current: 3, total: 3 });
    expect(currentBlock()).toBe("alpha three");
    expect(editor.getMarkdown()).toBe("# Heading alpha\n\nalpha one\n\nBETA two\n\nalpha three\n");

    // After the last match it wraps to the first.
    expect(editor.replaceCurrent("BETA", "alpha", opts)).toEqual({ current: 1, total: 2 });
    expect(currentBlock()).toBe("Heading alpha");
  });

  it("skips a replacement that contains the query", { timeout: 60_000 }, async () => {
    const editor = await open("cat one\n\ncat two\n");
    editor.search("cat", opts);
    expect(editor.replaceCurrent("cats", "cat", opts)).toEqual({ current: 2, total: 2 });
    expect(currentBlock()).toBe("cat two");
  });

  it("changes an autolink's target along with its text", { timeout: 60_000 }, async () => {
    const editor = await open(
      "Mail <support@example.com> or see <https://example.com/example> and www.example.net.\n\n" +
        "Read [the example guide](https://example.com/guide) or [https://example.com](https://mirror.org).\n\n" +
        "Open [example.md](example.md), [#example](#example) or [example.com](http://example.com).\n",
    );
    expect(editor.search("example", opts)).toEqual({ current: 1, total: 9 });
    editor.replaceCurrent("sample", "example", opts);
    editor.replaceAll("sample", "example", opts);
    // Explicit links keep their target, even when it repeats their text.
    expect(editor.getMarkdown()).toBe(
      "Mail <support@sample.com> or see <https://sample.com/sample> and [www.sample.net](http://www.sample.net).\n\n" +
        "Read [the sample guide](https://example.com/guide) or [https://sample.com](https://mirror.org).\n\n" +
        "Open [sample.md](example.md), [#sample](#example) or [sample.com](http://example.com).\n",
    );
  });
});

describe("Insert link in the document view", () => {
  it("links the selected text in one undo step, and does nothing without a selection", { timeout: 60_000 }, async () => {
    const editor = await open("See docs here.\n");
    const view = (editor as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5)));
    expect(editor.insertLink("https://example.com")).toBe(false);
    expect(editor.getMarkdown()).toBe("See docs here.\n");

    // Select "docs".
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5, 9)));
    expect(editor.insertLink("https://example.com")).toBe(true);
    expect(editor.getMarkdown()).toBe("See [docs](https://example.com) here.\n");
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe("See docs here.\n");
    expect(undoDepth(view.state)).toBe(0);
  });
});
