import { describe, it, expect } from "vitest";
import { middleTruncate } from "./linkView";

describe("middleTruncate", () => {
  it("leaves short URLs unchanged", () => {
    expect(middleTruncate("https://anthropic.com")).toBe("https://anthropic.com");
  });

  it("middle-truncates long URLs with an ellipsis", () => {
    const long = "https://example.com/some/very/long/path/that/keeps/going?q=1&r=2#frag";
    const out = middleTruncate(long, 30);
    expect(out.length).toBe(30);
    expect(out).toContain("…");
    expect(out.startsWith("https://")).toBe(true);
    expect(out.endsWith("frag")).toBe(true);
  });

  it("respects an exact-length boundary", () => {
    const url = "x".repeat(42);
    expect(middleTruncate(url, 42)).toBe(url);
    expect(middleTruncate(url + "y", 42)).toContain("…");
  });
});
