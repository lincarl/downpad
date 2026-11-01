// Line-ending and BOM handling (spec §5.18).
//
// The canonical in-memory markdown string is always LF-normalized. The main
// process (electron/io.ts) detects the original EOL style on open and re-applies
// it on save so files round-trip. New documents default to LF. A BOM, if present
// on open, is stripped on save. The helpers here normalize text that enters a
// document another way, such as a paste.

const BOM = "﻿";

/** Strip a leading UTF-8 BOM if present. Returns [stripped, hadBom]. */
export function stripBom(text: string): [string, boolean] {
  if (text.startsWith(BOM)) return [text.slice(1), true];
  return [text, false];
}

/** Normalize any mix of CRLF/CR/LF to LF (the canonical in-memory form). */
export function normalizeToLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
