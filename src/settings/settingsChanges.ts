// Compare settings and find what changed between two sets, for the Settings
// dialog and for SettingsModel's writes.

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

/** The keys of `changes` whose values `settings` holds. */
export function heldChanges(settings: Settings, changes: Partial<Settings>): (keyof Settings)[] {
  return (Object.keys(changes) as (keyof Settings)[]).filter((key) => sameValue(settings[key], changes[key]));
}

