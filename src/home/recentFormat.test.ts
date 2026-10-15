import { describe, it, expect } from "vitest";
import {
  fileName,
  dirName,
  relativeDate,
  absoluteDate,
  formatDate,
  filterByName,
  plainSnippet,
} from "./recentFormat";
import type { RecentEntry } from "../state/types";

// Build timestamps with the *local* Date constructor so calendar-day math is
// timezone-stable in CI (both `now` and the entry share the local zone).
const local = (y: number, m: number, d: number, h = 12): number =>
  new Date(y, m, d, h, 0, 0).getTime();

const entry = (path: string): RecentEntry => ({ path, lastOpenedMs: 0, favorite: false });

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

describe("plainSnippet", () => {
  it("reads table rows, headings, quotes and list items as plain text", () => {
    expect(plainSnippet("| Print | Grace | Planned |")).toBe("Print · Grace · Planned");
    expect(plainSnippet("| --- | :---: |")).toBe("");
    expect(plainSnippet("## Status of the print layout")).toBe("Status of the print layout");
    expect(plainSnippet("> Keep the document readable")).toBe("Keep the document readable");
    expect(plainSnippet("- [ ] Review the print layout")).toBe("Review the print layout");
    expect(plainSnippet("2. Print **twice**, then `ship`")).toBe("Print twice, then ship");
  });

  it("keeps text that only looks like markup", () => {
    expect(plainSnippet("Costs 3 * 4 = 12 and a_b_c")).toBe("Costs 3 * 4 = 12 and a_b_c");
    expect(plainSnippet("…it, for example pnpm start ./notes.md.")).toBe("…it, for example pnpm start ./notes.md.");
  });
});
