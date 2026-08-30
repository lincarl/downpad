import { describe, it, expect } from "vitest";
import {
  fileName,
  dirName,
  relativeDate,
  absoluteDate,
  formatDate,
  formatSize,
  filterByName,
  favoritesSorted,
} from "./recentFormat";
import type { RecentEntry } from "../state/types";

// Build timestamps with the *local* Date constructor so calendar-day math is
// timezone-stable in CI (both `now` and the entry share the local zone).
const local = (y: number, m: number, d: number, h = 12): number =>
  new Date(y, m, d, h, 0, 0).getTime();

const entry = (path: string, favorite = false, lastOpenedMs = 0): RecentEntry => ({
  path,
  lastOpenedMs,
  favorite,
});

describe("fileName / dirName", () => {
  it("takes the final segment for Windows and POSIX paths", () => {
    expect(fileName("C:\\Users\\me\\draft.md")).toBe("draft.md");
    expect(fileName("C:/Users/me/notes.markdown")).toBe("notes.markdown");
    expect(fileName("bare.md")).toBe("bare.md");
  });

  it("returns the parent folder", () => {
    expect(dirName("C:\\Users\\me\\draft.md")).toBe("C:\\Users\\me");
    expect(dirName("C:/Users/me/notes.md")).toBe("C:/Users/me");
  });

  it("keeps the separator for a root-level parent (so it stays absolute)", () => {
    expect(dirName("C:\\file.md")).toBe("C:\\");
    expect(dirName("C:/file.md")).toBe("C:/");
    expect(dirName("/file.md")).toBe("/");
    expect(dirName("bare.md")).toBe("");
  });
});

describe("relativeDate", () => {
  const now = local(2026, 5, 3); // 3 Jun 2026

  it("labels today, yesterday, and recent days", () => {
    expect(relativeDate(local(2026, 5, 3, 9), now)).toBe("Today");
    expect(relativeDate(local(2026, 5, 2), now)).toBe("Yesterday");
    expect(relativeDate(local(2026, 4, 29), now)).toBe("5 days ago");
  });

  it("rolls up to weeks, months, and years", () => {
    expect(relativeDate(local(2026, 4, 20), now)).toBe("2 weeks ago");
    expect(relativeDate(local(2026, 2, 3), now)).toBe("3 months ago");
    expect(relativeDate(local(2025, 5, 3), now)).toBe("1 year ago");
  });

  it("clamps future timestamps to Today", () => {
    expect(relativeDate(local(2026, 5, 10), now)).toBe("Today");
  });
});

describe("absoluteDate / formatDate", () => {
  it("formats as D Mon YYYY", () => {
    expect(absoluteDate(local(2026, 5, 3))).toBe("3 Jun 2026");
    expect(absoluteDate(local(2026, 0, 15))).toBe("15 Jan 2026");
  });

  it("combines relative and absolute", () => {
    const now = local(2026, 5, 3);
    expect(formatDate(local(2026, 5, 3, 8), now)).toBe("Today · 3 Jun 2026");
  });
});

describe("formatSize", () => {
  it("formats bytes, KB, MB", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(12 * 1024)).toBe("12 KB");
    expect(formatSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  it("returns empty for invalid sizes", () => {
    expect(formatSize(-1)).toBe("");
    expect(formatSize(NaN)).toBe("");
  });
});

describe("filterByName", () => {
  const entries = [entry("C:/n/draft.md"), entry("C:/n/meeting-notes.md"), entry("C:/n/README.md")];

  it("matches the filename case-insensitively", () => {
    expect(filterByName(entries, "draft").map((e) => e.path)).toEqual(["C:/n/draft.md"]);
    expect(filterByName(entries, "ME").map((e) => fileName(e.path))).toEqual(["meeting-notes.md", "README.md"]);
  });

  it("returns everything for an empty query", () => {
    expect(filterByName(entries, "  ")).toHaveLength(3);
  });

  it("ignores the parent folder name", () => {
    // The folder "n" is in every path; matching by folder would return all 3.
    // Filename-only matching returns just "meeting-notes.md".
    expect(filterByName(entries, "n").map((e) => fileName(e.path))).toEqual(["meeting-notes.md"]);
  });
});

describe("favoritesSorted", () => {
  it("keeps only favorites, alphabetical by filename, case-insensitive", () => {
    const entries = [
      entry("C:/n/zebra.md", true),
      entry("C:/n/Apple.md", true),
      entry("C:/n/mango.md", false),
      entry("C:/n/banana.md", true),
    ];
    expect(favoritesSorted(entries).map((e) => fileName(e.path))).toEqual([
      "Apple.md",
      "banana.md",
      "zebra.md",
    ]);
  });
});
