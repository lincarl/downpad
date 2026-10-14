// Pure formatting + filtering helpers for the Recent view (spec §5.8). Kept
// framework-free and `now`-injectable so they're straightforward to unit-test.

import type { RecentEntry } from "../state/types";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Filename (final path segment) of a Windows or POSIX path. */
export function fileName(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.length ? segments[segments.length - 1] : path;
}

/** Parent folder of a path (original separators preserved); "" if none. */
export function dirName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return "";
  // Keep the separator when the parent is a root, so the result stays an absolute
  // path: a POSIX root ("/file" → "/") and a Windows drive root ("C:\file" → "C:\").
  if (idx === 0) return trimmed.slice(0, 1);
  if (idx === 2 && trimmed[1] === ":") return trimmed.slice(0, idx + 1);
  return trimmed.slice(0, idx);
}

/** Calendar-day difference (today = 0, yesterday = 1); negative clamps to 0. */
function calendarDaysAgo(ms: number, now: number): number {
  const startOfDay = (t: number): number => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  return Math.max(0, days);
}

/**
 * Relative phrasing matching the spec's examples: "Today", "Yesterday",
 * "5 days ago", then weeks / months / years for older entries.
 */
export function relativeDate(ms: number, now: number = Date.now()): string {
  const days = calendarDaysAgo(ms, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const w = Math.floor(days / 7);
    return w <= 1 ? "1 week ago" : `${w} weeks ago`;
  }
  if (days < 365) {
    const m = Math.floor(days / 30);
    return m <= 1 ? "1 month ago" : `${m} months ago`;
  }
  const y = Math.floor(days / 365);
  return y <= 1 ? "1 year ago" : `${y} years ago`;
}

/** Absolute date like "3 Jun 2026". */
export function absoluteDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Combined "Today · 3 Jun 2026" (relative + absolute), per the row layout. */
export function formatDate(ms: number, now: number = Date.now()): string {
  return `${relativeDate(ms, now)} · ${absoluteDate(ms)}`;
}

/** Human file size like "512 B", "12 KB", "1.2 MB". */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

/** Case-insensitive substring match against the filename only (spec §5.8). */
export function filterByName(entries: RecentEntry[], query: string): RecentEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => fileName(e.path).toLowerCase().includes(q));
}

/**
 * A content-search snippet as readable text: the line's Markdown markers go
 * (heading, quote, list and task markers, emphasis and code ticks), and table
 * cells read as "a · b · c" instead of pipes.
 */
export function plainSnippet(line: string): string {
  let text = line.trim();
  if (/^\|.*\|$/.test(text)) {
    text = text
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell !== "" && !/^:?-+:?$/.test(cell))
      .join(" · ");
  }
  return text
    .replace(/^(?:#{1,6}|>+)\s+/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/(?<![\w*`])(\*\*|__|\*|_|`)(\S(?:.*?\S)?)\1(?![\w*`])/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}
