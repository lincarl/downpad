// Relative + absolute timestamp formatting for the recent-files list (spec
// §5.8.1: "2 min ago", "yesterday", "3 weeks ago", with the absolute time on
// hover). Pure functions so they're unit-testable; `now` is injectable.

export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 45) return min <= 1 ? "1 min ago" : `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr === 1 ? "1 hour ago" : `${hr} hours ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day} days ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return wk === 1 ? "1 week ago" : `${wk} weeks ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return mo <= 1 ? "1 month ago" : `${mo} months ago`;
  const yr = Math.floor(day / 365);
  return yr <= 1 ? "1 year ago" : `${yr} years ago`;
}

/** Locale absolute timestamp for the hover tooltip; "" for invalid input. */
export function absoluteTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t).toLocaleString();
}
