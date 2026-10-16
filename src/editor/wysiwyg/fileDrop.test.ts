// @vitest-environment jsdom
// A file dropped on the document goes in at the block edge nearest the drop
// point, the edge Crepe's drop indicator marks. These tests use the real editor
// with a laid-out page, which jsdom cannot measure, given to its blocks.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import type { Node } from "@milkdown/kit/prose/model";
import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
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

/** The editor's ProseMirror view, to lay out its blocks. */
const viewOf = (opened: WysiwygEditor) =>
  (opened as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);

/** A box on the page, from `left` to 600px. */
const box = (top: number, bottom: number, left = 0) => DOMRect.fromRect({ x: left, y: top, width: 600 - left, height: bottom - top });

/** Mount the document editor on `markdown`, wait past its first frame, and
 *  give the editor a box from 80px to 280px down the page. */
async function open(markdown: string): Promise<WysiwygEditor> {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange: () => {} }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  vi.spyOn(viewOf(editor).dom, "getBoundingClientRect").mockReturnValue(box(80, 280));
  return editor;
}

/** Give the first block that `matches` a box on the page between `top` and
 *  `bottom`, from `left` to 600px. */
function place(opened: WysiwygEditor, matches: (node: Node) => boolean, top: number, bottom: number, left = 0): void {
  const view = viewOf(opened);
  let found = false;
  view.state.doc.descendants((node, pos) => {
    if (found || !matches(node)) return !found;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) throw new Error(`No element for ${node.type.name}`);
    vi.spyOn(dom, "getBoundingClientRect").mockReturnValue(box(top, bottom, left));
    found = true;
    return false;
  });
  if (!found) throw new Error("No block to place");
}

/** A block of `type`, holding `text` when given. */
const block = (type: string, text?: string) => (node: Node) =>
  node.type.name === type && (text === undefined || node.textContent === text);

/** Type `text` at the editor's selection, as a key press does. */
function type(opened: WysiwygEditor, text: string): void {
  const view = viewOf(opened);
  view.dispatch(view.state.tr.insertText(text));
}

const IMAGE = "![](attachments/pic.png)";
const LINK_A = "[a.csv](attachments/a.csv)";
const LINK_B = "[b.csv](attachments/b.csv)";

describe("a file dropped on the document", () => {
  it("goes in at the block edge nearest the drop point, after earlier files of the drop", async () => {
    const opened = await open("First line.\n\nSecond line.\n\nThird line.\n");
    place(opened, block("paragraph", "First line."), 100, 130);
    place(opened, block("paragraph", "Second line."), 140, 170);
    place(opened, block("paragraph", "Third line."), 180, 210);

    // Low on the second line, nearer its bottom edge than its top.
    const target = opened.dropTargetAt(300, 162);
    opened.insertMarkdown("[a.csv](attachments/a.csv)", target);
    opened.insertMarkdown("[b.csv](attachments/b.csv)", target);

    expect(opened.getMarkdown()).toBe(
      "First line.\n\nSecond line.\n\n[a.csv](attachments/a.csv)\n\n[b.csv](attachments/b.csv)\n\nThird line.\n",
    );
  });

  it("goes in at the end for a drop below the document, filling Crepe's empty last line", async () => {
    const opened = await open("First line.\n\n- Item\n");
    place(opened, block("paragraph", "First line."), 100, 130);
    place(opened, block("bullet_list"), 140, 175);
    // The item's text is indented, so the end of its nearer edge is closer to
    // a point below the middle of the page than the end of any other edge.
    place(opened, block("paragraph", "Item"), 140, 175, 60);
    // Crepe's empty line to type on below the list.
    place(opened, (node) => node.type.name === "paragraph" && node.content.size === 0, 180, 200);

    // Below the document, on the empty part of the page.
    opened.insertMarkdown("[a.csv](attachments/a.csv)", opened.dropTargetAt(300, 400));

    // Mid-document, the empty line would be saved as "<br />".
    expect(opened.getMarkdown()).toBe("First line.\n\n- Item\n\n[a.csv](attachments/a.csv)\n");
  });

  it("goes in beside a table when the nearest edge is between its cells", async () => {
    const table = "| a | b |\n| - | - |\n| 1 | 2 |\n";
    const opened = await open(`First line.\n\n${table}`);
    place(opened, block("paragraph", "First line."), 100, 130);
    place(opened, block("table"), 140, 260);
    place(opened, block("table_cell", "1"), 200, 230);

    // On the bottom edge of the "1" cell.
    opened.insertMarkdown("[a.csv](attachments/a.csv)", opened.dropTargetAt(10, 229));

    // Inserted at the cell's edge, the link would get a new column of its own.
    expect(opened.getMarkdown()).toBe(`First line.\n\n${table}\n[a.csv](attachments/a.csv)\n`);
  });
});

describe("the caret after a file dropped on the document", () => {
  it("goes to the next line after an image, so typing does not replace the image", async () => {
    const opened = await open("First line.\n\nSecond line.\n\nThird line.\n");
    place(opened, block("paragraph", "First line."), 100, 130);
    place(opened, block("paragraph", "Second line."), 140, 170);
    place(opened, block("paragraph", "Third line."), 180, 210);

    opened.insertMarkdown(IMAGE, opened.dropTargetAt(300, 168));
    expect(viewOf(opened).state.selection).not.toBeInstanceOf(NodeSelection);
    type(opened, "x");

    expect(opened.getMarkdown()).toBe(`First line.\n\nSecond line.\n\n${IMAGE}\n\nxThird line.\n`);
  });

  it("goes to the empty line Crepe adds after an image that ends the document", async () => {
    const opened = await open("First line.\n\nSecond line.\n");
    place(opened, block("paragraph", "First line."), 100, 130);
    place(opened, block("paragraph", "Second line."), 140, 170);

    // Below the text.
    opened.insertMarkdown(IMAGE, opened.dropTargetAt(300, 400));
    expect(viewOf(opened).state.selection).toBeInstanceOf(TextSelection);
    type(opened, "x");

    expect(opened.getMarkdown()).toBe(`First line.\n\nSecond line.\n\n${IMAGE}\n\nx\n`);
  });

  it("goes after an image dropped at the caret at the end of the document", async () => {
    const opened = await open("First line.\n\nSecond line.\n");
    const view = viewOf(opened);
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));

    // A drop away from the text, such as on the toolbar.
    opened.insertMarkdown(IMAGE);
    expect(viewOf(opened).state.selection).not.toBeInstanceOf(NodeSelection);
    type(opened, "x");

    expect(opened.getMarkdown()).toBe(`First line.\n\nSecond line.\n\n${IMAGE}\n\nx\n`);
  });

  it("stays after a dropped link without extending it", async () => {
    const opened = await open("First line.\n\nSecond line.\n");
    place(opened, block("paragraph", "First line."), 100, 130);
    place(opened, block("paragraph", "Second line."), 140, 170);

    opened.insertMarkdown(LINK_A, opened.dropTargetAt(300, 128));
    type(opened, " typed");

    expect(opened.getMarkdown()).toBe(`First line.\n\n${LINK_A} typed\n\nSecond line.\n`);
  });
});

describe("a file dropped between list items", () => {
  const LIST = "Intro.\n\n- Item 1\n- Item 2\n- Item 3\n\nOutro.\n";

  /** Lay out the list's second item, its text indented 60px. */
  async function openList(markdown = LIST, item = "Item 2"): Promise<WysiwygEditor> {
    const opened = await open(markdown);
    place(opened, block("list_item", item), 140, 170);
    place(opened, block("paragraph", item), 140, 170, 60);
    return opened;
  }

  it("on the item's edge at the bullets, splits the list there, as Crepe does for a dropped block", async () => {
    const opened = await openList();

    opened.insertMarkdown(LINK_A, opened.dropTargetAt(20, 169));

    expect(opened.getMarkdown()).toBe(`Intro.\n\n- Item 1\n- Item 2\n\n${LINK_A}\n\n- Item 3\n\nOutro.\n`);
  });

  it("on the edge of the item's text, goes in as tight items of its own, in drop order", async () => {
    const opened = await openList();

    const target = opened.dropTargetAt(300, 169);
    opened.insertMarkdown(LINK_A, target);
    opened.insertMarkdown(LINK_B, target);

    expect(opened.getMarkdown()).toBe(`Intro.\n\n- Item 1\n- Item 2\n- ${LINK_A}\n- ${LINK_B}\n- Item 3\n\nOutro.\n`);
  });

  it("numbers a new item of a numbered list in turn", async () => {
    const opened = await openList("Intro.\n\n1. Step 1\n2. Step 2\n3. Step 3\n", "Step 1");

    opened.insertMarkdown(LINK_A, opened.dropTargetAt(300, 169));

    expect(opened.getMarkdown()).toBe(`Intro.\n\n1. Step 1\n2. ${LINK_A}\n3. Step 2\n4. Step 3\n`);
  });

  it("in a nested list, goes in as a nested item there and keeps the outer list tight", async () => {
    const opened = await open("Intro.\n\n- Parent\n  - N1\n  - N2\n- Next\n\nOutro.\n");
    place(opened, block("list_item", "N1"), 140, 170, 40);
    place(opened, block("paragraph", "N1"), 140, 170, 80);

    // At the nested bullets, between N1 and N2.
    opened.insertMarkdown(LINK_A, opened.dropTargetAt(50, 169));

    expect(opened.getMarkdown()).toBe(`Intro.\n\n- Parent\n  - N1\n  - ${LINK_A}\n  - N2\n- Next\n\nOutro.\n`);
  });
});

describe("drops whose files are still being read", () => {
  it("each go in where they were dropped", async () => {
    const opened = await open("First line.\n\nSecond line.\n\nThird line.\n");
    place(opened, block("paragraph", "First line."), 100, 130);
    place(opened, block("paragraph", "Second line."), 140, 170);
    place(opened, block("paragraph", "Third line."), 180, 210);

    const first = opened.dropTargetAt(300, 128);
    const second = opened.dropTargetAt(300, 208);
    // The second drop's file is read first.
    opened.insertMarkdown(LINK_B, second);
    opened.insertMarkdown(LINK_A, first);

    expect(opened.getMarkdown()).toBe(`First line.\n\n${LINK_A}\n\nSecond line.\n\nThird line.\n\n${LINK_B}\n`);
  });

  it("keeps a drop's place when the split mirrors a Markdown edit into the document", async () => {
    const opened = await open("First line.\n\nSecond line.\n\nThird line.\n");
    place(opened, block("paragraph", "First line."), 100, 130);
    place(opened, block("paragraph", "Second line."), 140, 170);

    const target = opened.dropTargetAt(300, 128);
    // Typed in the Markdown pane while the file is read.
    opened.setMarkdown("First line.\n\nSecond line.\n\nThird line. Typed.\n");
    opened.insertMarkdown(LINK_A, target);

    expect(opened.getMarkdown()).toBe(`First line.\n\n${LINK_A}\n\nSecond line.\n\nThird line. Typed.\n`);
  });
});

describe("a file dropped away from the document text", () => {
  it("goes in after the selected text, such as the find card's match, not over it", async () => {
    const opened = await open("First line.\n\nSecond line.\n");
    const view = viewOf(opened);
    // "line." in "First line."
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7, 12)));

    opened.insertMarkdown(LINK_A);

    expect(opened.getMarkdown()).toBe(`First line.\n\n${LINK_A}\n\nSecond line.\n`);
  });

  it("goes in after a selected image, not over it", async () => {
    const opened = await open(`First line.\n\n${IMAGE}\n\nSecond line.\n`);
    const view = viewOf(opened);
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, view.state.doc.child(0).nodeSize)));

    opened.insertMarkdown(LINK_A);

    expect(opened.getMarkdown()).toBe(`First line.\n\n${IMAGE}\n\n${LINK_A}\n\nSecond line.\n`);
  });
});
