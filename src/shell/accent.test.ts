import { describe, it, expect } from "vitest";
import { DEFAULT_ACCENT, normalizeHex, readableForeground } from "./accent";

describe("normalizeHex", () => {
  it("passes through #rrggbb (lowercased)", () => {
    expect(normalizeHex("#0067C0")).toBe("#0067c0");
  });

  it("accepts a missing # and shorthand #rgb", () => {
    expect(normalizeHex("ff8800")).toBe("#ff8800");
    expect(normalizeHex("#f80")).toBe("#ff8800");
    expect(normalizeHex("abc")).toBe("#aabbcc");
  });

  it("rejects non-hex input", () => {
    expect(normalizeHex("blue")).toBeNull();
    expect(normalizeHex("#12")).toBeNull();
    expect(normalizeHex("#1234567")).toBeNull();
    expect(normalizeHex("")).toBeNull();
    expect(normalizeHex(null)).toBeNull();
    expect(normalizeHex(undefined)).toBeNull();
  });
});

describe("readableForeground", () => {
  it("uses white text on the default blue accent (unchanged behavior)", () => {
    expect(readableForeground(DEFAULT_ACCENT)).toBe("#ffffff");
  });

  it("uses white on dark accents and dark text on light accents", () => {
    expect(readableForeground("#000000")).toBe("#ffffff");
    expect(readableForeground("#1e1e1e")).toBe("#ffffff");
    expect(readableForeground("#ffffff")).toBe("#1a1a1a");
    expect(readableForeground("#ffd400")).toBe("#1a1a1a"); // bright yellow
  });

  it("falls back to white for invalid colors", () => {
    expect(readableForeground("not-a-color")).toBe("#ffffff");
  });
});
