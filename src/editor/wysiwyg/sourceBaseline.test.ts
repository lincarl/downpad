import { describe, expect, it, vi } from "vitest";
import { Schema, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { SourceBaseline, alignBlocks, apart, increasingRun, writtenEnding } from "./sourceBaseline";

describe("alignBlocks", () => {
  it("pairs the blocks an edit left alone", () => {
    expect(alignBlocks(["a", "B", "c"], ["a", "b", "c"])).toEqual([0, -1, 2]);
    expect(alignBlocks(["a", "new", "b"], ["a", "b"])).toEqual([0, -1, 1]);
    expect(alignBlocks(["a", "c"], ["a", "b", "c"])).toEqual([0, 2]);
    expect(alignBlocks(["a1", "a2", "b"], ["a", "b"])).toEqual([-1, -1, 1]);
  });

  it("pairs repeated blocks in order", () => {
    expect(alignBlocks(["---", "p", "---"], ["---", "q", "p", "---"])).toEqual([0, 2, 3]);
    expect(alignBlocks(["p", "---"], ["---", "p", "---"])).toEqual([1, 2]);
  });

  it("never pairs different blocks or pairs out of order", () => {
    expect(alignBlocks(["x"], ["y"])).toEqual([-1]);
    expect(alignBlocks([], ["y"])).toEqual([]);
    expect(alignBlocks(["x"], [])).toEqual([-1]);
    const swapped = alignBlocks(["b", "a"], ["a", "b"]);
    expect(swapped.filter((pair) => pair >= 0)).toHaveLength(1);
  });

  it("leaves a changed stretch too long to compare unpaired, not shifted", () => {
    const baseline = Array.from({ length: 1_100 }, (_, i) => `block ${i}`);
    // One block added near the start, and one changed near the end.
    const current = ["block 0", "new", ...baseline.slice(1, 1_098), "changed", "block 1099"];
    const pairs = alignBlocks(current, baseline);
    expect(pairs.slice(0, 2)).toEqual([0, -1]);
    expect(pairs.slice(-2)).toEqual([-1, 1_099]);
    expect(pairs.slice(2, -2).every((pair) => pair === -1)).toBe(true);
  });
});

describe("increasingRun", () => {
  it("keeps the longest run of indices in order", () => {
    expect(increasingRun([0, 1, 2])).toEqual([0, 1, 2]);
    expect(increasingRun([0, -1, 2])).toEqual([0, -1, 2]);
    // A block moved from the end to the start.
    expect(increasingRun([3, 0, 1, 2])).toEqual([-1, 0, 1, 2]);
    // A block moved from the start to the end.
    expect(increasingRun([1, 2, 3, 0])).toEqual([1, 2, 3, -1]);
    expect(increasingRun([-1, -1])).toEqual([-1, -1]);
  });
});

describe("apart", () => {
  it("starts a block afresh where the parser always does", () => {
    expect(apart("line", "# Title", "\n", "    code")).toBe(true);
    expect(apart("blank", "Text.", "\n\n", "3. third")).toBe(true);
    expect(apart("blank", "[d]: https://d.example", "\n", "## Next")).toBe(true);
    expect(apart("html", "<div>", "\n \n", "plain")).toBe(true);
    expect(apart("list", "- a", "\n\n", "* b")).toBe(true);
    expect(apart("list", "1. a", "\n\n", "2) b")).toBe(true);
    expect(apart("footnote", "[^1]: Note.", "\n\n", "  two")).toBe(false);
    expect(apart("footnote", "[^1]: Note.", "\n\n", "Text.")).toBe(true);
    expect(apart("indented", "    code", "\n", "# Next")).toBe(true);
  });

  it("leaves the rest to reading back", () => {
    // Under a definition, the list, the code and the HTML would read as a paragraph.
    expect(apart("blank", "[d]: https://d.example", "\n", "3. third")).toBe(false);
    expect(apart("blank", "[d]: https://d.example", "\n", "    code")).toBe(false);
    expect(apart("blank", "Text.", "\n", "<custom-tag>")).toBe(false);
    // An HTML block that starts with a tag goes on past a heading.
    expect(apart("html", "<div>", "\n", "# Next")).toBe(false);
    // A list takes in more of its items and indented lines.
    expect(apart("list", "- a", "\n\n", "- b")).toBe(false);
    expect(apart("list", "1. a", "\n\n", "3. b")).toBe(false);
    expect(apart("list", "- a", "\n\n", "    code")).toBe(false);
    expect(apart("list", "- a", "\n", "<br />")).toBe(false);
    // After indented code, a list that does not start at 1 reads as a paragraph.
    expect(apart("indented", "    code", "\n\n", "3. third")).toBe(false);
    expect(apart("open", "```js\nlet x", "\n\n", "# Next")).toBe(false);
    // With no line break between them, the two share a line.
    expect(apart("line", "# Title", "", "- item")).toBe(false);
  });
});

describe("writtenEnding", () => {
  it("tells what ends forms the parser can read only one way", () => {
    expect(writtenEnding("# Title")).toBe("line");
    expect(writtenEnding("---")).toBe("line");
    expect(writtenEnding("```js\nlet x\n```")).toBe("line");
    expect(writtenEnding("$$\nx^2\n$$")).toBe("line");
    expect(writtenEnding("<br />")).toBe("html");
    expect(writtenEnding("Some *text*\\\nand 2026 more.")).toBe("blank");
    expect(writtenEnding("| a |\n| - |\n| 1 |")).toBe("blank");
    expect(writtenEnding("> quote\n>\n> more")).toBe("blank");
    expect(writtenEnding("- a\n  more\n\n  - b\n- c")).toBe("list");
    expect(writtenEnding("10. ten\n    more")).toBe("list");
    expect(writtenEnding("[^1]: Note.\n\n    More.")).toBe("footnote");
  });

  it("leaves forms that could read another way open", () => {
    // A heading with a line break, written in setext form, could start like HTML.
    expect(writtenEnding("<!--\nTODO\n-->\n===")).toBe("open");
    expect(writtenEnding("Line\\\nnext\n====")).toBe("open");
    expect(writtenEnding("<span>x</span> text")).toBe("open");
    expect(writtenEnding("$x$ text")).toBe("open");
    expect(writtenEnding("Text\n1. item")).toBe("open");
    expect(writtenEnding("```\ncode\n```\nmore\n```")).toBe("open");
    // A line less indented than its item's text would leave the list.
    expect(writtenEnding("10. ten\n\n   more")).toBe("open");
    expect(writtenEnding("- a\nlazy")).toBe("open");
  });
});

/** A document of paragraphs, and a stand-in for Milkdown's form of it, which
 *  writes each paragraph's text with a blank line between. */
const schema = new Schema({ nodes: { doc: { content: "block+" }, paragraph: { group: "block", content: "text*" }, text: {} } });
const doc = (...texts: string[]) => schema.node("doc", null, texts.map((text) => schema.node("paragraph", null, text ? [schema.text(text)] : [])));
const serialize = (written: ProseNode) => {
  const texts: string[] = [];
  written.forEach((block) => texts.push(block.textContent));
  return `${texts.join("\n\n")}\n`;
};

describe("SourceBaseline", () => {
  it("parses the source once, even when the parser fails", () => {
    const parse = vi.fn((): never => {
      throw new Error("cannot parse");
    });
    const opened = doc("A", "B");
    // The source writes "A" with two spaces after it, which Milkdown's form leaves out.
    const toDoc = vi.fn((): never => {
      throw new Error("nothing to read back");
    });
    const baseline = new SourceBaseline("A  \n\nB\n", opened, { serialize, parse, toDoc });
    expect(baseline.write(opened)).toBe("A  \n\nB\n");
    expect(baseline.write(doc("A", "B2"))).toBe("A\n\nB2\n");
    expect(baseline.write(doc("A", "B3"))).toBe("A\n\nB3\n");
    expect(parse).toHaveBeenCalledTimes(1);
  });
});
