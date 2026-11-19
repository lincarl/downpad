import { Schema, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { describe, expect, it } from "vitest";
import { docOutline } from "./rowAlignment";
import type { OutlineBlock } from "../splitAlign";

/** The node names of Milkdown's schema that the outline reads. */
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    text: { group: "inline" },
    paragraph: { group: "block", content: "inline*" },
    heading: { group: "block", content: "inline*" },
    code_block: { group: "block", content: "text*", attrs: { language: { default: "" } } },
    "image-block": { group: "block", atom: true },
    hr: { group: "block" },
    blockquote: { group: "block", content: "block+" },
    bullet_list: { group: "block", content: "list_item+" },
    list_item: { content: "block+" },
    table: { group: "block", content: "table_header_row table_row*" },
    table_header_row: { content: "table_header+" },
    table_row: { content: "table_cell+" },
    table_header: { content: "paragraph+" },
    table_cell: { content: "paragraph+" },
  },
});

const p = (text = "") => schema.node("paragraph", null, text ? [schema.text(text)] : []);
const cell = (type: "table_header" | "table_cell", text: string) => schema.node(type, null, [p(text)]);

/** The outline, one block a line as kind, position, key and the flags for
 *  space and text, with children indented below their block. */
function outline(doc: ProseNode, frontmatter = false): string[] {
  const lines: string[] = [];
  const visit = (blocks: readonly OutlineBlock[], depth: number): void => {
    for (const block of blocks) {
      lines.push(`${"  ".repeat(depth)}${block.kind}@${block.at} ${block.key}${block.spaceable ? " space" : ""}${block.text ? " text" : ""}`);
      if (block.children) visit(block.children, depth + 1);
    }
  };
  visit(docOutline(doc, frontmatter), 0);
  return lines;
}

describe("docOutline", () => {
  it("lists the frontmatter disclosure and the blocks, without Crepe's empty last line", () => {
    const doc = schema.node("doc", null, [
      schema.node("heading", null, [schema.text("Title")]),
      schema.node("code_block", { language: "ts" }, [schema.text("let x = 1;")]),
      schema.node("code_block", { language: "LaTeX" }, [schema.text("E = mc^2")]),
      schema.node("image-block"),
      schema.node("hr"),
      p(),
    ]);
    expect(outline(doc, true)).toEqual([
      "frontmatter@-1  space text",
      "heading@0 title space text",
      // Code, formulas, images and rules line up by their tops.
      "code@7 letx1 space",
      "math@19 emc2 space",
      "image@29  space",
      "rule@30  space",
    ]);
  });

  it("lists list items, quote blocks and table rows, which take no space above a first child or a row", () => {
    const doc = schema.node("doc", null, [
      schema.node("bullet_list", null, [
        schema.node("list_item", null, [p("One")]),
        schema.node("list_item", null, [p("Two"), schema.node("bullet_list", null, [schema.node("list_item", null, [p("Nested")])])]),
      ]),
      schema.node("blockquote", null, [p("Quoted"), p("Again")]),
      schema.node("table", null, [
        schema.node("table_header_row", null, [cell("table_header", "A"), cell("table_header", "B")]),
        schema.node("table_row", null, [cell("table_cell", "1"), cell("table_cell", "2")]),
      ]),
    ]);
    expect(outline(doc)).toEqual([
      "list@0 onetwonested space text",
      "  item@1 one text",
      "    paragraph@2 one text",
      "  item@8 twonested space text",
      "    paragraph@9 two text",
      "    list@14 nested space text",
      "      item@15 nested text",
      "        paragraph@16 nested text",
      "quote@28 quotedagain space text",
      "  paragraph@29 quoted text",
      "  paragraph@37 again space text",
      "table@45 ab12 space text",
      "  row@46 ab text",
      "  row@58 12 text",
    ]);
  });

  it("lines a table row up by its first cell with text, as the cells share the row's line", () => {
    const doc = schema.node("doc", null, [
      schema.node("table", null, [
        schema.node("table_header_row", null, [cell("table_header", ""), cell("table_header", "Mon")]),
        schema.node("table_row", null, [cell("table_cell", ""), cell("table_cell", "x")]),
      ]),
    ]);
    expect(outline(doc)).toEqual([
      "table@0 monx space text",
      "  row@1 mon text",
      "  row@14 x text",
    ]);
  });

  it("lines a block up by its top when its first line holds no text, though text follows", () => {
    const doc = schema.node("doc", null, [
      schema.node("table", null, [
        schema.node("table_header_row", null, [cell("table_header", ""), cell("table_header", "")]),
        schema.node("table_row", null, [cell("table_cell", "A"), cell("table_cell", "B")]),
      ]),
      schema.node("bullet_list", null, [
        schema.node("list_item", null, [schema.node("code_block", null, [schema.text("code")]), p("After")]),
      ]),
    ]);
    expect(outline(doc)).toEqual([
      "table@0 ab space",
      "  row@1 ",
      "  row@11 ab text",
      "list@24 codeafter space",
      "  item@25 codeafter",
      "    code@26 code",
      "    paragraph@32 after space text",
    ]);
  });
});
