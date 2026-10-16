// @vitest-environment jsdom
// An edit in the document view rewrites only the top-level blocks it changed.
// Every other block keeps the file's text. These tests use the real editor and
// edit it the way commands do, with ProseMirror transactions.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx, remarkCtx, serializerCtx } from "@milkdown/kit/core";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { closeHistory, undo } from "@milkdown/kit/prose/history";
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

/** Mount the document editor on `markdown`, recording its change reports. */
async function open(markdown: string): Promise<{ editor: WysiwygEditor; view: EditorView; onChange: ReturnType<typeof vi.fn> }> {
  const root = document.createElement("div");
  document.body.append(root);
  const onChange = vi.fn();
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  return { editor, view: crepeOf(editor).editor.ctx.get(editorViewCtx), onChange };
}

/** The editor's Crepe, for edits and checks the public API cannot make. */
const crepeOf = (opened: WysiwygEditor) => (opened as unknown as { crepe: Crepe }).crepe;

/** Wait past a list's first frame and the 200ms change report. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** The position just after the first `text` in the document. */
function after(view: EditorView, text: string): number {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    const at = node.isText ? (node.text ?? "").indexOf(text) : -1;
    if (found < 0 && at >= 0) found = pos + at + text.length;
  });
  if (found < 0) throw new Error(`"${text}" is not in the document`);
  return found;
}

/** Type `text` right after the first `anchor` in the document. */
function typeAfter(view: EditorView, anchor: string, text: string): void {
  view.dispatch(view.state.tr.insertText(text, after(view, anchor)));
}

/** The range of the top-level block that holds `text`. */
function blockWith(view: EditorView, text: string): { from: number; to: number; node: ProseNode } {
  const pos = after(view, text);
  const $pos = view.state.doc.resolve(pos);
  return { from: $pos.before(1), to: $pos.after(1), node: $pos.node(1) };
}

/** Delete the top-level block that holds `text`. */
function deleteBlock(view: EditorView, text: string): void {
  const { from, to } = blockWith(view, text);
  view.dispatch(view.state.tr.delete(from, to));
}

// A file with much that Milkdown writes in its own way: a setext heading, a
// closed ATX heading, reference links and their definitions, a list numbered
// with ")" and one with "*", an aligned table, a two-space line break,
// character references and escapes, indented and "~~~" code, a "***" rule and
// two blank lines between blocks.
const DOC = [
  "Release notes",
  "=============",
  "",
  "This release makes sync faster.",
  "See the [changelog][log] and the [FAQ].",
  "",
  "",
  "## Steps ##",
  "",
  "1) Back up the data",
  "2) Install the update",
  "",
  "* Restart the server",
  "* Check the logs",
  "",
  "| Feature | Status |",
  "|:--------|-------:|",
  "| Sync    | Done   |",
  "",
  "Line one with two spaces  ",
  "line two, &copy; 2026 &amp; \\[not a link\\].",
  "",
  "    indented code",
  "",
  "~~~",
  "fenced with tildes",
  "~~~",
  "",
  "***",
  "",
  "Edit this line.",
  "",
  '[log]: https://example.com/changelog "Changelog"',
  "[FAQ]: https://example.com/faq",
  "",
].join("\n");

describe("an edit in the document view", () => {
  it("rewrites only the paragraph it changed", { timeout: 60_000 }, async () => {
    const { editor, view, onChange } = await open(DOC);
    typeAfter(view, "Edit this", " one");
    const edited = DOC.replace("Edit this line.", "Edit this one line.");
    expect(editor.getMarkdown()).toBe(edited);
    await settle();
    expect(onChange.mock.lastCall?.[0]).toBe(edited);
  });

  it("rewrites a changed list or table as a whole", { timeout: 60_000 }, async () => {
    const { editor, view } = await open(DOC);
    typeAfter(view, "Check the logs", " twice");
    expect(editor.getMarkdown()).toBe(
      DOC.replace("* Restart the server\n* Check the logs\n", "- Restart the server\n- Check the logs twice\n"),
    );
    typeAfter(view, "Done", "!");
    expect(editor.getMarkdown()).toBe(
      DOC.replace("* Restart the server\n* Check the logs\n", "- Restart the server\n- Check the logs twice\n").replace(
        "| Feature | Status |\n|:--------|-------:|\n| Sync    | Done   |\n",
        "| Feature | Status |\n| :------ | -----: |\n| Sync    |  Done! |\n",
      ),
    );
  });

  it("keeps the line breaks and indent around a changed block", { timeout: 60_000 }, async () => {
    const markdown = "Steps:\n- one\n- two\n\n\n\nAfter.\n\n  ```\n  code\n    more\n  ```\n";
    const { editor, view } = await open(markdown);
    typeAfter(view, "Steps", " to take");
    typeAfter(view, "After", " that");
    expect(editor.getMarkdown()).toBe("Steps to take:\n- one\n- two\n\n\n\nAfter that.\n\n  ```\n  code\n    more\n  ```\n");
  });

  it("adds a blank line where the file's own line break would join two blocks", { timeout: 60_000 }, async () => {
    const { editor, view } = await open("# Title\n---\n\nText.\n");
    // As a paragraph, the title would read as a setext heading right above "---".
    const { from, to } = blockWith(view, "Title");
    view.dispatch(view.state.tr.setBlockType(from, to, view.state.schema.nodes.paragraph));
    expect(editor.getMarkdown()).toBe("Title\n\n---\n\nText.\n");
  });

  it("writes split and joined paragraphs in Milkdown's form", { timeout: 60_000 }, async () => {
    const markdown = "Alpha beta.\n\n\nSecond  \nline.\n\n* Item\n";
    const { editor, view } = await open(markdown);
    const space = after(view, "Alpha");
    view.dispatch(view.state.tr.delete(space, space + 1).split(space));
    expect(editor.getMarkdown()).toBe("Alpha\n\nbeta.\n\n\nSecond  \nline.\n\n* Item\n");
    view.dispatch(view.state.tr.join(blockWith(view, "Second").from));
    expect(editor.getMarkdown()).toBe("Alpha\n\nbeta.Second\\\nline.\n\n* Item\n");
  });

  it("leaves out a deleted block and keeps the definitions after it", { timeout: 60_000 }, async () => {
    const markdown = "Intro.\n\n\nGone soon.\n\nSee [it][r].\n\n[r]: https://r.example\n";
    const { editor, view } = await open(markdown);
    deleteBlock(view, "Gone soon.");
    expect(editor.getMarkdown()).toBe("Intro.\n\n\nSee [it][r].\n\n[r]: https://r.example\n");
    deleteBlock(view, "See");
    expect(editor.getMarkdown()).toBe("Intro.\n\n\n[r]: https://r.example\n");
  });

  it("keeps the definitions a changed paragraph used, and its links inline", { timeout: 60_000 }, async () => {
    const markdown = 'See [docs][d] and [faq].\n\nOther [docs][d].\n\n[d]: https://x.y "Docs"\n[faq]: https://f.y\n';
    const { editor, view } = await open(markdown);
    typeAfter(view, "See", " the");
    expect(editor.getMarkdown()).toBe(
      'See the [docs](https://x.y "Docs") and [faq](https://f.y).\n\nOther [docs][d].\n\n[d]: https://x.y "Docs"\n[faq]: https://f.y\n',
    );
  });

  it("keeps a definition above a changed block in its place", { timeout: 60_000 }, async () => {
    const { editor, view } = await open("One [a][x].\n\n[x]: https://x.y\n\nTwo.\n\nThree.\n");
    typeAfter(view, "Two", " now");
    expect(editor.getMarkdown()).toBe("One [a][x].\n\n[x]: https://x.y\n\nTwo now.\n\nThree.\n");
  });

  it("keeps the frontmatter and the unchanged body", { timeout: 60_000 }, async () => {
    const markdown = "---\ntitle: x\n---\n\nTitle\n=====\n\nBody text.\n\n| a |\n|---|\n| 1 |\n";
    const { editor, view } = await open(markdown);
    typeAfter(view, "Body text", " here");
    expect(editor.getMarkdown()).toBe("---\ntitle: x\n---\n\nTitle\n=====\n\nBody text here.\n\n| a |\n|---|\n| 1 |\n");
  });

  it("restores the file's text block by block on undo", { timeout: 60_000 }, async () => {
    const { editor, view } = await open(DOC);
    typeAfter(view, "Edit this", " one");
    view.dispatch(closeHistory(view.state.tr));
    typeAfter(view, "Back up", " all");
    expect(editor.getMarkdown()).toBe(
      DOC.replace("Edit this line.", "Edit this one line.").replace(
        "1) Back up the data\n2) Install the update\n",
        "1. Back up all the data\n2. Install the update\n",
      ),
    );
    undo(view.state, view.dispatch);
    expect(editor.getMarkdown()).toBe(DOC.replace("Edit this line.", "Edit this one line."));
    undo(view.state, view.dispatch);
    expect(editor.getMarkdown()).toBe(DOC);
  });

  it("keeps the text the split mirror set for the blocks an edit leaves alone", { timeout: 60_000 }, async () => {
    const { editor, view } = await open("Start.\n");
    editor.setMarkdown(DOC);
    expect(editor.getMarkdown()).toBe(DOC);
    typeAfter(view, "Edit this", " one");
    expect(editor.getMarkdown()).toBe(DOC.replace("Edit this line.", "Edit this one line."));
  });

  it("writes only the blocks an edit changed in a long file", { timeout: 60_000 }, async () => {
    const sections = Array.from({ length: 150 }, (_, i) => `Section ${i}\n----------\n\n* Point ${i}\n\nText ${i}  \nmore.\n`);
    const markdown = sections.join("\n");
    const { editor, view } = await open("Start.\n");
    // Count what the editor writes and reads from here on.
    const crepe = crepeOf(editor);
    const serialize = crepe.editor.ctx.get(serializerCtx);
    const written: number[] = [];
    crepe.editor.ctx.set(serializerCtx, (doc: ProseNode) => {
      written.push(doc.childCount);
      return serialize(doc);
    });
    const parse = vi.spyOn(crepe.editor.ctx.get(remarkCtx), "parse");
    editor.setMarkdown(markdown);
    expect(view.state.doc.childCount).toBeGreaterThanOrEqual(450);
    expect(editor.getMarkdown()).toBe(markdown);

    typeAfter(view, "Text 75", "!");
    expect(editor.getMarkdown()).toBe(markdown.replace("Text 75  \n", "Text 75!\\\n"));
    written.length = 0;
    parse.mockClear();
    // Later edits write the block they change, and read back only the joins
    // around it.
    typeAfter(view, "Text 75!", "!");
    expect(editor.getMarkdown()).toBe(markdown.replace("Text 75  \n", "Text 75!!\\\n"));
    expect(written).toEqual([1]);
    expect(parse.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe("an edit that the file's text cannot keep", () => {
  it("writes the whole body in Milkdown's form when a new list would join the list above", { timeout: 60_000 }, async () => {
    /** Open `markdown` and add a list with one item right below its first list. */
    const addList = async (markdown: string): Promise<string> => {
      const { editor, view } = await open(markdown);
      const list = blockWith(view, "b");
      const { list_item: item, paragraph } = view.state.schema.nodes;
      const fresh = list.node.type.create(list.node.attrs, item.create(null, paragraph.create(null, view.state.schema.text("new"))));
      view.dispatch(view.state.tr.insert(list.to, fresh));
      const written = editor.getMarkdown();
      await editor.destroy();
      return written;
    };
    // Milkdown writes the new list with "-", which keeps it apart from "*" items.
    expect(await addList("* a\n* b\n\nText.\n")).toBe("* a\n* b\n\n- new\n\nText.\n");
    // Below "-" items, "- new" would read as a third item.
    expect(await addList("- a\n- b\n\nText.\n")).toBe("- a\n- b\n\n* new\n\nText.\n");
  });

  it("writes the whole body in Milkdown's form when two lists end up together", { timeout: 60_000 }, async () => {
    const { editor, view } = await open("* a\n\nBetween.\n\n* c\n\nText [x][r].\n\n[r]: https://r.example\n");
    deleteBlock(view, "Between.");
    expect(editor.getMarkdown()).toBe("- a\n\n* c\n\nText [x](https://r.example).\n");
  });

  it("writes the whole body in Milkdown's form when a list would take in indented code", { timeout: 60_000 }, async () => {
    const { editor, view } = await open("- a\n\nBetween.\n\n    code\n");
    deleteBlock(view, "Between.");
    expect(editor.getMarkdown()).toBe("- a\n\n```\ncode\n```\n");
  });

  it("closes a code block the file left open before writing text after it", { timeout: 60_000 }, async () => {
    const { editor, view } = await open("Text.\n\n```js\nlet x\n");
    const { paragraph } = view.state.schema.nodes;
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, paragraph.create(null, view.state.schema.text("New"))));
    expect(editor.getMarkdown()).toBe("Text.\n\n```js\nlet x\n```\n\nNew\n");
  });

  it("writes the whole body in Milkdown's form when a changed block held a definition", { timeout: 60_000 }, async () => {
    const markdown = "> Quote [a][q].\n>\n> [q]: https://q.y\n\nAlso [b][q].\n";
    const { editor, view } = await open(markdown);
    // The quote keeps its definition while it stays as it was.
    typeAfter(view, "Also", " this");
    expect(editor.getMarkdown()).toBe("> Quote [a][q].\n>\n> [q]: https://q.y\n\nAlso this [b](https://q.y).\n");
    undo(view.state, view.dispatch);
    // Rewriting the quote would drop the definition the paragraph below uses.
    typeAfter(view, "Quote", "d");
    expect(editor.getMarkdown()).toBe("> Quoted [a](https://q.y).\n\nAlso [b](https://q.y).\n");
  });
});
