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

  it("treats letters outside ASCII as part of a word", () => {
    const text = "Det är året. Här är m och möjlig.";
    // Not the "är" inside "Här", and not the "m" that starts "möjlig".
    expect(findMatchRanges(text, "är", opts({ wholeWord: true }))).toEqual([
      { from: 4, to: 6 },
      { from: 17, to: 19 },
    ]);
    expect(findMatchRanges(text, "året", opts({ wholeWord: true }))).toEqual([{ from: 7, to: 11 }]);
    expect(findMatchRanges(text, "m", opts({ wholeWord: true }))).toEqual([{ from: 20, to: 21 }]);
    expect(findMatchRanges(text, "möj", opts({ wholeWord: true }))).toEqual([]);
  });

  it("lets a whole-word query start or end with punctuation", () => {
    expect(findMatchRanges("a -flag b", "-flag", opts({ wholeWord: true }))).toEqual([{ from: 2, to: 7 }]);
    expect(findMatchRanges("x-flag", "-flag", opts({ wholeWord: true }))).toEqual([{ from: 1, to: 6 }]);
    expect(findMatchRanges("a -flags", "-flag", opts({ wholeWord: true }))).toEqual([]);
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
