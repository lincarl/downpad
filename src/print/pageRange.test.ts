import { describe, expect, it } from "vitest";
import { pageRangeError } from "./pageRange";

describe("pageRangeError", () => {
  it("accepts pages and ranges that exist", () => {
    expect(pageRangeError("1", 5)).toBeNull();
    expect(pageRangeError("1-3, 5", 5)).toBeNull();
    expect(pageRangeError(" 2 - 2 ,4", 5)).toBeNull();
  });

  it("names the page count when a page is past the end", () => {
    expect(pageRangeError("4-6", 5)).toBe("This document has 5 pages.");
    expect(pageRangeError("2", 1)).toBe("This document has 1 page.");
  });

  it("rejects text that is not a page range", () => {
    for (const range of ["", "a", "1-", "1,,2", "1-2-3", "1.5"]) {
      expect(pageRangeError(range, 5)).toBe("Use page numbers and ranges, such as 1-3, 5.");
    }
  });

  it("rejects page 0 and ranges written high to low", () => {
    expect(pageRangeError("0-2", 5)).toBe("Page numbers start at 1.");
    expect(pageRangeError("4-2", 5)).toBe("Write ranges from low to high, such as 2-4.");
  });

  it("checks only the syntax before the pages are laid out", () => {
    expect(pageRangeError("40", 0)).toBeNull();
    expect(pageRangeError("x", 0)).not.toBeNull();
  });
});
