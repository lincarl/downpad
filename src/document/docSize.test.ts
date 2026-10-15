import { describe, it, expect } from "vitest";
import { byteLength, formatSize } from "./docSize";

describe("byteLength", () => {
  it("counts ASCII as one byte each", () => {
    expect(byteLength("hello")).toBe(5);
  });
  it("counts multi-byte UTF-8 characters by their encoded length", () => {
    expect(byteLength("é")).toBe(2); // U+00E9 → 2 bytes
    expect(byteLength("😀")).toBe(4); // astral plane → 4 bytes
  });
  it("is zero for the empty string", () => {
    expect(byteLength("")).toBe(0);
  });
});

describe("formatSize", () => {
  it("never goes below KB, and shows one decimal under 10", () => {
    expect(formatSize(407)).toBe("0.4 KB");
    expect(formatSize(5120)).toBe("5.0 KB");
    expect(formatSize(12_345)).toBe("12 KB");
  });
  it("keeps a small file from reading as empty", () => {
    expect(formatSize(0)).toBe("0 KB");
    expect(formatSize(20)).toBe("0.1 KB");
  });
  it("moves to MB and GB at 1024 of the unit below", () => {
    expect(formatSize(1023 * 1024)).toBe(`${(1023).toLocaleString()} KB`);
    expect(formatSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatSize(3 * 1024 ** 3)).toBe("3.0 GB");
    // Thousands separator follows the runtime locale (matches the word count).
    expect(formatSize(2048 * 1024 ** 3)).toBe(`${(2048).toLocaleString()} GB`);
  });
  it("returns empty for invalid sizes", () => {
    expect(formatSize(-1)).toBe("");
    expect(formatSize(NaN)).toBe("");
  });
});
