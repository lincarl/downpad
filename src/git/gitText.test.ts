import { describe, expect, it } from "vitest";
import { listFiles, myVersionPath, timeAgo } from "./gitText";

describe("gitText", () => {
  it("says how long ago a change was", () => {
    const now = Date.UTC(2026, 10, 3, 12);
    expect(timeAgo(now - 20_000, now)).toBe("just now");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(timeAgo(now - 26 * 60 * 60_000, now)).toBe("yesterday");
  });

  it("names the user's version beside the original", () => {
    expect(myVersionPath("/work/notes.md")).toBe("/work/notes (my version).md");
    expect(myVersionPath("C:\\work\\README")).toBe("C:\\work\\README (my version).md");
  });

  it("lists file names", () => {
    expect(listFiles(["/a/x.md", "/a/y.md"])).toBe("x.md and y.md");
    expect(listFiles(["/x.md", "/y.md", "/z.md", "/w.md"])).toBe("x.md, y.md and 2 more");
  });
});
