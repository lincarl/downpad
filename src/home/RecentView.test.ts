// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RecentView } from "./RecentView";
import type { RecentDataSource } from "./recentData";
import type { RecentEntry } from "../state/types";

// These tests pin the spec §5.8 rule that the All/Favorites view-mode filter
// applies to "Inside documents" content-search results too — switching modes (or
// un-starring a row) while a search is showing must re-filter the list *and*
// re-count the "N files found" line, without re-scanning.

const entry = (path: string, favorite: boolean): RecentEntry => ({
  path,
  lastOpenedMs: 0,
  favorite,
});

// alpha (fav) + bravo (not fav) both contain "quick"; charlie (fav) does not.
const ALPHA = entry("C:/n/alpha.md", true);
const BRAVO = entry("C:/n/bravo.md", false);
const CHARLIE = entry("C:/n/charlie.md", true);
const CONTENT: Record<string, string> = {
  "C:/n/alpha.md": "the quick brown fox",
  "C:/n/bravo.md": "the quick red fox",
  "C:/n/charlie.md": "lazy dog",
};

function makeData(entries: RecentEntry[]): RecentDataSource {
  return {
    async list() {
      return entries;
    },
    async stat(paths) {
      return paths.map((path) => ({ path, exists: true, sizeBytes: 0, folderExists: true }));
    },
    async setFavorite(path, favorite) {
      const e = entries.find((x) => x.path === path);
      if (e) e.favorite = favorite;
      return e ?? null;
    },
    async remove() {},
    async searchContents(_id, query, cb) {
      const q = query.toLowerCase();
      let matched = 0;
      for (const e of entries) {
        const text = CONTENT[e.path] ?? "";
        if (text.toLowerCase().includes(q)) {
          matched++;
          // Mirror the backend: report the matching line and a preview of it.
          cb.onHit(e.path, 1, text);
        }
      }
      return { matched, scanned: entries.length, cancelled: false };
    },
    cancelContentSearch() {},
  };
}

async function mount(entries: RecentEntry[]): Promise<RecentView> {
  const rv = new RecentView(makeData(entries), () => 100, {
    onOpenFile() {},
    onSummaryChange() {},
    async pickFile() {
      return null;
    },
    reveal() {},
    copy() {},
  });
  document.body.appendChild(rv.element);
  await rv.refresh();
  await flush();
  return rv;
}

// Drain microtasks (refresh()/ensureStats() are floating async re-renders).
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function names(rv: RecentView): string[] {
  return Array.from(rv.element.querySelectorAll(".recent-row")).map((row) =>
    (row.querySelector(".recent-name")?.textContent ?? "").replace(/ — line.*$/, "").trim(),
  );
}

function progress(rv: RecentView): string {
  return rv.element.querySelector(".recent-progress")?.textContent ?? "";
}

function clickSeg(rv: RecentView, label: string): void {
  const btn = Array.from(rv.element.querySelectorAll<HTMLButtonElement>(".seg-btn")).find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`segment "${label}" not found`);
  btn.click();
}

function typeQuery(rv: RecentView, text: string): void {
  const input = rv.element.querySelector<HTMLInputElement>(".recent-search-input")!;
  input.value = text;
  input.dispatchEvent(new Event("input"));
}

async function runInsideSearch(rv: RecentView, query: string): Promise<void> {
  clickSeg(rv, "Inside docs");
  typeQuery(rv, query);
  await vi.advanceTimersByTimeAsync(400); // debounce + the (resolved) scan
  await flush();
}

describe("RecentView — view-mode filter on content search (§5.8)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("filters Inside-docs results to favorites and re-counts when the mode switches", async () => {
    const rv = await mount([ALPHA, BRAVO, CHARLIE].map((e) => ({ ...e })));
    await runInsideSearch(rv, "quick");

    // All: both files that contain "quick".
    expect(names(rv)).toEqual(["alpha.md", "bravo.md"]);
    expect(progress(rv)).toBe("2 files found");

    // Favorites: only the starred match — list AND count update, no re-scan.
    clickSeg(rv, "Favorites");
    await flush();
    expect(names(rv)).toEqual(["alpha.md"]);
    expect(progress(rv)).toBe("1 file found");

    // Back to All restores the full result set and count.
    clickSeg(rv, "All");
    await flush();
    expect(names(rv)).toEqual(["alpha.md", "bravo.md"]);
    expect(progress(rv)).toBe("2 files found");
  });

  it("re-counts when a starred result is un-starred during a Favorites search", async () => {
    const rv = await mount([ALPHA, BRAVO, CHARLIE].map((e) => ({ ...e })));
    await runInsideSearch(rv, "quick");
    clickSeg(rv, "Favorites");
    await flush();
    expect(names(rv)).toEqual(["alpha.md"]);

    // Un-star the only favorite match → it leaves the list and the count drops.
    const star = rv.element
      .querySelectorAll<HTMLButtonElement>(".recent-row")[0]
      .querySelector<HTMLButtonElement>(".recent-star")!;
    star.click();
    await flush();

    expect(names(rv)).toEqual([]);
    // Zero-match wording is scoped to favorites — the matches exist, just none
    // are starred, so "No files contain" would be misleading.
    expect(progress(rv)).toBe('No favorites contain "quick"');
  });

  it("keeps the All result set unfiltered by favorites", async () => {
    const rv = await mount([ALPHA, BRAVO, CHARLIE].map((e) => ({ ...e })));
    await runInsideSearch(rv, "quick");
    // bravo.md is not a favorite yet appears in All — favorites must not leak in.
    expect(names(rv)).toContain("bravo.md");
    expect(progress(rv)).toBe("2 files found");
  });

  it("clears the stale count and re-scans when refresh() reloads entries", async () => {
    const entries = [ALPHA, BRAVO, CHARLIE].map((e) => ({ ...e }));
    const rv = await mount(entries);
    await runInsideSearch(rv, "quick");
    expect(progress(rv)).toBe("2 files found");

    // A reload (e.g. after locating a missing file) must not leave the old
    // count showing against the freshly-loaded list.
    await rv.refresh();
    expect(progress(rv)).toBe(""); // stale count cleared; the re-scan is only scheduled
    await vi.advanceTimersByTimeAsync(400);
    await flush();
    expect(progress(rv)).toBe("2 files found"); // re-scan settled with fresh hits
  });
});

describe("RecentView — match highlighting & content snippet (§5.8)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function typeName(rv: RecentView, text: string): void {
    typeQuery(rv, text);
    vi.advanceTimersByTime(200); // Name search debounce
  }

  it("bolds the matched run of the filename in a Name search, preserving case", async () => {
    const rv = await mount([ALPHA, BRAVO, CHARLIE].map((e) => ({ ...e })));
    typeName(rv, "ALPH"); // upper-case query against the lower-case filename
    await flush();

    expect(names(rv)).toEqual(["alpha.md"]);
    const nameEl = rv.element.querySelector(".recent-name")!;
    const mark = nameEl.querySelector(".recent-match");
    expect(mark).not.toBeNull();
    // The displayed run keeps the file's own casing, not the query's.
    expect(mark!.textContent).toBe("alph");
    // Name search shows no content snippet.
    expect(rv.element.querySelector(".recent-snippet")).toBeNull();
  });

  it("renders a highlighted snippet between the filename and the path for Inside-docs hits", async () => {
    const rv = await mount([ALPHA, BRAVO, CHARLIE].map((e) => ({ ...e })));
    await runInsideSearch(rv, "quick");

    const row = rv.element.querySelector(".recent-row")!; // alpha.md
    const mid = row.querySelector(".recent-mid")!;
    // The snippet line sits between the name and the path, in that order.
    expect(Array.from(mid.children).map((c) => c.className)).toEqual([
      "recent-name",
      "recent-snippet",
      "recent-path",
    ]);

    const snippet = row.querySelector(".recent-snippet")!;
    expect(snippet.textContent).toBe("the quick brown fox");
    expect(snippet.querySelector(".recent-match")?.textContent).toBe("quick");
    // Every matched document gets its own snippet row.
    expect(rv.element.querySelectorAll(".recent-snippet").length).toBe(2);
  });

  it("never bolds the filename during an Inside-docs search, even if the name contains the term", async () => {
    const quick = entry("C:/n/quick.md", false);
    CONTENT[quick.path] = "a quick brown note";
    const rv = await mount([quick]);
    await runInsideSearch(rv, "quick");

    const row = rv.element.querySelector(".recent-row")!;
    // The snippet highlights "quick"; the filename (also "quick") stays plain —
    // content search highlights the preview, not the name (§5.8).
    expect(row.querySelector(".recent-snippet .recent-match")?.textContent).toBe("quick");
    expect(row.querySelector(".recent-name .recent-match")).toBeNull();
  });

  it("keeps the bold run aligned when the filename has a length-changing uppercase char", async () => {
    // "İ" (U+0130) lowercases to two code units; a naive lowercased-index
    // highlighter would shift the run to "tanbul." — assert it stays "stanbul".
    const rv = await mount([entry("C:/n/İstanbul.md", false)]);
    typeName(rv, "stanbul");
    await flush();

    const mark = rv.element.querySelector(".recent-name .recent-match");
    expect(mark?.textContent).toBe("stanbul");
  });
});
