// Words for the Git status and notices, for people who do not use Git.

import type { GitState } from "@/state/types";

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 60 * 60_000],
  ["month", 30 * 24 * 60 * 60_000],
  ["week", 7 * 24 * 60 * 60_000],
  ["day", 24 * 60 * 60_000],
  ["hour", 60 * 60_000],
  ["minute", 60_000],
];

/** "5 minutes ago", "yesterday", or "just now" for less than a minute. */
export function timeAgo(timeMs: number, nowMs = Date.now()): string {
  const elapsed = Math.max(0, nowMs - timeMs);
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (elapsed >= size) return format.format(-Math.floor(elapsed / size), unit);
  }
  return "just now";
}

/** The status bar's words for the active document's Git state, and the
 *  longer explanation for its tooltip. */
export function gitStatusText(git: GitState, unsaved: boolean): { text: string; detail: string } {
  if (git.activity === "uploading") return { text: "Uploading…", detail: "Downpad is uploading this document." };
  if (git.activity === "getting-latest") return { text: "Getting latest…", detail: "Downpad is getting the latest version." };
  const { status } = git;
  if (unsaved || status.changed || status.unuploadedCommits > 0) {
    return { text: "Not uploaded", detail: "This document has changes that are not uploaded yet." };
  }
  if (status.remoteChange) {
    return { text: "Newer version available", detail: `${status.remoteChange.author} uploaded a newer version ${timeAgo(status.remoteChange.timeMs)}.` };
  }
  if (git.problem) return { text: "Cannot check for changes", detail: git.problem };
  return { text: "Up to date", detail: `This document matches the uploaded version on ${status.branch}.` };
}

/** The file name at the end of a path. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** "notes (my version).md" beside "notes.md". */
export function myVersionPath(path: string): string {
  const name = fileName(path);
  const folder = path.slice(0, path.length - name.length);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : ".md";
  return `${folder}${stem} (my version)${extension}`;
}

/** "a.md", "a.md and b.md", or "a.md, b.md and 3 more". */
export function listFiles(paths: readonly string[]): string {
  const names = paths.map(fileName);
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}
