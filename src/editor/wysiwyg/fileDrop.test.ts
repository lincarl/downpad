// @vitest-environment jsdom
// A file dropped on the document goes in at the block edge nearest the drop
// point, the edge Crepe's drop indicator marks. These tests use the real editor
// with a laid-out page, which jsdom cannot measure, given to its blocks.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import type { Node } from "@milkdown/kit/prose/model";
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
