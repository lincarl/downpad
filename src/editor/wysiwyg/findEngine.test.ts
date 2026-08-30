import { describe, it, expect } from "vitest";
import { findMatchRanges, type FindOptions } from "./findEngine";

const opts = (over: Partial<FindOptions> = {}): FindOptions => ({
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  ...over,
});

describe("findMatchRanges", () => {
  it("finds all case-insensitive matches by default", () => {
    expect(findMatchRanges("The cat sat on the cat", "cat", opts())).toEqual([
      { from: 4, to: 7 },
      { from: 19, to: 22 },
    ]);
    expect(findMatchRanges("Cat cat CAT", "cat", opts())).toHaveLength(3);
  });

  it("respects case sensitivity", () => {
    expect(findMatchRanges("Cat cat CAT", "cat", opts({ caseSensitive: true }))).toEqual([
      { from: 4, to: 7 },
    ]);
  });

  it("respects whole-word matching", () => {
    expect(findMatchRanges("cat category scatter", "cat", opts({ wholeWord: true }))).toEqual([
      { from: 0, to: 3 },
    ]);
  });

  it("treats the query literally unless regex is on", () => {
    expect(findMatchRanges("a.b a-b axb", "a.b", opts())).toEqual([{ from: 0, to: 3 }]);
    // With regex, '.' matches any char → all three.
    expect(findMatchRanges("a.b a-b axb", "a.b", opts({ regex: true }))).toHaveLength(3);
  });

  it("returns nothing for empty query or invalid regex", () => {
    expect(findMatchRanges("abc", "", opts())).toEqual([]);
    expect(findMatchRanges("abc", "(", opts({ regex: true }))).toEqual([]);
  });

  it("does not loop forever on zero-width regex matches", () => {
    const ranges = findMatchRanges("abc", "x*", opts({ regex: true }));
    expect(ranges).toEqual([]); // all matches are zero-width and skipped
  });
});
