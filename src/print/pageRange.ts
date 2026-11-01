// Custom print page ranges ("1-3, 5"). The workspace checks a range against the
// laid-out pages before printing, so a page that does not exist is reported
// beside the field instead of failing in the printer driver.

const RANGE_PART = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/;

/**
 * Why `range` cannot be printed from a document of `pageCount` pages, or null
 * when every page it names exists. Accepts the syntax the main process parses.
 * A `pageCount` of 0, before the pages are laid out, checks the syntax only.
 */
export function pageRangeError(range: string, pageCount: number): string | null {
  for (const part of range.split(",")) {
    const match = RANGE_PART.exec(part);
    if (!match) return "Use page numbers and ranges, such as 1-3, 5.";
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    if (from < 1 || to < 1) return "Page numbers start at 1.";
    if (to < from) return `Write ranges from low to high, such as ${to}-${from}.`;
    if (pageCount > 0 && to > pageCount) {
      return pageCount === 1 ? "This document has 1 page." : `This document has ${pageCount} pages.`;
    }
  }
  return null;
}
