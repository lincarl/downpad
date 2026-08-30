import { describe, it, expect } from "vitest";
import { findSpecialDashes, codePointLabel, SPECIAL_DASHES } from "./specialDash";

describe("findSpecialDashes", () => {
  it("ignores a plain ASCII hyphen-minus (the normal dash)", () => {
    expect(findSpecialDashes("Luciro PDF - Design")).toEqual([]);
    expect(findSpecialDashes("a-b-c-d-e")).toEqual([]);
  });

  it("flags an em dash with its offset and name", () => {
    // "Luciro PDF — Design": the em dash is at index 11.
    const hits = findSpecialDashes("Luciro PDF — Design");
    expect(hits).toEqual([{ from: 11, ch: "—", name: "Em dash" }]);
  });

  it("flags en dash, figure dash, horizontal bar, and minus sign", () => {
    expect(findSpecialDashes("–").map((h) => h.name)).toEqual(["En dash"]);
    expect(findSpecialDashes("‒").map((h) => h.name)).toEqual(["Figure dash"]);
    expect(findSpecialDashes("―").map((h) => h.name)).toEqual(["Horizontal bar"]);
    expect(findSpecialDashes("−").map((h) => h.name)).toEqual(["Minus sign"]);
  });

  it("finds every special dash in a mixed line and skips the hyphen", () => {
    // "one - two — three – four": hyphen (skip), em dash @10, en dash @18.
    const hits = findSpecialDashes("one - two — three – four");
    expect(hits).toEqual([
      { from: 10, ch: "—", name: "Em dash" },
      { from: 18, ch: "–", name: "En dash" },
    ]);
  });

  it("applies the base offset (for non-zero visible ranges)", () => {
    const hits = findSpecialDashes("x—y", 100);
    expect(hits).toEqual([{ from: 101, ch: "—", name: "Em dash" }]);
  });

  it("returns an empty list for text with no dashes", () => {
    expect(findSpecialDashes("")).toEqual([]);
    expect(findSpecialDashes("no dashes here")).toEqual([]);
  });
});

describe("codePointLabel", () => {
  it("formats as zero-padded U+ hex", () => {
    expect(codePointLabel("—")).toBe("U+2014");
    expect(codePointLabel("–")).toBe("U+2013");
    expect(codePointLabel("−")).toBe("U+2212");
  });
});

describe("SPECIAL_DASHES", () => {
  it("does not include the plain ASCII hyphen-minus", () => {
    expect(SPECIAL_DASHES["-"]).toBeUndefined();
  });
});
