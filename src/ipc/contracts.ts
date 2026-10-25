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
