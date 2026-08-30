// Line-ending and BOM handling (spec §5.18).
//
// The canonical in-memory markdown string is always LF-normalized. The original
// EOL style is detected on open and re-applied on save so files round-trip.
// New documents default to LF. A BOM, if present on open, is stripped on save.

import type { Eol } from "../state/types";

const BOM = "﻿";

/** Strip a leading UTF-8 BOM if present. Returns [stripped, hadBom]. */
export function stripBom(text: string): [string, boolean] {
  if (text.startsWith(BOM)) return [text.slice(1), true];
  return [text, false];
}

/**
 * Detect the dominant EOL style of raw file text. Counts CRLF vs lone LF;
 * ties and CRLF-majority resolve to "crlf". Empty/markerless text → "lf".
 */
export function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  // Lone LF = total LF minus those that are part of a CRLF.
  const totalLf = (text.match(/\n/g) ?? []).length;
  const loneLf = totalLf - crlf;
  if (crlf === 0 && loneLf === 0) return "lf";
  return crlf >= loneLf ? "crlf" : "lf";
}

/** Normalize any mix of CRLF/CR/LF to LF (the canonical in-memory form). */
export function normalizeToLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Apply the target EOL style to LF-normalized text for writing to disk. */
export function applyEol(lfText: string, eol: Eol): string {
  if (eol === "crlf") return lfText.replace(/\n/g, "\r\n");
  return lfText;
}
