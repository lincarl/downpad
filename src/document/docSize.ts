// File and document sizes (spec §6.1). The status bar shows the size of the
// document's file (`documentSize`), so embedded base64 images are counted.
// Every size in the app uses formatSize, so the status bar, Recent and the
// Markdown view read the same way.

import type { DocumentState } from "../state/types";

/** UTF-8 byte length of a string (matches what gets written to disk). */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The size in bytes of a document's file. While the document has no unsaved
 * changes, that is the size recorded with the version of the file it shows,
 * which counts a byte order mark too. Otherwise it is the size a save would
 * write: the text as UTF-8, with two bytes for each line break of a document
 * that has Windows line endings. The text itself always has one-byte breaks.
 */
export function documentSize(doc: Pick<DocumentState, "markdown" | "eol" | "isDirty" | "fileSize">): number {
  if (!doc.isDirty && doc.fileSize !== undefined) return doc.fileSize;
  const lineBreaks = doc.eol === "crlf" ? (doc.markdown.match(/\n/g)?.length ?? 0) : 0;
  return byteLength(doc.markdown) + lineBreaks;
}

const SIZE_UNITS = ["KB", "MB", "GB"] as const;

/**
 * A size with KB as the smallest unit: "0.4 KB", "12 KB", "1.5 MB". One decimal
 * under 10 of a unit, whole numbers above. A size that is not empty never reads
 * as 0, and an invalid size gives "".
 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes === 0) return "0 KB";
  let value = Math.max(bytes / 1024, 0.1);
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value < 10 ? value.toFixed(1) : Math.round(value).toLocaleString();
  return `${digits} ${SIZE_UNITS[unit]}`;
}
