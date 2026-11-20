import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { markdownSource } from "./markdownSource";
import { sourceOutline } from "./rowAlignment";
import type { OutlineBlock } from "../splitAlign";

/** The outline of `text`, one block a line as kind, line number and key,
 *  with children indented below their block. */
function outline(text: string): string[] {
  const state = EditorState.create({ doc: text, extensions: [markdownSource()] });
  // The outline waits only 25 ms for the parser, and covers what the parser
  // has read by then. On a busy machine the first parse of a test run can
  // take longer, so the parse is finished here before the outline is read.
  if (!ensureSyntaxTree(state, state.doc.length, 30_000)) throw new Error("The parser did not reach the end of the text.");
  const lines: string[] = [];
  const visit = (blocks: readonly OutlineBlock[], depth: number): void => {
    for (const block of blocks) {
      lines.push(`${"  ".repeat(depth)}${block.kind}@${state.doc.lineAt(block.at).number} ${block.key}`);
      if (block.children) visit(block.children, depth + 1);
    }
  };
  visit(sourceOutline(state).outline, 0);
  return lines;
}

describe("sourceOutline", () => {
  it("lists the blocks the document view shows, each at the start of its first line", () => {
    const text = [
      "---\ntitle: Notes\n---",
      "# Heading one",
      "A paragraph.",
      "```ts\nconst answer = 42;\n```",
      "$$\nE = mc^2\n$$",
      "[ref]: https://example.com",
      "[^1]: A footnote.",
      "---",
      "<!-- comment -->",
    ].join("\n\n");
    expect(outline(text)).toEqual([
      "frontmatter@1 titlenotes",
      "heading@5 headingone",
      "paragraph@7 aparagraph",
      // The fence lines are left out of the key.
      "code@9 constanswer42",
      "math@13 emc2",
      // The link reference definition is not shown, but the footnote is.
      "footnote@19 1afootnote",
      "rule@21 ",
      // The document view shows no text for a comment.
      "html@23 ",
    ]);
  });

  it("keys blocks by the text the document view shows, without link targets or HTML tags", () => {
    const text = [
      "[See the guide](https://example.com/guide) for more.",
      "![Chart of sales](chart.png)",
      "Read [the notes][notes] first.",
      "<https://example.com> is the site.",
      "<span>Tagged</span> text.",
    ].join("\n\n");
    expect(outline(text)).toEqual([
      "paragraph@1 seetheguideformo",
      "paragraph@3 chartofsales",
      "paragraph@5 readthenotesfirs",
      "paragraph@7 httpsexamplecomi",
      "paragraph@9 taggedtext",
    ]);
  });

  it("lists list items, quote blocks and table rows inside their blocks", () => {
    const text = [
      "- One\n- [ ] Two\n  - Nested",
      "1. First\n2. Second",
      "> Quoted\n>\n> Again",
      "| A | B |\n| --- | --- |\n| 1 | 2 |",
    ].join("\n\n");
    expect(outline(text)).toEqual([
      "list@1 onetwonested",
      "  item@1 one",
      "    paragraph@1 one",
      "  item@2 twonested",
      "    paragraph@2 two",
      "    list@3 nested",
      "      item@3 nested",
      "        paragraph@3 nested",
      // Ordered items key by their text, not their numbers.
      "list@5 firstsecond",
      "  item@5 first",
      "    paragraph@5 first",
      "  item@6 second",
      "    paragraph@6 second",
      "quote@8 quotedagain",
      "  paragraph@8 quoted",
      "  paragraph@10 again",
      // The delimiter row is no row of the document.
      "table@12 ab12",
      "  row@12 ab",
      "  row@14 12",
    ]);
  });
});
