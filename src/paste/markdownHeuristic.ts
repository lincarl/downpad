// Decides whether a chunk of plain text is "probably markdown" so the smart-paste
// pipeline (spec §5.4, step 3) can parse it as markdown rather than dropping it in
// as a literal paragraph. The signals are exactly those the spec enumerates:
// ATX headings, fenced code, table separators, links, bold, and list markers.
//
// Deliberately conservative on the bold/link side (requires non-empty content
// between the markers) so ordinary prose with a stray `*` or `-` is treated as
// plain text, not markdown.

const SIGNALS: RegExp[] = [
  /^#{1,6}\s+\S/m, // ATX heading:            # Title
  /^[ \t]*(?:```|~~~)/m, // fenced code block:      ```
  /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*\|[ \t]*:?-{0,}/m, // table separator: | --- | --- |
  /\[[^\]]+\]\([^)\s]+\)/, // inline link:            [text](url)
  /\*\*[^\s*][^*]*\*\*/, // bold:                   **bold**
  /__[^\s_][^_]*__/, // bold (alt):             __bold__
  /^[ \t]*[-*+][ \t]+\S/m, // unordered list:         - item
  /^[ \t]*\d+\.[ \t]+\S/m, // ordered list:           1. item
  /^[ \t]*>[ \t]+\S/m, // block quote:            > quote
];

/** True if `text` shows at least one markdown structural signal (spec §5.4). */
export function looksLikeMarkdown(text: string): boolean {
  if (!text) return false;
  return SIGNALS.some((re) => re.test(text));
}
