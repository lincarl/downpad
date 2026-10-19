// @vitest-environment jsdom
// An edit in the document view rewrites only the top-level blocks it changed.
// Every other block keeps the file's text. These tests use the real editor and
// edit it the way commands do, with ProseMirror transactions.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx, parserCtx, remarkCtx, serializerCtx } from "@milkdown/kit/core";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { closeHistory, redo, undo } from "@milkdown/kit/prose/history";
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

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the document editor on `markdown`, recording its change reports.
 *  Also returns its Crepe, for edits and checks the public API cannot make. */
async function open(
  markdown: string,
): Promise<{ editor: WysiwygEditor; crepe: Crepe; view: EditorView; onChange: ReturnType<typeof vi.fn> }> {
  const root = document.createElement("div");
  document.body.append(root);
  const onChange = vi.fn();
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  const { crepe } = editor as unknown as { crepe: Crepe };
  return { editor, crepe, view: crepe.editor.ctx.get(editorViewCtx), onChange };
}

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

/** Insert an empty paragraph below the top-level block that holds `text`, as
 *  Enter twice at the end of a list leaves. */
function emptyLineBelow(view: EditorView, text: string): void {
  view.dispatch(view.state.tr.insert(blockWith(view, text).to, view.state.schema.nodes.paragraph.create()));
}

/** Type `text` at the start of the block that starts with `start`, key by key,
 *  so Crepe's input rules run as they do for a user. */
function typeAtStart(view: EditorView, start: string, text: string): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, after(view, start) - start.length)));
  for (const char of text) {
    const { from, to } = view.state.selection;
    /** The plain insert, for when no input rule handles the key. */
    const insert = () => view.state.tr.insertText(char, from, to);
    if (!view.someProp("handleTextInput", (handle) => handle(view, from, to, char, insert))) view.dispatch(insert());
  }
}

/** The top-level blocks of `doc` without Crepe's empty last line to type on. */
function written(doc: ProseNode): ProseNode[] {
  const blocks: ProseNode[] = [];
  doc.forEach((block) => blocks.push(block));
  const last = blocks[blocks.length - 1];
  return last?.type.name === "paragraph" && last.content.size === 0 ? blocks.slice(0, -1) : blocks;
}

// A file with much that Milkdown writes in its own way, such as a setext
// heading, a closed ATX heading, reference links and their definitions, a list
// numbered with ")" and one with "*", an aligned table, a two-space line break,
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

  it("leaves out a deleted block, and a definition only it used", { timeout: 60_000 }, async () => {
    const markdown = "Intro.\n\n\nGone soon.\n\nSee [it][r].\n\n[r]: https://r.example\n";
    const { editor, view } = await open(markdown);
    deleteBlock(view, "Gone soon.");
    expect(editor.getMarkdown()).toBe("Intro.\n\n\nSee [it][r].\n\n[r]: https://r.example\n");
    deleteBlock(view, "See");
    expect(editor.getMarkdown()).toBe("Intro.\n");
  });

  it("keeps the definitions that unchanged blocks use, and writes a changed paragraph's links inline", { timeout: 60_000 }, async () => {
    const markdown = 'See [docs][d] and [faq].\n\nOther [docs][d].\n\n[d]: https://x.y "Docs"\n[faq]: https://f.y\n';
    const { editor, view } = await open(markdown);
    typeAfter(view, "See", " the");
    expect(editor.getMarkdown()).toBe(
      'See the [docs](https://x.y "Docs") and [faq](https://f.y).\n\nOther [docs][d].\n\n[d]: https://x.y "Docs"\n',
    );
  });

  it("keeps a definition nothing used until no block keeps its text", { timeout: 60_000 }, async () => {
    const { editor, view } = await open("One.\n\nTwo.\n\n[spare]: https://s.example\n");
    typeAfter(view, "One", " more");
    expect(editor.getMarkdown()).toBe("One more.\n\nTwo.\n\n[spare]: https://s.example\n");
    // Select all and Delete leaves one empty paragraph, as in the editor.
    view.dispatch(view.state.tr.delete(0, view.state.doc.content.size));
    expect(editor.getMarkdown()).toBe("");
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

  it("writes the text it wrote before a split mirror sync again when undo takes the sync back", { timeout: 60_000 }, async () => {
    const markdown = 'Intro.\n\nHidden text with [a link][guide].\n\nLine one  \ntwo.\n\n[guide]: https://g.example "Guide"\n';
    const { editor, view } = await open(markdown);
    typeAfter(view, "Intro", " A");
    const saved = markdown.replace("Intro.", "Intro A.");
    expect(editor.getMarkdown()).toBe(saved);
    view.dispatch(closeHistory(view.state.tr));
    // The Markdown pane adds text to the paragraph with the reference link.
    const mirrored = saved.replace("[a link][guide].", "[a link][guide]. B.");
    editor.setMarkdown(mirrored);
    expect(editor.getMarkdown()).toBe(mirrored);
    view.dispatch(closeHistory(view.state.tr));
    undo(view.state, view.dispatch);
    expect(editor.getMarkdown()).toBe(saved);
    redo(view.state, view.dispatch);
    expect(editor.getMarkdown()).toBe(mirrored);
  });

  it("writes and reads only the blocks an edit changed in a long file", { timeout: 60_000 }, async () => {
    const sections = Array.from({ length: 150 }, (_, i) => `Section ${i}\n----------\n\n* Point ${i}\n\nText ${i}  \nmore.\n`);
    const rows = Array.from({ length: 1_000 }, (_, i) => `| ${i} | row ${i} |`);
    // A large table right above the paragraph that is edited.
    sections[75] = sections[75].replace("\n\nText", `\n\n| n | name |\n|---|---|\n${rows.join("\n")}\n\nText`);
    const markdown = sections.join("\n");
    const { editor, crepe, view } = await open("Start.\n");
    // Count what the editor writes and reads from here on.
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
    parse.mockClear();

    // The first edit uses where the parse that opened the text put each block.
    typeAfter(view, "Text 75", "!");
    expect(editor.getMarkdown()).toBe(markdown.replace("Text 75  \n", "Text 75!\\\n"));
    expect(written).toEqual([1]);
    written.length = 0;
    // Later edits write the block they change. A blank line keeps it apart
    // from the table, so neither the table nor the paragraph is read back.
    typeAfter(view, "Text 75!", "!");
    expect(editor.getMarkdown()).toBe(markdown.replace("Text 75  \n", "Text 75!!\\\n"));
    expect(written).toEqual([1]);
    expect(parse).not.toHaveBeenCalled();
  });

  it("keeps the blocks between an insert near the start and an edit near the end of a long file", { timeout: 60_000 }, async () => {
    const markdown = Array.from({ length: 1_200 }, (_, i) => `Para ${i}  \nline.\n`).join("\n");
    const { editor, view } = await open(markdown);
    const { paragraph } = view.state.schema.nodes;
    view.dispatch(view.state.tr.insert(blockWith(view, "Para 3").to, paragraph.create(null, view.state.schema.text("New"))));
    typeAfter(view, "Para 1150", "!");
    expect(editor.getMarkdown()).toBe(
      markdown.replace("Para 3  \nline.\n", "Para 3  \nline.\n\nNew\n").replace("Para 1150  \n", "Para 1150!\\\n"),
    );
  });

  // In a file with no line break at its end, a list, quote or footnote that
  // ends in a tag alone on its line reads that line as its own block when it
  // ends the text. Below it in the file, the line break after it kept the
  // tag inside. A block that becomes the last one keeps that line break.
  it.each([
    [
      "a list above definitions the edit leaves out",
      '# Setup\n\nRead the [guide] first.\n\n- Install the tool\n<img src="setup.png" alt="setup">\n\n[guide]: https://example.com/guide',
      (view: EditorView) => typeAfter(view, "first.", " Then continue."),
      '# Setup\n\nRead the [guide](https://example.com/guide) first. Then continue.\n\n- Install the tool\n<img src="setup.png" alt="setup">\n',
    ],
    [
      "a list above a deleted last paragraph",
      '# Setup\n\n- Install the tool\n<img src="setup.png" alt="setup">\n\nLast paragraph.',
      (view: EditorView) => deleteBlock(view, "Last paragraph."),
      '# Setup\n\n- Install the tool\n<img src="setup.png" alt="setup">\n',
    ],
    [
      "a quote above a deleted last paragraph",
      '# Quote\n\n> A quoted line\n<img src="x.png" alt="x">\n\nLast paragraph.',
      (view: EditorView) => deleteBlock(view, "Last paragraph."),
      '# Quote\n\n> A quoted line\n<img src="x.png" alt="x">\n',
    ],
    [
      "a footnote above a deleted last paragraph",
      "# Notes\n\nA claim[^1] here.\n\n[^1]: The note\n<x-y>\n\nLast paragraph.",
      (view: EditorView) => deleteBlock(view, "Last paragraph."),
      "# Notes\n\nA claim[^1] here.\n\n[^1]: The note\n<x-y>\n",
    ],
    [
      "a list above a deleted last paragraph, with Windows line endings",
      '# Setup\r\n\r\n- Install the tool\r\n<img src="setup.png" alt="setup">\r\n\r\nLast paragraph.',
      (view: EditorView) => deleteBlock(view, "Last paragraph."),
      '# Setup\r\n\r\n- Install the tool\r\n<img src="setup.png" alt="setup">\r\n',
    ],
    // The file's last block stays last, so it keeps the file's end.
    [
      "the file's last block",
      "Intro.\n\n- Install the tool\n<custom-tag>",
      (view: EditorView) => typeAfter(view, "Intro", " now"),
      "Intro now.\n\n- Install the tool\n<custom-tag>",
    ],
  ])("ends the body as the file read for %s", { timeout: 60_000 }, async (_name, markdown, edit, expected) => {
    const { editor, crepe, view } = await open(markdown);
    edit(view);
    expect(editor.getMarkdown()).toBe(expected);
    // Opened again, the text has the document's blocks. A heading's id comes
    // from a plugin the parser does not run.
    const blocks = (doc: ProseNode): unknown =>
      JSON.parse(JSON.stringify(written(doc).map((block) => block.toJSON()), (key, value: unknown) => (key === "id" ? undefined : value)));
    expect(blocks(crepe.editor.action((ctx) => ctx.get(parserCtx)(expected)))).toEqual(blocks(view.state.doc));
  });

  it("keeps the other blocks when a block is moved", { timeout: 60_000 }, async () => {
    const markdown = "* One\n\n* Two\n\n* Three\n\nLast  \nline.\n";
    const { editor, view } = await open(markdown);
    const last = blockWith(view, "Last");
    view.dispatch(view.state.tr.delete(last.from, last.to).insert(0, last.node));
    expect(editor.getMarkdown()).toBe("Last\\\nline.\n\n* One\n\n* Two\n\n* Three\n");
  });
});

describe("a join between a changed block and the file's text", () => {
  it.each([
    // Enter at the end of "Intro:" adds an empty line, which reads as HTML.
    // Right above the list, it would take in the list's first item.
    [
      "an empty line above a loose list",
      "Intro:\n- first item\n\n- second item\n",
      (view: EditorView) => view.dispatch(view.state.tr.split(after(view, "Intro:"))),
      "Intro:\n\n<br />\n\n- first item\n\n- second item\n",
    ],
    // Right under the definition, the quoted line would read as its title.
    [
      "a quoted line under a definition",
      'See [docs][d].\n\n[d]: https://example.com\n## Quotes\n\n"Simplicity is prerequisite for reliability."\nEdsger Dijkstra\n',
      (view: EditorView) => deleteBlock(view, "Quotes"),
      'See [docs][d].\n\n[d]: https://example.com\n\n"Simplicity is prerequisite for reliability."\nEdsger Dijkstra\n',
    ],
    // As a list item, the title would take in the setext heading's text.
    [
      "a setext heading under a new list",
      "# Title\nSection\n-------\n",
      (view: EditorView) => {
        const { from, to } = blockWith(view, "Title");
        const { bullet_list: list, list_item: item, paragraph } = view.state.schema.nodes;
        view.dispatch(view.state.tr.replaceWith(from, to, list.create(null, item.create(null, paragraph.create(null, view.state.schema.text("Title"))))));
      },
      "- Title\n\nSection\n-------\n",
    ],
    // A list that does not start at 1, and indented code, would continue the
    // paragraph the heading became.
    [
      "a list that starts at 3 under a new paragraph",
      "## Steps\n3. third\n\n4. fourth\n\nEnd.\n",
      (view: EditorView) => {
        const { from, to } = blockWith(view, "Steps");
        view.dispatch(view.state.tr.setBlockType(from, to, view.state.schema.nodes.paragraph));
      },
      "Steps\n\n3. third\n\n4. fourth\n\nEnd.\n",
    ],
    [
      "indented code under a new paragraph",
      "## Install\n    npm install\n\n    npm start\n\nEnd.\n",
      (view: EditorView) => {
        const { from, to } = blockWith(view, "Install");
        view.dispatch(view.state.tr.setBlockType(from, to, view.state.schema.nodes.paragraph));
      },
      "Install\n\n    npm install\n\n    npm start\n\nEnd.\n",
    ],
    // Right under a definition, a list that does not start at 1, indented code
    // and an HTML block that starts with a tag would read as a paragraph.
    [
      "a list that starts at 3 under a definition",
      "See [docs][d].\n\n[d]: https://example.com\n## Steps\n3. third\n4. fourth\n",
      (view: EditorView) => deleteBlock(view, "Steps"),
      "See [docs][d].\n\n[d]: https://example.com\n\n3. third\n4. fourth\n",
    ],
    [
      "indented code under a definition",
      "Install the [tool][t].\n\n[t]: https://example.com/tool\n## Setup\n    npm install tool\n    npm start\n",
      (view: EditorView) => deleteBlock(view, "Setup"),
      "Install the [tool][t].\n\n[t]: https://example.com/tool\n\n    npm install tool\n    npm start\n",
    ],
    [
      "an HTML block under a definition",
      "See [docs][d].\n\n[d]: https://example.com\n## Note\n<custom-note>\n*not emphasis*\n</custom-note>\n",
      (view: EditorView) => deleteBlock(view, "Note"),
      "See [docs][d].\n\n[d]: https://example.com\n\n<custom-note>\n*not emphasis*\n</custom-note>\n",
    ],
    // The edited paragraph writes its link inline, so the definition right
    // above the list goes, and the one above it is left there.
    [
      "a list that starts at 3 under the definition left when another goes",
      "# Upgrade\n\nRead the [release notes][notes] first.\n\nBack up with the [backup tool][backup].\n\n[notes]: https://example.com/notes\n[backup]: https://example.com/backup\n\n3. Stop the server\n4. Install the update\n\nDone.\n",
      (view: EditorView) => typeAfter(view, "Back up", " now"),
      "# Upgrade\n\nRead the [release notes][notes] first.\n\nBack up now with the [backup tool](https://example.com/backup).\n\n[notes]: https://example.com/notes\n\n3. Stop the server\n4. Install the update\n\nDone.\n",
    ],
    [
      "indented code under the definition left when another goes",
      "Use [a] here.\n\nAnd [b] there.\n\n[a]: https://a.example\n[b]: https://b.example\n\n    npm install\n    npm start\n",
      (view: EditorView) => typeAfter(view, "there", " now"),
      "Use [a] here.\n\nAnd [b](https://b.example) there now.\n\n[a]: https://a.example\n\n    npm install\n    npm start\n",
    ],
    // Under the definition, the list would read as a paragraph, and with a
    // blank line above it, it would take in the paragraph the heading became.
    [
      "a list between a definition and a new paragraph",
      "See [docs][d].\n\n[d]: https://example.com\n## Steps\n3. third\n4. fourth\n## After\n\nEnd.\n",
      (view: EditorView) => {
        deleteBlock(view, "Steps");
        const { from, to } = blockWith(view, "After");
        view.dispatch(view.state.tr.setBlockType(from, to, view.state.schema.nodes.paragraph));
      },
      "See [docs][d].\n\n[d]: https://example.com\n\n3. third\n4. fourth\n\nAfter\n\nEnd.\n",
    ],
    // A new list between a definition and a paragraph, which would read as a
    // paragraph under the definition.
    [
      "a new list under a definition",
      "See [docs][d].\n\n[d]: https://example.com\n## Old\nNext line.\n",
      (view: EditorView) => {
        const { from, to } = blockWith(view, "Old");
        const { ordered_list: list, list_item: item, paragraph } = view.state.schema.nodes;
        view.dispatch(view.state.tr.replaceWith(from, to, list.create({ order: 3 }, item.create(null, paragraph.create(null, view.state.schema.text("Old"))))));
      },
      "See [docs][d].\n\n[d]: https://example.com\n\n3. Old\n\nNext line.\n",
    ],
    // A list, quote or footnote would take in an empty line below it.
    [
      "an empty line where a heading was under a list",
      "- one\n- two\n# Head\n\nText.\n",
      (view: EditorView) => {
        const { from, to } = blockWith(view, "Head");
        view.dispatch(view.state.tr.replaceWith(from, to, view.state.schema.nodes.paragraph.create()));
      },
      "- one\n- two\n\n<br />\n\nText.\n",
    ],
    [
      "an empty line under a list",
      "# Notes\n\n- Buy milk\n- Call Ann\n## Later\n\nText.\n",
      (view: EditorView) => emptyLineBelow(view, "Call Ann"),
      "# Notes\n\n- Buy milk\n- Call Ann\n\n<br />\n\n## Later\n\nText.\n",
    ],
    [
      "an empty line under a quote",
      "> A quote.\n## Next\n\nText.\n",
      (view: EditorView) => emptyLineBelow(view, "A quote."),
      "> A quote.\n\n<br />\n\n## Next\n\nText.\n",
    ],
    [
      "an empty line under a footnote",
      "Text[^1].\n\n[^1]: The note.\n## Next\n",
      (view: EditorView) => emptyLineBelow(view, "The note."),
      "Text[^1].\n\n[^1]: The note.\n\n<br />\n\n## Next\n",
    ],
  ])("gets a blank line when the file's line break would join %s", { timeout: 60_000 }, async (_name, markdown, edit, expected) => {
    const { editor, view } = await open(markdown);
    edit(view);
    expect(editor.getMarkdown()).toBe(expected);
  });

  // A quote or list whose last block is a code block the file left open ends
  // after its line break when a list or quote starts on the next line.
  it.each([
    [
      "a quote, under a heading that took in its code",
      "## Notes\n\n> ```\n> unclosed code in a quote\n- item one\n- item two\n",
      (view: EditorView) => {
        const { from } = blockWith(view, "Notes");
        const { to } = blockWith(view, "unclosed code");
        const text = view.state.schema.text("Notesunclosed code in a quote");
        view.dispatch(view.state.tr.replaceWith(from, to, view.state.schema.nodes.heading.create({ level: 2 }, text)));
      },
      "## Notesunclosed code in a quote\n- item one\n- item two\n",
    ],
    [
      "a quote, when its code moves out of it",
      "Intro.\n\n> ```\n> unclosed code in a quote\n- item one\n- item two\n",
      (view: EditorView) => {
        const quote = blockWith(view, "unclosed code");
        view.dispatch(view.state.tr.replaceWith(quote.from, quote.to, quote.node.child(0)));
      },
      "Intro.\n\n```\nunclosed code in a quote\n```\n- item one\n- item two\n",
    ],
    [
      "a list, under a changed heading",
      "## Notes\n\n- ```\n  unclosed in item\n> quoted after\n",
      (view: EditorView) => {
        typeAfter(view, "Notes", " x");
        deleteBlock(view, "unclosed");
      },
      "## Notes x\n> quoted after\n",
    ],
  ])("starts the block below on its own line when %s", { timeout: 60_000 }, async (_name, markdown, edit, expected) => {
    const { editor, view } = await open(markdown);
    edit(view);
    expect(editor.getMarkdown()).toBe(expected);
  });

  // A code block or comment the file left open at the end of a list or
  // footnote holds the line breaks below it before a quote, another list or
  // the end of the file, and not before a paragraph. Where the text after it
  // leaves it holding the same, the file's text reads back as the document.
  it.each([
    [
      "a quote below a list that ends in an open comment is edited",
      "* Notes\n\n  <!-- draft: more to come\n\n> Quote.\n",
      (view: EditorView) => typeAfter(view, "Quote.", " Edited"),
      "* Notes\n\n  <!-- draft: more to come\n\n> Quote. Edited\n",
    ],
    [
      "a paragraph is added below a list that ends in an open fence",
      "* Run:\n\n  ```sh\n  echo hello\n",
      (view: EditorView) => {
        const { paragraph } = view.state.schema.nodes;
        view.dispatch(view.state.tr.insert(blockWith(view, "echo hello").to, paragraph.create(null, view.state.schema.text("Done."))));
      },
      "* Run:\n\n  ```sh\n  echo hello\n\nDone.\n",
    ],
    [
      "a list that ends in an open comment becomes the last block",
      "* Notes\n\n  <!-- draft\n> Quote.\n",
      (view: EditorView) => deleteBlock(view, "Quote."),
      "* Notes\n\n  <!-- draft\n",
    ],
    // Below the comment, the paragraph the quote became would leave it without
    // its line break. A blank line gives the comment the same text again.
    [
      "a quote below a list that ends in an open comment becomes a paragraph",
      "* Notes\n\n  <!-- draft\n> Quote.\n",
      (view: EditorView) => {
        const quote = blockWith(view, "Quote.");
        view.dispatch(view.state.tr.replaceWith(quote.from, quote.to, quote.node.child(0)));
      },
      "* Notes\n\n  <!-- draft\n\nQuote.\n",
    ],
  ])("keeps the file's text when %s", { timeout: 60_000 }, async (_name, markdown, edit, expected) => {
    const { editor, view } = await open(markdown);
    edit(view);
    expect(editor.getMarkdown()).toBe(expected);
  });

  it("keeps a list that ends in a closed fence when the block below it goes", { timeout: 60_000 }, async () => {
    const { editor, view } = await open("* Run:\n\n  ```sh\n  echo hello\n  ```\n\n> Done.\n");
    deleteBlock(view, "Done.");
    expect(editor.getMarkdown()).toBe("* Run:\n\n  ```sh\n  echo hello\n  ```\n");
  });

  it("gets a blank line when reading the join back would take longer than writing the whole body", { timeout: 60_000 }, async () => {
    // The list starts on its own line under the quote, but only reading the
    // whole quote back would tell.
    const quote = Array.from({ length: 2_000 }, (_, i) => `> Quoted line ${i}`).join("\n");
    const { editor, crepe, view } = await open(`${quote}\n- item\n`);
    const parse = vi.spyOn(crepe.editor.ctx.get(remarkCtx), "parse");
    typeAfter(view, "item", " edited");
    expect(editor.getMarkdown()).toBe(`${quote}\n\n- item edited\n`);
    expect(parse).not.toHaveBeenCalled();
  });
});

describe("an edit that the file's text cannot keep", () => {
  it("writes the whole body in Milkdown's form when a new list would join the list above", { timeout: 60_000 }, async () => {
    /** Open `markdown` and add a list with one item right below its first list. */
    const addList = async (markdown: string): Promise<string | null> => {
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
    // Type on the empty line Crepe keeps below a final code block. Add it first
    // if the editor has not yet.
    if (view.state.doc.lastChild?.type.name !== "paragraph") {
      view.dispatch(view.state.tr.insert(view.state.doc.content.size, view.state.schema.nodes.paragraph.create()));
    }
    view.dispatch(view.state.tr.insertText("New", view.state.doc.content.size - 1));
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

describe("an edit near text that reads as it does only where it is", () => {
  it.each([
    // Under the definition, these lines are a paragraph. Once the definition
    // goes, they would read as a list and as indented code.
    [
      "a paragraph that looks like a list under a definition the edit leaves out",
      "Intro uses [a] there.\n\n[a]: https://a.example\n2. Second line\n\nEnd.\n",
      (view: EditorView) => typeAfter(view, "there", " now"),
      "Intro uses [a](https://a.example) there now.\n\n2\\. Second line\n\nEnd.\n",
    ],
    // The rules show nothing above joins these lines, but they read as a
    // paragraph only under the definition, which the edit leaves out.
    [
      "a paragraph that looks like a list under a new heading",
      "Intro uses [a] there.\n\n[a]: https://a.example\n2. Second line\n\nEnd.\n",
      (view: EditorView) => {
        const { from, to } = blockWith(view, "Intro uses");
        view.dispatch(view.state.tr.setBlockType(from, to, view.state.schema.nodes.heading, { level: 1 }));
      },
      "# Intro uses [a](https://a.example) there.\n\n2\\. Second line\n\nEnd.\n",
    ],
    [
      "a paragraph that looks like a list, left at the top",
      "Intro uses [a] there.\n\n[a]: https://a.example\n2. Second line\n\nEnd.\n",
      (view: EditorView) => deleteBlock(view, "Intro uses"),
      "2\\. Second line\n\nEnd.\n",
    ],
    [
      "a paragraph that looks like code under a definition the edit leaves out",
      "Intro uses [a] there.\n\n[a]: https://a.example\n    not code\n\nEnd.\n",
      (view: EditorView) => typeAfter(view, "there", " now"),
      "Intro uses [a](https://a.example) there now.\n\nnot code\n\nEnd.\n",
    ],
    // Below indented code, even after a blank line, the parser reads a list
    // that does not start at 1 as a paragraph. Milkdown writes the code fenced.
    [
      "a list typed below indented code",
      "Install it:\n\n    npm install\n\nStart the server.\n",
      (view: EditorView) => typeAtStart(view, "Start the server", "3. "),
      "Install it:\n\n```\nnpm install\n```\n\n3. Start the server.\n",
    ],
    [
      "a list that the edit leaves below indented code",
      "Install it:\n\n    npm install\n\nThen:\n\n3. Start the server\n4. Open the page\n",
      (view: EditorView) => deleteBlock(view, "Then:"),
      "Install it:\n\n```\nnpm install\n```\n\n3. Start the server\n4. Open the page\n",
    ],
    // Below a list or quote that is still open, the parser ends indented code
    // after its first line. That splits code that was one block, and joins
    // code that read as two blocks only there.
    [
      "indented code that would split below a list",
      "1.   Install the tools.\n2.   Build the project.\n\nRun these commands:\n\n    make\n    make install\n",
      (view: EditorView) => deleteBlock(view, "Run these commands:"),
      "1. Install the tools.\n2. Build the project.\n\n```\nmake\nmake install\n```\n",
    ],
    [
      "indented code that read as two blocks below a list",
      "Intro.\n\n100. Item\n\n    code one\n    code two\n",
      (view: EditorView) => deleteBlock(view, "Item"),
      "Intro.\n\n```\ncode one\n```\n\n```\ncode two\n```\n",
    ],
    [
      "indented code that read as two blocks below a list, left at the top",
      "100. Item\n\n    code one\n    code two\n",
      (view: EditorView) => deleteBlock(view, "Item"),
      "```\ncode one\n```\n\n```\ncode two\n```\n",
    ],
    [
      "indented code that would split below a quote",
      "> ```\n> unclosed\n## Run\n    make\n    make install\n",
      (view: EditorView) => deleteBlock(view, "Run"),
      "> ```\n> unclosed\n> ```\n\n```\nmake\nmake install\n```\n",
    ],
    // On a line right after a paragraph or indented code that has not ended,
    // the parser does not start a list item that does not start at 1, or an
    // empty one, even inside a quote or list that starts on that line.
    [
      "a list in a quote that would read as text below indented code",
      "    make install\n\nThen:\n\n> 2. Restart the server.\n> 3. Check the logs.\n",
      (view: EditorView) => deleteBlock(view, "Then:"),
      "```\nmake install\n```\n\n> 2. Restart the server.\n> 3. Check the logs.\n",
    ],
    [
      "a list in a quote that would read as text between indented code and a new paragraph",
      "    make install\n\nThen:\n\n> 2. Restart the server.\n## Next\n",
      (view: EditorView) => {
        deleteBlock(view, "Then:");
        const { from, to } = blockWith(view, "Next");
        view.dispatch(view.state.tr.setBlockType(from, to, view.state.schema.nodes.paragraph));
      },
      "```\nmake install\n```\n\n> 2. Restart the server.\n\nNext\n",
    ],
    [
      "a new list in a quote that would read as text below indented code",
      "    make install\n\nThen:\n",
      (view: EditorView) => {
        const { from, to } = blockWith(view, "Then:");
        const { blockquote, ordered_list: list, list_item: item, paragraph } = view.state.schema.nodes;
        const steps = list.create({ order: 2 }, item.create(null, paragraph.create(null, view.state.schema.text("Restart the server."))));
        view.dispatch(view.state.tr.replaceWith(from, to, blockquote.create(null, steps)));
      },
      "```\nmake install\n```\n\n> 2. Restart the server.\n",
    ],
    [
      "text in a quote that reads as text only below indented code",
      "    make install\n\n> 2. Restart the server.\n> 3. Check the logs.\n",
      (view: EditorView) => deleteBlock(view, "make install"),
      "> 2\\. Restart the server.\n> 3\\. Check the logs.\n",
    ],
    [
      "text in a quote that reads as text only below a paragraph",
      "Para\n> 2. Restart the server.\n> 3. Check the logs.\n",
      (view: EditorView) => {
        const { from, to } = blockWith(view, "Para");
        view.dispatch(view.state.tr.setBlockType(from, to, view.state.schema.nodes.heading, { level: 1 }));
      },
      "# Para\n\n> 2\\. Restart the server.\n> 3\\. Check the logs.\n",
    ],
    [
      "a list in a list item that would read as text below indented code",
      "    make\n\nThen:\n\n- 2. nested\n",
      (view: EditorView) => deleteBlock(view, "Then:"),
      "```\nmake\n```\n\n- <br />\n\n  2. nested\n",
    ],
    [
      "an empty list item in a quote below indented code",
      "    make\n\nThen:\n\n> -\n>   empty first item\n",
      (view: EditorView) => deleteBlock(view, "Then:"),
      "```\nmake\n```\n\n> - empty first item\n",
    ],
    // Below the list with wide items, the code's first line is lazy, so the
    // parser ends the code after it. Read without the list, the code would
    // still be open, and the line below it would read as text.
    [
      "a list in a quote below indented code that a list above ends",
      "1.   Install the tools.\n\n    make\n    make install\n\n> 2. Restart the server.\n",
      (view: EditorView) => deleteBlock(view, "make install"),
      "1. Install the tools.\n\n```\nmake\n```\n\n> 2\\. Restart the server.\n",
    ],
    // At the end of a file with no line break after it, a tag alone on its
    // line right below a list item reads as its own block. With anything
    // after it, it reads as part of the item.
    [
      "a tag below a list that read as its own block only at the end of the file",
      "- one\n- two\n<custom-tag>",
      (view: EditorView) => {
        const { paragraph } = view.state.schema.nodes;
        view.dispatch(view.state.tr.insert(view.state.doc.content.size, paragraph.create(null, view.state.schema.text("After."))));
      },
      "- one\n- two\n\n<custom-tag>\n\nAfter.\n",
    ],
    // A code block or comment the file left open at the end of a list or
    // footnote takes in the blank lines below it, or not, depending on the
    // line after them.
    [
      "a list that ends in an open fence, with a quote added below it",
      "- Run:\n\n  ```sh\n  echo hello\n",
      (view: EditorView) => {
        const { blockquote, paragraph } = view.state.schema.nodes;
        const quote = blockquote.create(null, paragraph.create(null, view.state.schema.text("Done.")));
        view.dispatch(view.state.tr.insert(blockWith(view, "echo hello").to, quote));
      },
      "- Run:\n\n  ```sh\n  echo hello\n  ```\n\n> Done.\n",
    ],
    [
      "a list that ends in an open fence and becomes the last block",
      "- Run:\n\n  ```sh\n  echo hello\n\n> Done.\n",
      (view: EditorView) => deleteBlock(view, "Done."),
      "- Run:\n\n  ```sh\n  echo hello\n\n  ```\n",
    ],
    [
      "a footnote that ends in an open comment and becomes the last block",
      "Text[^1].\n\n[^1]: Note.\n\n    <!-- draft\n\n> Quote.\n",
      (view: EditorView) => deleteBlock(view, "Quote."),
      "Text[^1].\n\n[^1]: Note.\n\n    <!-- draft\n\n",
    ],
    // Milkdown writes the raw text of an HTML block that an edit merged into
    // a paragraph as it is. Next to a definition the file keeps, its `[ref]`
    // would read as a link the document does not have.
    [
      "bracketed text in merged HTML next to a kept definition",
      "Intro.\n\n</div>\n[ref] here\n\nUses [ref].\n\n[ref]: https://r.example\n",
      (view: EditorView) => view.dispatch(view.state.tr.join(view.state.doc.child(0).nodeSize)),
      "Intro.</div>\n[ref] here\n\nUses [ref](https://r.example).\n",
    ],
    [
      "collapsed and full references in merged HTML next to a kept definition",
      "Intro.\n\n</div>\n[Ref][] and [x][ REF ]\n\nUses [ref].\n\n[ref]: https://r.example\n",
      (view: EditorView) => view.dispatch(view.state.tr.join(view.state.doc.child(0).nodeSize)),
      "Intro.</div>\n[Ref][] and [x][ REF ]\n\nUses [ref](https://r.example).\n",
    ],
    [
      "bracketed text in merged HTML next to a definition inside a kept quote",
      "Intro.\n\n</div>\n[q] here\n\n> Quote [a][q].\n>\n> [q]: https://q.example\n",
      (view: EditorView) => view.dispatch(view.state.tr.join(view.state.doc.child(0).nodeSize)),
      "Intro.</div>\n[q] here\n\n> Quote [a](https://q.example).\n",
    ],
    // A label goes on over a line break, also after a backslash.
    [
      "bracketed text over a backslash and a line break in merged HTML next to a kept definition",
      "Intro.\n\n</div>\n[r\\\nef] here\n\nUses [r\\\nef].\n\n[r\\\nef]: https://r.example\n",
      (view: EditorView) => view.dispatch(view.state.tr.join(view.state.doc.child(0).nodeSize)),
      "Intro.</div>\n[r\\\nef] here\n\nUses [r\\\nef](https://r.example).\n",
    ],
    // Parentheses that are no link destination leave `[ref]` a reference.
    [
      "bracketed text before parentheses with a space in merged HTML next to a kept definition",
      "Intro.\n\n</div>\n[ref](not a link) here\n\nUses [ref].\n\n[ref]: https://r.example\n",
      (view: EditorView) => view.dispatch(view.state.tr.join(view.state.doc.child(0).nodeSize)),
      "Intro.</div>\n[ref](not a link) here\n\nUses [ref](https://r.example).\n",
    ],
    [
      "bracketed text before parentheses with an unclosed < in merged HTML next to a kept definition",
      "Intro.\n\n</div>\n[ref](<x) here\n\nUses [ref].\n\n[ref]: https://r.example\n",
      (view: EditorView) => view.dispatch(view.state.tr.join(view.state.doc.child(0).nodeSize)),
      "Intro.</div>\n[ref](<x) here\n\nUses [ref](https://r.example).\n",
    ],
    [
      "bracketed text before parentheses with a backslash and a space in merged HTML next to a kept definition",
      "Intro.\n\n</div>\n[ref](a\\ b) here\n\nUses [ref].\n\n[ref]: https://r.example\n",
      (view: EditorView) => view.dispatch(view.state.tr.join(view.state.doc.child(0).nodeSize)),
      "Intro.</div>\n[ref](a\\ b) here\n\nUses [ref](https://r.example).\n",
    ],
    [
      "bracketed text before parentheses with a control character in merged HTML next to a kept definition",
      "Intro.\n\n</div>\n[ref](\u0001) here\n\nUses [ref].\n\n[ref]: https://r.example\n",
      (view: EditorView) => view.dispatch(view.state.tr.join(view.state.doc.child(0).nodeSize)),
      "Intro.</div>\n[ref](\u0001) here\n\nUses [ref](https://r.example).\n",
    ],
    [
      "bracketed text in HTML joined to the paragraph above",
      "Inline $x$ math.\n\n</div>\nUses [ref] and [t] links.\n\t\n<div>\nblock\n</div>\n    code a\n    code b\n  \n-     code in item\n\n[ref]: /r\n[t]: /t\n",
      (view: EditorView) => view.dispatch(view.state.tr.join(view.state.doc.child(0).nodeSize)),
      "Inline $x$ math.</div>\nUses [ref] and [t] links.\n\n<div>\nblock\n</div>\n    code a\n    code b\n\n- <br />\n\n  ```\n  code in item\n  ```\n",
    ],
    [
      "bracketed text in HTML that a mark made into a paragraph",
      "</div>\n[ref]: https://example.com\n  \n<span>seven</span>\n<!-- c -->\n\t\n- - -\n\n[ref]: /r\n[t]: /t\n",
      (view: EditorView) => view.dispatch(view.state.tr.addMark(1, 2, view.state.schema.marks.emphasis.create())),
      "*</div>\n[ref]: https://example.com*\n\n<span>seven</span>\n\n<!-- c -->\n\n---\n",
    ],
    [
      "bracketed text in HTML after text typed before it",
      "***\n\t\n<table><tr><td>x</td></tr></table>\n[t]: /url\n  'title'\n\n2) two\n3) three\n\n\n- <custom-tag>\n\n[ref]: /r\n[t]: /t\n",
      (view: EditorView) => view.dispatch(view.state.tr.insertText("[^1]", 2)),
      "---\n\n\\[^1]<table><tr><td>x</td></tr></table>\n[t]: /url\n  'title'\n\n2. two\n3. three\n\n- <custom-tag>\n",
    ],
    // Milkdown writes the raw text of an HTML block as it is. Once text comes
    // before a comment or `<pre>` with blank lines in it, a blank line ends
    // that text, and a line in it reads as a definition for the whole file.
    // Kept text such as `[draft]` would then read as a link or footnote.
    [
      "a comment with a definition in it merged into a paragraph",
      "# Release notes\n\nStatus [draft] until review.\n\nIntro paragraph.\n\n<!--\n\n[draft]: https://example.com/old-draft\n\n-->\n\nTail.\n",
      (view: EditorView) => view.dispatch(view.state.tr.join(blockWith(view, "Intro paragraph.").to)),
      "# Release notes\n\nStatus \\[draft] until review.\n\nIntro paragraph.<!--\n\n[draft]: https://example.com/old-draft\n\n-->\n\nTail.\n",
    ],
    [
      "a comment with a footnote in it merged into a paragraph",
      "# Notes\n\nA claim [^1] stays as typed.\n\nIntro paragraph.\n\n<!--\n\n[^1]: a note kept for later\n\n-->\n\nTail.\n",
      (view: EditorView) => view.dispatch(view.state.tr.join(blockWith(view, "Intro paragraph.").to)),
      "# Notes\n\nA claim \\[^1] stays as typed.\n\nIntro paragraph.<!--\n\n[^1]: a note kept for later\n\n-->\n\nTail.\n",
    ],
    [
      "text typed before a `<pre>` with a definition in it",
      "# Release notes\n\nStatus [draft] until review.\n\n<pre>\n\n> [draft]: https://example.com/old-draft\n\n</pre>\n\nTail.\n",
      // The `<pre>` is the block right below the paragraph.
      (view: EditorView) => view.dispatch(view.state.tr.insertText("Note: ", blockWith(view, "until review.").to + 1)),
      "# Release notes\n\nStatus \\[draft] until review.\n\nNote: <pre>\n\n> [draft]: https://example.com/old-draft\n\n</pre>\n\nTail.\n",
    ],
    [
      "a heading made of text and a comment with a definition in it",
      "Status [draft] until review.\n\nIntro paragraph.\n\n<!--\n\n[draft]: https://example.com/old-draft\n\n-->\n",
      (view: EditorView) => {
        view.dispatch(view.state.tr.join(blockWith(view, "Intro paragraph.").to));
        const { from } = blockWith(view, "Intro paragraph.");
        view.dispatch(view.state.tr.setBlockType(from + 1, from + 1, view.state.schema.nodes.heading, { level: 2 }));
      },
      "Status \\[draft] until review.\n\nIntro paragraph.<!--\n\n[draft]: https://example.com/old-draft\n\n-->\n---\n",
    ],
    // Milkdown writes a heading with line breaks in setext form. Starting with
    // a comment, it reads as the comment and a paragraph "===", which would
    // take in the next line.
    [
      "a heading made of a comment",
      "Intro.\n\n<!--\nTODO: check\n-->\nText after the comment.\n",
      (view: EditorView) => {
        const { from } = blockWith(view, "Intro.");
        const at = from + view.state.doc.child(0).nodeSize + 1;
        view.dispatch(view.state.tr.setBlockType(at, at, view.state.schema.nodes.heading, { level: 1 }));
      },
      "Intro.\n\n<!--\nTODO: check\n-->\n===\n\nText after the comment.\n",
    ],
  ])("writes the whole body in Milkdown's form for %s", { timeout: 60_000 }, async (_name, markdown, edit, expected) => {
    const { editor, crepe, view } = await open(markdown);
    edit(view);
    expect(editor.getMarkdown()).toBe(expected);
    expect(expected).toBe(crepe.editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc)));
  });
});

describe("a definition the file keeps", () => {
  it("keeps the file's text when only a changed link's text matches its label", { timeout: 60_000 }, async () => {
    const markdown = "Intro.\n\nSee [ref](https://x.example).\n\nUses [ref].\n\n[ref]: https://r.example\n";
    const { editor, view } = await open(markdown);
    // An inline link takes the place of a reference, so its text is no label.
    typeAfter(view, "See", " now");
    expect(editor.getMarkdown()).toBe(markdown.replace("See [ref]", "See now [ref]"));
  });

  it("keeps the file's text for changed links with a title, a space or parentheses in the URL", { timeout: 60_000 }, async () => {
    const markdown =
      'Intro.\n\nSee [ref](https://x.example/a_\\(b\\) "T") and [ref](<https://x.example/a b>).\n\nUses [ref].\n\n[ref]: https://r.example\n';
    const { editor, view } = await open(markdown);
    // These are the forms Milkdown writes such links in.
    typeAfter(view, "See", " now");
    expect(editor.getMarkdown()).toBe(markdown.replace("See [ref]", "See now [ref]"));
  });

  it("keeps the file's text when a changed block adds a definition but no kept block has brackets", { timeout: 60_000 }, async () => {
    const markdown = "* Status draft until review.\n\nIntro paragraph.\n\n<!--\n\n[draft]: /old\n\n-->\n\nTail.\n";
    const { editor, view } = await open(markdown);
    // A definition changes only how text in brackets reads.
    view.dispatch(view.state.tr.join(blockWith(view, "Intro paragraph.").to));
    expect(editor.getMarkdown()).toBe(markdown.replace("Intro paragraph.\n\n<!--", "Intro paragraph.<!--"));
  });

  it("keeps the file's text when a line like a definition is typed in a code block", { timeout: 60_000 }, async () => {
    const markdown = "See [the docs][d].\n\n```\nlet a = b\n```\n\n[d]: https://d.example\n";
    const { editor, view } = await open(markdown);
    // Text in a code block is never a definition.
    typeAfter(view, "let a = b", "\n[x]: /other");
    expect(editor.getMarkdown()).toBe(markdown.replace("let a = b", "let a = b\n[x]: /other"));
  });

  it("keeps the file's text when the label is typed in a code block", { timeout: 60_000 }, async () => {
    const markdown = "Intro.\n\n```\nlet a = b\n```\n\nUses [ref].\n\n[ref]: https://r.example\n";
    const { editor, view } = await open(markdown);
    // Text in a code block is never a reference.
    typeAfter(view, "let a = b", "[ref]");
    expect(editor.getMarkdown()).toBe(markdown.replace("let a = b", "let a = b[ref]"));
  });
});

describe("a changed footnote", () => {
  it("keeps the file's text where kept blocks use its label", { timeout: 60_000 }, async () => {
    const markdown = "A claim[^1] here, with [a link][r].\n\n[^1]: The note.\n\n[r]: https://r.example\n";
    const { editor, view } = await open(markdown);
    // The changed footnote's own line defines the label it already had.
    typeAfter(view, "The note", " now");
    expect(editor.getMarkdown()).toBe(markdown.replace("The note.", "The note now."));
  });
});

describe("a new footnote", () => {
  it("writes the whole body in Milkdown's form when it could turn text in a kept block into a reference", { timeout: 60_000 }, async () => {
    const { editor, crepe, view } = await open("Text with [^new] in it.\n\nEnd.\n");
    const { footnote_definition: definition, paragraph } = view.state.schema.nodes;
    const note = definition.create({ label: "new" }, paragraph.create(null, view.state.schema.text("Note.")));
    view.dispatch(view.state.tr.insert(blockWith(view, "End.").to, note));
    const milkdown = crepe.editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
    expect(milkdown).toContain("\\[^new]");
    expect(editor.getMarkdown()).toBe(milkdown);
  });
});

describe("the text written for a document", () => {
  it("does not depend on which joins earlier writes read back", { timeout: 60_000 }, async () => {
    /** Forty list items of an HTML list. */
    const rows = (tag: string) => Array.from({ length: 40 }, (_, i) => `  <li>${tag} entry number ${i} with some text</li>`).join("\n");
    const markdown = `# Page\n\n<ul class="one">\n${rows("first")}\n</ul>\n\nAlpha word here.\n\n<ul class="two">\n${rows("second")}\n</ul>\n\nBeta word here.\n\n* End item\n`;
    const { editor, view } = await open(markdown);
    // Change both paragraphs in one transaction, as Replace all does.
    const tr = view.state.tr;
    for (const word of ["Beta word", "Alpha word"]) {
      const at = after(view, word);
      tr.insertText("term", at - 4, at);
    }
    view.dispatch(tr);
    const first = editor.getMarkdown();
    const replaced = view.state.doc;
    view.dispatch(closeHistory(view.state.tr));
    typeAfter(view, "End item", "!");
    editor.getMarkdown();
    undo(view.state, view.dispatch);
    expect(view.state.doc.eq(replaced)).toBe(true);
    expect(editor.getMarkdown()).toBe(first);
    expect(first).toBe(markdown.replace("Alpha word", "Alpha term").replace("Beta word", "Beta term"));
  });

  it("does not depend on where a join earlier writes read back was", { timeout: 60_000 }, async () => {
    const markdown = "Alpha\n# Head\nBeta\n\n* star item\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    const { editor, view } = await open(markdown);
    // Reading back shows that "Beta" would join "Alpha" without a blank line.
    deleteBlock(view, "Head");
    expect(editor.getMarkdown()).toBe(markdown.replace("# Head\n", "\n"));
    // The same two blocks, now one block further down.
    view.dispatch(view.state.tr.insert(0, view.state.schema.nodes.paragraph.create(null, view.state.schema.text("New top."))));
    expect(editor.getMarkdown()).toBe(`New top.\n\n${markdown.replace("# Head\n", "\n")}`);
  });
});

describe("a block Milkdown cannot write", () => {
  it("keeps its text while another block changes, and reports nothing once it changes", { timeout: 60_000 }, async () => {
    const markdown = "Good one.\n\nBad block.\n\nGood two.\n";
    const { editor, crepe, view, onChange } = await open("Start.\n");
    const serialize = crepe.editor.ctx.get(serializerCtx);
    crepe.editor.ctx.set(serializerCtx, (doc: ProseNode) => {
      if (doc.textContent.includes("Bad")) throw new Error("cannot write this block");
      return serialize(doc);
    });
    editor.setMarkdown(markdown);
    typeAfter(view, "Good two", " typed");
    await settle();
    expect(onChange.mock.lastCall?.[0]).toBe("Good one.\n\nBad block.\n\nGood two typed.\n");
    onChange.mockClear();
    typeAfter(view, "Bad", "der");
    await settle();
    expect(editor.getMarkdown()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
