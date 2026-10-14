import { describe, it, expect } from "vitest";
import {
  buildListing,
  emptyNote,
  recentSummary,
  searchStatus,
  type ContentHit,
  type ListingInput,
} from "./recentListing";
import { fileName } from "./recentFormat";
import type { RecentEntry } from "../state/types";

const entry = (name: string, favorite = false): RecentEntry => ({
  path: `C:/n/${name}`,
  lastOpenedMs: 0,
  favorite,
});

// History, newest first: two favourites among four plain files.
const HISTORY = [
  entry("a.md"),
  entry("fav-b.md", true),
  entry("c.md"),
  entry("d.md"),
  entry("fav-e.md", true),
  entry("f.md"),
];

function listing(overrides: Partial<ListingInput> = {}) {
  const result = buildListing({
    entries: HISTORY,
    scope: "names",
    nameQuery: "",
    contentQuery: "",
    hits: new Map(),
    visibleCount: 100,
    inFavorites: (e) => e.favorite,
    ...overrides,
  });
  const names = (rows: typeof result.favorites) => rows.map((row) => fileName(row.entry.path));
  return { favorites: names(result.favorites), recent: names(result.recent), result };
}

describe("buildListing", () => {
  it("pins favourites first in history order, the rest after them", () => {
    expect(listing()).toMatchObject({
      favorites: ["fav-b.md", "fav-e.md"],
      recent: ["a.md", "c.md", "d.md", "f.md"],
    });
  });

  it("caps only the non-favourites at the visible count", () => {
    expect(listing({ visibleCount: 2 })).toMatchObject({
      favorites: ["fav-b.md", "fav-e.md"],
      recent: ["a.md", "c.md"],
    });
  });

  it("lists every name match uncapped while filtering by name", () => {
    const many = Array.from({ length: 5 }, (_, i) => entry(`note-${i}.md`));
    expect(listing({ entries: many, nameQuery: "note", visibleCount: 2 }).recent).toHaveLength(5);
    expect(listing({ nameQuery: "FAV" })).toMatchObject({ favorites: ["fav-b.md", "fav-e.md"], recent: [] });
  });

  it("files a row by its kept section, not its current star", () => {
    // fav-b.md was just unstarred and c.md just starred: both keep their place.
    const kept = new Map([
      ["C:/n/fav-b.md", true],
      ["C:/n/c.md", false],
    ]);
    const entries = HISTORY.map((e) =>
      e.path === "C:/n/fav-b.md" ? { ...e, favorite: false } : e.path === "C:/n/c.md" ? { ...e, favorite: true } : e,
    );
    expect(
      listing({ entries, visibleCount: 2, inFavorites: (e) => kept.get(e.path) ?? e.favorite }),
    ).toMatchObject({ favorites: ["fav-b.md", "fav-e.md"], recent: ["a.md", "c.md"] });
  });

  it("lists only content hits in the Contents scope, in arrival order per section", () => {
    const hits = new Map<string, ContentHit>([
      ["C:/n/f.md", { line: 3, snippet: "f" }],
      ["C:/n/fav-e.md", { line: 1, snippet: "e" }],
      ["C:/n/a.md", { line: 9, snippet: "a" }],
    ]);
    const { favorites, recent, result } = listing({ scope: "contents", contentQuery: "x", hits });
    expect(favorites).toEqual(["fav-e.md"]);
    expect(recent).toEqual(["f.md", "a.md"]);
    expect(result.recent[0].hit).toEqual({ line: 3, snippet: "f" });
  });

  it("appends content hits after the name matches in the All scope, without repeating a file", () => {
    const hits = new Map<string, ContentHit>([
      ["C:/n/d.md", { line: 2, snippet: "about fav" }],
      ["C:/n/fav-b.md", { line: 1, snippet: "fav" }], // already listed by name
      ["C:/n/gone.md", { line: 1, snippet: "fav" }], // left the history meanwhile
    ]);
    const { favorites, recent, result } = listing({ scope: "all", nameQuery: "fav", contentQuery: "fav", hits });
    expect(favorites).toEqual(["fav-b.md", "fav-e.md"]);
    expect(recent).toEqual(["d.md"]);
    expect(result.favorites[0].hit).toBeUndefined();
  });
});

describe("copy", () => {
  it("names the empty note after the scope", () => {
    expect(emptyNote("names", "", "idle")).toBe("No recent files yet");
    expect(emptyNote("names", "zz", "idle")).toBe('No file names contain "zz"');
    expect(emptyNote("contents", "zz", "done")).toBe('No documents contain "zz"');
    expect(emptyNote("all", "zz", "done")).toBe('No file names or documents contain "zz"');
    // The status speaks while a scan is pending, running or stopped.
    expect(emptyNote("contents", "zz", "running")).toBe("");
    expect(emptyNote("all", "zz", "stopped")).toBe("");
  });

  it("reports the content search phase", () => {
    expect(searchStatus("idle", 0, 5, 0)).toBeNull();
    expect(searchStatus("pending", 0, 5, 0)).toEqual({ text: "Searching…", running: true });
    expect(searchStatus("running", 0, 5, 0)).toEqual({ text: "Searching file 1 of 5", running: true });
    expect(searchStatus("running", 9, 5, 0)?.text).toBe("Searching file 5 of 5");
    expect(searchStatus("done", 5, 5, 1)).toEqual({ text: "1 file found", running: false });
    expect(searchStatus("done", 5, 5, 0)).toBeNull();
    expect(searchStatus("stopped", 2, 5, 0)?.text).toBe("Stopped");
    expect(searchStatus("stopped", 2, 5, 3)?.text).toBe("Stopped, 3 files found");
  });

  it("summarises the list for the status bar", () => {
    const rows = HISTORY.map((e) => ({ entry: e }));
    expect(recentSummary(true, rows.slice(0, 1))).toBe("1 result");
    expect(recentSummary(false, rows)).toBe("2 starred, 4 recent");
    expect(recentSummary(false, rows.filter((row) => !row.entry.favorite))).toBe(
      "Your last 4 opened documents",
    );
    expect(recentSummary(false, [])).toBe("No recent files yet");
  });
});
