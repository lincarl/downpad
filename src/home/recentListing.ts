// Listing rules for the Recent view, after Mervin PDF's Recent page: which rows
// show, which section each sits in, and the copy for the empty note, the content
// search status and the window status bar. Pure functions, so the rules are
// unit-tested without React or IPC.

import type { RecentEntry, Settings } from "../state/types";
import { filterByName } from "./recentFormat";

/** Where the search looks: file names, document contents, or names then contents. */
export type SearchScope = Settings["recentFilesDefaultSearch"];

/**
 * Content search lifecycle. `pending` is the pause after typing, `running` the
 * scan, `done` a finished scan and `stopped` a scan the user cut short.
 */
export type SearchPhase = "idle" | "pending" | "running" | "done" | "stopped";

/** A content-search hit: the first matching line and a preview of it. */
export interface ContentHit {
  line: number;
  snippet: string;
}

/** One file row. `hit` is set for rows the content search found. */
export interface RecentRowModel {
  entry: RecentEntry;
  hit?: ContentHit;
}

/** The two sections of the list, each in history order. */
export interface RecentListing {
  favorites: RecentRowModel[];
  recent: RecentRowModel[];
}

export interface ListingInput {
  /** Full history, newest first. */
  entries: RecentEntry[];
  scope: SearchScope;
  /** Trimmed file-name filter; "" lists every file. Ignored by the Contents scope. */
  nameQuery: string;
  /** Trimmed content query; "" when no content search applies. */
  contentQuery: string;
  /** Content hits in arrival order, keyed by path. */
  hits: ReadonlyMap<string, ContentHit>;
  /** Most non-favourites listed while there is no name filter. */
  visibleCount: number;
  /** Whether a row is listed under Favorites. */
  inFavorites(entry: RecentEntry): boolean;
}

/**
 * Builds the list. Without a name filter every favourite shows and the rest are
 * capped at `visibleCount`. With one, only files whose name matches show, uncapped.
 * The Contents scope lists only content hits; the All scope appends hits for files
 * not already listed by name. Hits go to the end of their section as they arrive.
 */
export function buildListing(input: ListingInput): RecentListing {
  const { entries, scope, nameQuery, contentQuery, hits, visibleCount, inFavorites } = input;
  const listing: RecentListing = { favorites: [], recent: [] };
  const listed = new Set<string>();
  const add = (row: RecentRowModel): void => {
    listed.add(row.entry.path);
    (inFavorites(row.entry) ? listing.favorites : listing.recent).push(row);
  };
  if (!(scope === "contents" && contentQuery)) {
    let rest = 0;
    for (const entry of nameQuery ? filterByName(entries, nameQuery) : entries) {
      if (!nameQuery && !inFavorites(entry) && ++rest > visibleCount) continue;
      add({ entry });
    }
  }
  if (contentQuery && hits.size) {
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    for (const [path, hit] of hits) {
      const entry = byPath.get(path);
      if (entry && !listed.has(path)) add({ entry, hit });
    }
  }
  return listing;
}

/** "1 file", "2 files". */
export function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The note shown in place of rows when nothing is listed. `query` is the filter
 * the list applies. Empty while a content scan has not finished, because the
 * search status speaks then.
 */
export function emptyNote(scope: SearchScope, query: string, phase: SearchPhase): string {
  if (!query) return "No recent files yet";
  if (scope === "names") return `No file names contain "${query}"`;
  if (phase !== "done") return "";
  return scope === "contents"
    ? `No documents contain "${query}"`
    : `No file names or documents contain "${query}"`;
}

/** The status beside the search field, or null when it is hidden. */
export interface SearchStatus {
  text: string;
  /** The scan is pending or running: the text uses body ink and Stop shows. */
  running: boolean;
}

/** Status copy for a content search, from the phase and the rows listed so far. */
export function searchStatus(
  phase: SearchPhase,
  scanned: number,
  total: number,
  listed: number,
): SearchStatus | null {
  switch (phase) {
    case "idle":
      return null;
    case "pending":
      return { text: "Searching…", running: true };
    case "running":
      return total > 0
        ? { text: `Searching file ${Math.min(scanned + 1, total)} of ${total}`, running: true }
        : { text: "Searching…", running: true };
    case "done":
      return listed ? { text: `${countOf(listed, "file")} found`, running: false } : null;
    case "stopped":
      return {
        text: listed ? `Stopped, ${countOf(listed, "file")} found` : "Stopped",
        running: false,
      };
  }
}

/** The widest running status for a history of `total` files, so Stop never moves. */
export function widestSearchStatus(total: number): string {
  const n = Math.max(1, total);
  return `Searching file ${n} of ${n}`;
}

/** The window status bar line while Recent shows. */
export function recentSummary(filtering: boolean, rows: RecentRowModel[]): string {
  const listed = rows.length;
  if (filtering) return countOf(listed, "result");
  const starred = rows.filter((row) => row.entry.favorite).length;
  if (starred) return `${starred} starred, ${listed - starred} recent`;
  if (listed) return `Your last ${countOf(listed, "opened document")}`;
  return "No recent files yet";
}
