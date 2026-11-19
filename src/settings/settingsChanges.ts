// Compare settings and find what changed between two sets, for the Settings
// dialog, Print and SettingsModel's writes.

import type { Settings } from "../state/types";

/** Whether two setting values are the same, also for a list of languages. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether two sets of settings hold the same values. */
export function sameSettings(a: Settings, b: Settings): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Settings>;
  return [...keys].every((key) => sameValue(a[key], b[key]));
}

/** The settings in `next` that differ from `base`. */
export function changesFrom(base: Settings, next: Settings): Partial<Settings> {
  const keys = (Object.keys(next) as (keyof Settings)[]).filter((key) => !sameValue(next[key], base[key]));
  return Object.fromEntries(keys.map((key) => [key, next[key]]));
}

/** The values `written` holds for the settings in `changes`. With either
 *  recent files number, both, since the limit on one can change the other. */
export function writtenValues(changes: Partial<Settings>, written: Settings): Partial<Settings> {
  const keys = Object.keys(changes) as (keyof Settings)[];
  if ("recentFilesVisibleCount" in changes || "recentFilesMaxRetained" in changes) {
    keys.push("recentFilesVisibleCount", "recentFilesMaxRetained");
  }
  return Object.fromEntries(keys.map((key) => [key, written[key]]));
}

/** `settings` showing no more recent files than they keep, as the desktop
 *  app's settings file stores them. */
export function withRecentLimit(settings: Settings): Settings {
  if (settings.recentFilesVisibleCount <= settings.recentFilesMaxRetained) return settings;
  return { ...settings, recentFilesVisibleCount: settings.recentFilesMaxRetained };
}
