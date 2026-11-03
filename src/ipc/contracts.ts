// Payloads shared by the Electron main process and renderer.
// Keep property names consistent across the isolated preload boundary.

import type { Eol } from "../state/types";

export interface FilePayload {
  /** BOM-stripped, LF-normalized file content (canonical in-memory form). */
  content: string;
  /** Detected dominant EOL of the file on disk. */
  eol: Eol;
  hadBom: boolean;
  sizeBytes: number;
  modifiedMs: number;
}

export interface FileMeta {
  modifiedMs: number;
}

/** Raw image bytes + MIME (guessed by extension); for relocate / copy-image (§5.5). */
export interface ImageBytes {
  /** The file's bytes, which IPC copies as binary. */
  bytes: Uint8Array<ArrayBuffer>;
  mime: string;
}

/** Live disk stat for a recent row (§5.8 row layout): existence + size. */
export interface FileStat {
  path: string;
  exists: boolean;
  /** Size in bytes (0 when the file is missing). */
  sizeBytes: number;
  /** Whether the file's parent folder still exists (for "Open folder"). */
  folderExists: boolean;
}

/** History content-search options (§5.8). */
export interface SearchOpts {
  caseSensitive: boolean;
}

/**
 * A streamed content-search result or progress tick (design §3.4). For a
 * "content" hit, `line` is the 1-based number of the first matching line and
 * `snippet` is a trimmed excerpt of that line around the match (§5.8
 * "Inside documents"); for a "progress" tick both are null.
 */
export interface SearchHit {
  kind: "content" | "progress";
  path: string;
  line: number | null;
  /** Excerpt of the matching line (elided with `…`); null for progress ticks. */
  snippet: string | null;
  scanned: number;
  matched: number;
}

export interface SearchSummary {
  scanned: number;
  matched: number;
  cancelled: boolean;
}

/** Current default handler for .md files (§5.12). */
export interface DefaultHandler {
  progId: string;
  isDefault: boolean;
}

/** A crash-recovery snapshot (§5.11). */
export interface Snapshot {
  /** Stable snapshot ID. New snapshots use the tab UUID; the field name keeps
   *  recovery files from earlier session-based snapshots compatible. */
  sessionId: string;
  savedAt: string;
  filePath: string | null;
  markdown: string;
  isDirty: boolean;
}

/** The documents that were open, which the next start reopens. Untitled
 *  documents have no file and are left out. */
export interface Session {
  /** The files of the open documents, in tab order. */
  files: string[];
  /** The active document's file, or null when the active tab has none. */
  active: string | null;
}

/** An installed printer offered in the print workspace (§5.21). */
export interface PrinterInfo {
  name: string;
  isDefault: boolean;
}

/**
 * Native print parameters (§5.21). Downpad lays the sheets out itself — page
 * boxes already carry the margins, running header/footer and any scaling — so
 * the backend prints the page as-is: zero printer margins, no browser-added
 * header/footer, scale 1.
 */
export interface NativePrintOptions {
  /** Empty selects the system default printer. */
  printerName: string;
  copies: number;
  orientation: "portrait" | "landscape";
  /** Sheet size in inches, matching the rendered `.print-page` boxes. */
  pageWidthIn: number;
  pageHeightIn: number;
  /** "1-3,5" style range; empty prints every page. */
  pageRanges: string;
}

/** Result of a native print / print-to-PDF run, delivered as `print-completed`. */
export interface PrintCompleted {
  ok: boolean;
  /** Present when the run failed or the user cancelled at the printer. */
  message?: string;
}

/** A native operation error reported by the Electron main process. */
export interface AppError {
  kind: string;
  message: string;
}

/** Where an update check or download stands, as Settings > Updates shows it. */
export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "up-to-date" }
  | { status: "downloading"; version: string; percent: number | null }
  /** Downloaded and verified. It installs the next time Downpad starts. */
  | { status: "ready"; version: string }
  /** Newer than this copy, which cannot install it itself. */
  | { status: "available"; version: string; pageUrl: string }
  | { status: "failed"; message: string };

/** The update state of this copy of Downpad. */
export interface UpdateInfo {
  /** This copy's version, such as `1.2.3` or `1.2.3-rc1`. */
  version: string;
  /** Whether this copy installs updates itself: a copy installed from the MSI,
   *  AppImage or DEB package of a release. */
  selfUpdate: boolean;
  /** The last successful check, in epoch milliseconds, or null before one. */
  lastCheckMs: number | null;
  state: UpdateState;
}

/** Native spelling capabilities and the languages currently used by the checker. */
export interface SpellcheckInfo {
  availableLanguages: string[];
  activeLanguages: string[];
  systemLanguages: string[];
  languageSelectionSupported: boolean;
  dictionarySharedWithSystem: boolean;
}

/** One native right-click result. Actions must reference this context's identifier. */
export interface SpellingMenuContext {
  id: number;
  x: number;
  y: number;
  word: string;
  suggestions: string[];
}

/** Limit spelling actions to the current native context menu. */
export type SpellingMenuAction =
  | { contextId: number; action: "replace"; suggestion: string }
  | { contextId: number; action: "add" | "dismiss" | "native" };

/** What Git reports about an open document in a repository whose branch has
 *  a remote branch to upload to (Git, spec). */
export interface GitFileStatus {
  /** The work tree's top folder. */
  repositoryRoot: string;
  branch: string;
  /** Whether the saved document differs from the last commit, or is new. */
  changed: boolean;
  /** Local commits that change the document and are not uploaded. */
  unuploadedCommits: number;
  /** Local commits that the remote branch lacks. */
  ahead: number;
  /** Commits on the remote branch that are not here yet. */
  behind: number;
  /** The newest remote change to the document that is not here yet. */
  remoteChange: { commit: string; author: string; timeMs: number } | null;
  /** Why asking the remote for new commits failed, or null. */
  fetchError: string | null;
  /** Whether another Git program left a merge or rebase unfinished. */
  unfinishedOperation: boolean;
}

/** An open document, which Get latest and Upload reload or protect. */
export interface GitOpenFile {
  path: string;
  /** Whether the document has changes that are not saved. */
  unsaved: boolean;
}

/** How Upload, Get latest or discarding changes ended, without the files
 *  that changed. */
export type GitOutcome =
  | {
      kind: "done";
      /** Whether a commit reached the remote. */
      uploaded: boolean;
      /** Whose remote changes were combined into the document, or null. */
      combinedWith: string | null;
    }
  /** Nothing to get, or nothing to upload. */
  | { kind: "up-to-date" }
  /** The document and the remote changed the same lines. The document is
   *  unchanged. */
  | { kind: "conflict"; author: string; timeMs: number }
  /** These files have changes that are not saved or not uploaded, and the
   *  latest version would replace them. They are unchanged. */
  | { kind: "blocked"; files: string[] }
  | { kind: "failed"; message: string };

/** How Upload, Get latest or discarding changes ended. */
export type GitSyncResult = GitOutcome & {
  /** The open documents whose files changed, as the caller named them. An
   *  action that stopped after it got changes lists them too, so the caller
   *  can reload them. */
  changedOpenFiles: string[];
};
