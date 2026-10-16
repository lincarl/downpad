import { describe, expect, it } from "vitest";
import { alignBlocks } from "./sourceBaseline";

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

  it("pairs a long changed stretch by position", () => {
    const baseline = Array.from({ length: 1_100 }, (_, i) => `block ${i}`);
    const current = baseline.map((block, i) => (i % 100 === 0 || i === 1_099 ? `${block} changed` : block));
    expect(alignBlocks(current, baseline)).toEqual(baseline.map((_, i) => (i % 100 === 0 || i === 1_099 ? -1 : i)));
  });
});
