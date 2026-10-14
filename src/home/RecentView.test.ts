// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RecentView } from "./RecentView";
import type { ContentSearchCallbacks, ContentSearchSummary, RecentDataSource } from "./recentData";
import type { RecentEntry } from "../state/types";

// The Recent view after Mervin's Recent page: one list with starred files pinned
// under "Favorites", Names / Contents / All search scopes inside the field, and a
// content-search status with Stop beside it.

const entry = (path: string, favorite: boolean): RecentEntry => ({
  path,
  lastOpenedMs: 0,
  favorite,
});

// History, newest first. alpha (fav) and bravo contain "quick"; charlie (fav) does not.
const ALPHA = entry("C:/n/alpha.md", true);
const BRAVO = entry("C:/n/bravo.md", false);
const CHARLIE = entry("C:/n/charlie.md", true);
const CONTENT: Record<string, string> = {
  "C:/n/alpha.md": "the quick brown fox",
  "C:/n/bravo.md": "the quick red fox",
  "C:/n/charlie.md": "lazy dog",
};

const fresh = (...entries: RecentEntry[]): RecentEntry[] => entries.map((e) => ({ ...e }));

interface MockData extends RecentDataSource {
  cancelled: string[];
}

/** A data source over CONTENT. With `hold`, a scan reports its first hit and then
 * waits until it is cancelled, as a long scan would. */
function makeData(entries: RecentEntry[], { hold = false } = {}): MockData {
  const cancelled: string[] = [];
  const waiting = new Map<string, () => void>();
  return {
    cancelled,
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
    searchContents(id: string, query: string, cb: ContentSearchCallbacks): Promise<ContentSearchSummary> {
      const q = query.toLowerCase();
      let matched = 0;
      for (const e of entries) {
        const text = CONTENT[e.path] ?? "";
        if (!text.toLowerCase().includes(q)) continue;
        matched++;
        // Mirror the backend: report the matching line and a preview of it.
        cb.onHit(e.path, 1, text);
        if (hold) {
          return new Promise((resolve) =>
            waiting.set(id, () => resolve({ matched, scanned: 1, cancelled: true })),
          );
        }
      }
      return Promise.resolve({ matched, scanned: entries.length, cancelled: false });
    },
    cancelContentSearch(id) {
      cancelled.push(id);
      waiting.get(id)?.();
    },
  };
}

let summary = "";

async function mount(data: RecentDataSource, visibleCount = 100): Promise<RecentView> {
  const rv = new RecentView(data, () => visibleCount, {
    onOpenFile() {},
    onSummaryChange(text) {
      summary = text;
    },
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

const $ = <T extends Element = HTMLElement>(rv: RecentView, selector: string): T | null =>
  rv.element.querySelector<T>(selector);
const $$ = <T extends Element = HTMLElement>(rv: RecentView, selector: string): T[] =>
  Array.from(rv.element.querySelectorAll<T>(selector));

const names = (rv: RecentView): string[] => $$(rv, ".recent-row .recent-name").map((n) => n.textContent ?? "");
const captions = (rv: RecentView): string[] => $$(rv, ".recent-caption").map((c) => c.textContent ?? "");
const progress = (rv: RecentView): string => $(rv, ".recent-progress-text")?.textContent ?? "";
const empty = (rv: RecentView): string => $(rv, ".recent-empty")?.textContent ?? "";
const input = (rv: RecentView): HTMLInputElement => $<HTMLInputElement>(rv, ".recent-search-input")!;
const star = (rv: RecentView, name: string): HTMLButtonElement =>
  $$(rv, ".recent-row")
    .find((row) => row.querySelector(".recent-name")?.textContent === name)!
    .querySelector<HTMLButtonElement>(".recent-star")!;

function clickScope(rv: RecentView, label: string): void {
  const button = $$<HTMLButtonElement>(rv, ".recent-scope-btn").find(
    (b) => b.querySelector(".recent-scope-label")?.textContent === label,
  );
  if (!button) throw new Error(`scope "${label}" not found`);
  button.click();
}

function typeQuery(rv: RecentView, text: string): void {
  input(rv).value = text;
  input(rv).dispatchEvent(new Event("input"));
}

/** Type a query and let both debounces and a resolved scan run. */
async function search(rv: RecentView, text: string): Promise<void> {
  typeQuery(rv, text);
  await vi.advanceTimersByTimeAsync(400);
  await flush();
}

function press(target: Element, key: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  summary = "";
});
afterEach(() => {
  vi.useRealTimers();
});

describe("RecentView — sections and stars", () => {
  it("pins favourites under captions in history order, with no captions when nothing is starred", async () => {
    const rv = await mount(makeData(fresh(ALPHA, BRAVO, CHARLIE)));
    expect(captions(rv)).toEqual(["Favorites", "Recent"]);
    expect(names(rv)).toEqual(["alpha.md", "charlie.md", "bravo.md"]);
    expect(summary).toBe("2 starred, 1 recent");

    const plain = await mount(makeData(fresh(entry("C:/n/a.md", false), entry("C:/n/b.md", false))));
    expect(captions(plain)).toEqual([]);
    expect(summary).toBe("Your last 2 opened documents");
  });

  it("keeps a toggled row in place until the query changes or Recent is left", async () => {
    const rv = await mount(makeData(fresh(ALPHA, BRAVO, CHARLIE)));
    star(rv, "bravo.md").click();
    star(rv, "alpha.md").click();
    await flush();
    // Both stars flipped, but neither row moved.
    expect(names(rv)).toEqual(["alpha.md", "charlie.md", "bravo.md"]);
    expect(star(rv, "bravo.md").classList.contains("on")).toBe(true);
    expect(star(rv, "alpha.md").classList.contains("on")).toBe(false);
    expect(summary).toBe("2 starred, 1 recent");

    // A new query files them by their stars again.
    typeQuery(rv, ".md");
    await vi.advanceTimersByTimeAsync(200);
    expect(names(rv)).toEqual(["bravo.md", "charlie.md", "alpha.md"]);

    // So does leaving Recent.
    star(rv, "charlie.md").click();
    expect(names(rv)).toEqual(["bravo.md", "charlie.md", "alpha.md"]);
    rv.onLeave();
    expect(names(rv)).toEqual(["bravo.md", "alpha.md", "charlie.md"]);
  });

  it("caps the history but never the favourites", async () => {
    const rv = await mount(
      makeData(fresh(entry("C:/n/a.md", false), entry("C:/n/b.md", false), entry("C:/n/c.md", true))),
      1,
    );
    expect(names(rv)).toEqual(["c.md", "a.md"]);
  });

  it("says which search found nothing", async () => {
    const rv = await mount(makeData(fresh(ALPHA, BRAVO)));
    typeQuery(rv, "zzz");
    await vi.advanceTimersByTimeAsync(200);
    expect(names(rv)).toEqual([]);
    expect(empty(rv)).toBe('No file names contain "zzz"');
    expect(summary).toBe("0 results");

    const none = await mount(makeData([]));
    expect(empty(none)).toBe("No recent files yet");
  });
});

describe("RecentView — content search", () => {
  it("lists hits by section and counts them in the status", async () => {
    const rv = await mount(makeData(fresh(ALPHA, BRAVO, CHARLIE)));
    clickScope(rv, "Contents");
    expect(input(rv).placeholder).toBe("Search inside documents");
    typeQuery(rv, "quick");
    expect(progress(rv)).toBe("Searching…");
    expect($(rv, ".recent-search-stop")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(400);
    await flush();

    expect(names(rv)).toEqual(["alpha.md", "bravo.md"]);
    expect(captions(rv)).toEqual(["Favorites", "Recent"]);
    expect(progress(rv)).toBe("2 files found");
    expect($(rv, ".recent-search-stop")).toBeNull();

    // No hit: the status hides and the list says so.
    await search(rv, "zebra");
    expect(progress(rv)).toBe("");
    expect(empty(rv)).toBe('No documents contain "zebra"');
  });

  it("lists name matches first, then content hits for the other files, in the All scope", async () => {
    const quick = entry("C:/n/quick-notes.md", false);
    const rv = await mount(makeData(fresh(BRAVO, quick, CHARLIE)));
    clickScope(rv, "All");
    expect(input(rv).placeholder).toBe("Search names and contents");
    await search(rv, "quick");
    // quick-notes.md by name, then bravo.md by content; each file once.
    expect(names(rv)).toEqual(["quick-notes.md", "bravo.md"]);
    expect($$(rv, ".recent-snippet").map((s) => s.textContent)).toEqual(["the quick red fox"]);
    expect(progress(rv)).toBe("2 files found");

    await search(rv, "zebra");
    expect(empty(rv)).toBe('No file names or documents contain "zebra"');
  });

  it("stops a running scan and keeps what it found", async () => {
    const data = makeData(fresh(ALPHA, BRAVO, CHARLIE), { hold: true });
    const rv = await mount(data);
    clickScope(rv, "Contents");
    await search(rv, "quick");
    expect(names(rv)).toEqual(["alpha.md"]);
    expect(progress(rv)).toBe("Searching file 1 of 3");

    $<HTMLButtonElement>(rv, ".recent-search-stop")!.click();
    await flush();
    expect(data.cancelled).toHaveLength(1);
    expect(progress(rv)).toBe("Stopped, 1 file found");
    expect(names(rv)).toEqual(["alpha.md"]);
    expect($(rv, ".recent-search-stop")).toBeNull();
  });

  it("drops the stale count and scans again when refresh() reloads entries", async () => {
    const rv = await mount(makeData(fresh(ALPHA, BRAVO, CHARLIE)));
    clickScope(rv, "Contents");
    await search(rv, "quick");
    expect(progress(rv)).toBe("2 files found");

    // A reload (e.g. after locating a missing file) must not leave the old
    // count showing against the freshly-loaded list.
    await rv.refresh();
    expect(progress(rv)).toBe("Searching…");
    await vi.advanceTimersByTimeAsync(400);
    await flush();
    expect(progress(rv)).toBe("2 files found");
  });
});

describe("RecentView — match highlighting & content snippet", () => {
  it("marks the matched run of the filename in a Names search, preserving case", async () => {
    const rv = await mount(makeData(fresh(ALPHA, BRAVO, CHARLIE)));
    typeQuery(rv, "ALPH"); // upper-case query against the lower-case filename
    await vi.advanceTimersByTimeAsync(200);

    expect(names(rv)).toEqual(["alpha.md"]);
    const mark = $(rv, ".recent-name .recent-match");
    // The displayed run keeps the file's own casing, not the query's.
    expect(mark?.textContent).toBe("alph");
    // A Names search shows no content snippet.
    expect($(rv, ".recent-snippet")).toBeNull();
  });

  it("renders a highlighted snippet between the filename and the path for content hits", async () => {
    const rv = await mount(makeData(fresh(ALPHA, BRAVO, CHARLIE)));
    clickScope(rv, "Contents");
    await search(rv, "quick");

    const row = $(rv, ".recent-row")!; // alpha.md
    const mid = row.querySelector(".recent-mid")!;
    // The snippet line sits between the name and the path, in that order.
    expect(Array.from(mid.children).map((c) => c.classList[0])).toEqual([
      "recent-name",
      "recent-snippet",
      "recent-path",
    ]);

    const snippet = row.querySelector(".recent-snippet")!;
    expect(snippet.textContent).toBe("the quick brown fox");
    expect(snippet.querySelector(".recent-match")?.textContent).toBe("quick");
    // Every matched document gets its own snippet row, and its line in the tooltip.
    expect($$(rv, ".recent-snippet")).toHaveLength(2);
    expect(row.getAttribute("title")).toBe("C:/n/alpha.md\nMatch on line 1");
  });

  it("never marks the filename during a Contents search, even if the name contains the term", async () => {
    const quick = entry("C:/n/quick.md", false);
    CONTENT[quick.path] = "a quick brown note";
    const rv = await mount(makeData([quick]));
    clickScope(rv, "Contents");
    await search(rv, "quick");

    // The snippet marks "quick"; the filename (also "quick") stays plain.
    expect($(rv, ".recent-snippet .recent-match")?.textContent).toBe("quick");
    expect($(rv, ".recent-name .recent-match")).toBeNull();
  });

  it("keeps the marked run aligned when the filename has a length-changing uppercase char", async () => {
    // "İ" (U+0130) lowercases to two code units; a naive lowercased-index
    // highlighter would shift the run to "tanbul." — assert it stays "stanbul".
    const rv = await mount(makeData([entry("C:/n/İstanbul.md", false)]));
    typeQuery(rv, "stanbul");
    await vi.advanceTimersByTimeAsync(200);

    expect($(rv, ".recent-name .recent-match")?.textContent).toBe("stanbul");
  });
});

describe("RecentView — keyboard", () => {
  it("moves from the field into the list and between rows", async () => {
    const rv = await mount(makeData(fresh(ALPHA, BRAVO, CHARLIE)));
    const openButtons = () => $$<HTMLButtonElement>(rv, ".recent-row-open");
    // One tab stop for the whole list.
    expect(openButtons().map((b) => b.tabIndex)).toEqual([0, -1, -1]);

    input(rv).focus();
    press(input(rv), "ArrowDown");
    expect(document.activeElement).toBe(openButtons()[0]);

    press(openButtons()[0], "ArrowDown");
    expect(document.activeElement).toBe(openButtons()[1]);
    expect(openButtons().map((b) => b.tabIndex)).toEqual([-1, 0, -1]);

    press(openButtons()[1], "ArrowRight");
    expect(document.activeElement).toBe(star(rv, "charlie.md"));

    press(openButtons()[1], "Home");
    press(openButtons()[0], "ArrowUp");
    expect(document.activeElement).toBe(input(rv));
  });
});
