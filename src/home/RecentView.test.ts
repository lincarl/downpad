// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import { RecentView, type RecentPreferences, type RecentViewCallbacks } from "./RecentView";
import { DEFAULT_SETTINGS } from "../settings/defaults";
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
const CONTENT: Readonly<Record<string, string>> = {
  "C:/n/alpha.md": "the quick brown fox",
  "C:/n/bravo.md": "the quick red fox",
  "C:/n/charlie.md": "lazy dog",
};

const fresh = (...entries: RecentEntry[]): RecentEntry[] => entries.map((e) => ({ ...e }));

interface MockData extends RecentDataSource {
  cancelled: string[];
}

/** A data source over `content`. With `hold`, a scan reports its first hit and then
 * waits until it is cancelled, as a long scan would. */
function makeData(entries: RecentEntry[], { hold = false, content = CONTENT } = {}): MockData {
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
        const text = content[e.path] ?? "";
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
let opened: string[] = [];
const views: RecentView[] = [];

async function mount(data: RecentDataSource, visibleCount = 100, preferences: RecentPreferences = {
  ...DEFAULT_SETTINGS, recentFilesVisibleCount: visibleCount,
}, callbacks: Partial<RecentViewCallbacks> = {}): Promise<RecentView> {
  const rv = new RecentView(data, () => preferences, {
    onOpenFile(path) { opened.push(path); },
    onSummaryChange(text) {
      summary = text;
    },
    async pickFile() {
      return null;
    },
    reveal() {},
    copy() {},
    ...callbacks,
  });
  views.push(rv);
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
  opened = [];
});
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.useRealTimers();
});

describe("RecentView preferences", () => {
  it("keeps a search scope selected while entry history is loading", async () => {
    const data = makeData(fresh(ALPHA, BRAVO));
    const rv = await mount(data);
    rv.onLeave();
    let resolveList!: (entries: RecentEntry[]) => void;
    vi.spyOn(data, "list").mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve; }));
    const refresh = rv.refresh();
    clickScope(rv, "Contents");
    resolveList(fresh(ALPHA, BRAVO));
    await refresh;
    await search(rv, "quick");
    expect(names(rv)).toEqual(["alpha.md", "bravo.md"]);
  });

  it("ignores metadata requested while a later history refresh is loading", async () => {
    const entries = fresh(BRAVO, entry(CHARLIE.path, false));
    const data = makeData(entries);
    const rv = await mount(data, 1);
    let resolveList!: (entries: RecentEntry[]) => void;
    let resolveOld!: (stats: Awaited<ReturnType<RecentDataSource["stat"]>>) => void;
    vi.spyOn(data, "list").mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve; }));
    vi.spyOn(data, "stat").mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const refresh = rv.refresh();
    await search(rv, "charlie");
    resolveList(entries);
    await refresh;
    await flush();
    resolveOld([{ path: CHARLIE.path, exists: false, sizeBytes: 0, folderExists: true }]);
    await flush();
    expect(names(rv)).toEqual(["charlie.md"]);
  });

  it("uses the saved search scope on entry and applies a changed default", async () => {
    const preferences: RecentPreferences = { ...DEFAULT_SETTINGS, recentFilesDefaultSearch: "contents" };
    const rv = await mount(makeData(fresh(ALPHA, BRAVO, CHARLIE)), 100, preferences);
    await search(rv, "quick");
    expect(names(rv)).toEqual(["alpha.md", "bravo.md"]);
    clickScope(rv, "Names");
    expect(names(rv)).toEqual([]);
    rv.onLeave();
    await rv.refresh();
    await vi.advanceTimersByTimeAsync(400);
    expect(names(rv)).toEqual(["alpha.md", "bravo.md"]);

    preferences.recentFilesDefaultSearch = "names";
    rv.applyPreferences(true);
    expect(names(rv)).toEqual([]);
    expect(progress(rv)).toBe("");
  });

  it("hides missing favorites and recent files, fills the visible limit, and retains history", async () => {
    const preferences: RecentPreferences = { ...DEFAULT_SETTINGS, recentFilesVisibleCount: 1 };
    const data = makeData(fresh(ALPHA, BRAVO, entry("C:/n/available.md", false)));
    const remove = vi.spyOn(data, "remove");
    data.stat = async (paths) => paths.map((path) => ({
      path, exists: path.endsWith("available.md"), sizeBytes: 0, folderExists: true,
    }));
    const rv = await mount(data, 1, preferences);
    await flush();
    expect(names(rv)).toEqual(["available.md"]);
    expect(summary).toBe("Your last 1 opened document");
    expect(remove).not.toHaveBeenCalled();

    preferences.recentFilesKeepRemoved = true;
    rv.applyPreferences(false);
    expect(names(rv)).toEqual(["alpha.md", "bravo.md"]);
    preferences.recentFilesKeepRemoved = false;
    rv.applyPreferences(false);
    clickScope(rv, "All");
    await search(rv, "quick");
    expect(names(rv)).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
  });

  it("shows a missing file again after it returns and ignores an old metadata response", async () => {
    const data = makeData(fresh(BRAVO));
    let resolveOld!: (stats: Awaited<ReturnType<RecentDataSource["stat"]>>) => void;
    const stat = vi.spyOn(data, "stat").mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const rv = await mount(data);
    await rv.refresh();
    resolveOld([{ path: BRAVO.path, exists: false, sizeBytes: 0, folderExists: true }]);
    await flush();
    expect(names(rv)).toEqual(["bravo.md"]);
    stat.mockResolvedValueOnce([{ path: BRAVO.path, exists: false, sizeBytes: 0, folderExists: true }]);
    await rv.refresh();
    await flush();
    expect(names(rv)).toEqual([]);
    await rv.refresh();
    await flush();
    expect(names(rv)).toEqual(["bravo.md"]);
  });

  it.each([false, true])("ignores an older row-open result reporting exists=%s", async (exists) => {
    const data = makeData(fresh(BRAVO));
    type Stats = Awaited<ReturnType<RecentDataSource["stat"]>>;
    let resolveListing!: (stats: Stats) => void;
    let resolveOpen!: (stats: Stats) => void;
    vi.spyOn(data, "stat")
      .mockImplementationOnce(() => new Promise((resolve) => { resolveListing = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOpen = resolve; }));
    const rv = await mount(data);
    $<HTMLButtonElement>(rv, ".recent-row-open")!.click();
    rv.onLeave();
    await rv.refresh();
    await flush();
    const missing = [{ path: BRAVO.path, exists: false, sizeBytes: 0, folderExists: true }];
    resolveOpen([{ ...missing[0], exists }]);
    resolveListing(missing);
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(opened).toEqual([]);
    await search(rv, "bravo");
    expect(names(rv)).toEqual(["bravo.md"]);
  });
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

  it("puts a star back when the history cannot save it", async () => {
    const data = makeData(fresh(ALPHA, BRAVO, CHARLIE));
    data.setFavorite = async () => {
      throw new Error("history locked");
    };
    const rv = await mount(data);
    star(rv, "bravo.md").click();
    star(rv, "alpha.md").click();
    expect(star(rv, "bravo.md").classList.contains("on")).toBe(true);
    expect(star(rv, "alpha.md").classList.contains("on")).toBe(false);

    await vi.advanceTimersByTimeAsync(0);
    expect(star(rv, "bravo.md").classList.contains("on")).toBe(false);
    expect(star(rv, "alpha.md").classList.contains("on")).toBe(true);
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

  it("reports a scan the main process ends early as stopped", async () => {
    const data = makeData(fresh(ALPHA, BRAVO, CHARLIE));
    data.searchContents = async (_id, _query, cb) => {
      cb.onHit(ALPHA.path, 1, CONTENT[ALPHA.path]!);
      return { matched: 1, scanned: 1, cancelled: true };
    };
    const rv = await mount(data);
    clickScope(rv, "Contents");
    await search(rv, "quick");
    expect(names(rv)).toEqual(["alpha.md"]);
    expect(progress(rv)).toBe("Stopped, 1 file found");
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
    const rv = await mount(makeData([quick], { content: { [quick.path]: "a quick brown note" } }));
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

describe("RecentView missing files", () => {
  const FOUND = "C:/n/found.md";

  it.each([
    ["Locate removes the old entry, opens the picked file and refreshes", "Locate", FOUND,
      [`remove ${BRAVO.path}`, `open ${FOUND}`, "list"], []],
    ["a cancelled Locate changes nothing", "Locate", null, [], ["bravo.md"]],
    ["Remove from history removes the entry and refreshes", "Remove from history", FOUND,
      [`remove ${BRAVO.path}`, "list"], []],
    ["Cancel changes nothing", "Cancel", FOUND, [], ["bravo.md"]],
  ] as const)("%s", async (_name, choice, picked, calls, listed) => {
    const entries = fresh(BRAVO);
    const data = makeData(entries);
    const log: string[] = [];
    data.stat = async (paths) => paths.map((path) => ({ path, exists: false, sizeBytes: 0, folderExists: true }));
    const list = data.list;
    data.list = async () => {
      log.push("list");
      return list();
    };
    data.remove = async (path) => {
      log.push(`remove ${path}`);
      entries.splice(entries.findIndex((e) => e.path === path), 1);
    };
    // Missing files stay listed only when the setting keeps them.
    const rv = await mount(data, 100, { ...DEFAULT_SETTINGS, recentFilesKeepRemoved: true }, {
      onOpenFile: (path) => {
        log.push(`open ${path}`);
      },
      pickFile: async () => picked,
    });
    log.length = 0;

    $<HTMLButtonElement>(rv, ".recent-row-open")!.click();
    screen.getByRole("button", { name: choice }).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(calls);
    expect(names(rv)).toEqual(listed);
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
