import { describe, expect, it, vi } from "vitest";
import { Schema, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { SourceBaseline, alignBlocks, increasingRun } from "./sourceBaseline";

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
    const baseline = new SourceBaseline("A  \n\nB\n", opened, { serialize, parse });
    expect(baseline.write(opened)).toBe("A  \n\nB\n");
    expect(baseline.write(doc("A", "B2"))).toBe("A\n\nB2\n");
    expect(baseline.write(doc("A", "B3"))).toBe("A\n\nB3\n");
    expect(parse).toHaveBeenCalledTimes(1);
  });
});
