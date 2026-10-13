// Data source for the Recent view (spec §5.8). The view talks to this interface
// rather than to `invoke()` directly, so it works unchanged outside Electron (a
// browser dev/preview build gets the no-op source) and can be driven by a mock
// in tests and screenshots. The default implementation wraps the IPC commands.

import {
  getRecentFiles,
  statFiles,
  setFavorite,
  removeRecent,
  searchRecentContents,
  cancelSearch,
} from "../ipc/commands";
import type { FileStat, SearchHit } from "../ipc/contracts";
import { isElectron } from "../ipc/env";
import type { RecentEntry } from "../state/types";

export interface ContentSearchCallbacks {
  /**
   * A file matched; `line` is the 1-based first matching line and `snippet` is
   * a trimmed excerpt of that line (elided with `…`) for the result-row preview.
   */
  onHit: (path: string, line: number, snippet: string) => void;
  /** Periodic progress tick: number of files scanned so far. */
  onProgress: (scanned: number) => void;
}

export interface ContentSearchSummary {
  scanned: number;
  matched: number;
  cancelled: boolean;
}

export interface RecentDataSource {
  /** Full retained history, most-recent-first. */
  list(): Promise<RecentEntry[]>;
  /** Live existence + size for the given paths. */
  stat(paths: string[]): Promise<FileStat[]>;
  /** Persist a favorite toggle; resolves to the updated entry (or null). */
  setFavorite(path: string, favorite: boolean): Promise<RecentEntry | null>;
  /** Drop an entry from history (never deletes the file on disk). */
  remove(path: string): Promise<void>;
  /** Stream a content search; resolves with a summary when done/cancelled. */
  searchContents(
    searchId: string,
    query: string,
    cb: ContentSearchCallbacks,
  ): Promise<ContentSearchSummary>;
  /** Cancel an in-flight content search by id. */
  cancelContentSearch(searchId: string): void;
}

/** IPC-backed source. Outside Electron every call degrades to an empty/no-op. */
export function createIpcRecentDataSource(): RecentDataSource {
  return {
    async list() {
      return isElectron() ? getRecentFiles() : [];
    },
    async stat(paths) {
      if (isElectron()) return statFiles(paths);
      return paths.map((path) => ({ path, exists: true, sizeBytes: 0, folderExists: true }));
    },
    async setFavorite(path, favorite) {
      return isElectron() ? setFavorite(path, favorite) : null;
    },
    async remove(path) {
      if (isElectron()) await removeRecent(path);
    },
    searchContents(searchId, query, cb) {
      if (!isElectron()) return Promise.resolve({ scanned: 0, matched: 0, cancelled: false });
      const onResult = (hit: SearchHit): void => {
        if (hit.kind === "content" && hit.line != null)
          cb.onHit(hit.path, hit.line, hit.snippet ?? "");
        else if (hit.kind === "progress") cb.onProgress(hit.scanned);
      };
      return searchRecentContents(searchId, query, { caseSensitive: false }, onResult);
    },
    cancelContentSearch(searchId) {
      if (isElectron()) void cancelSearch(searchId).catch(() => {});
    },
  };
}
