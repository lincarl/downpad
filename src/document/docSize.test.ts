import { describe, it, expect } from "vitest";
import { byteLength, formatKB } from "./docSize";

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

describe("formatKB", () => {
  it("shows one decimal under 10 KB", () => {
    expect(formatKB(512)).toBe("0.5 KB");
    expect(formatKB(5120)).toBe("5.0 KB");
  });
  it("rounds to a whole number at 10 KB and above", () => {
    expect(formatKB(12_345)).toBe("12 KB");
    // Thousands separator follows the runtime locale (matches the word count).
    expect(formatKB(1_048_576)).toBe(`${(1024).toLocaleString()} KB`);
  });
});
