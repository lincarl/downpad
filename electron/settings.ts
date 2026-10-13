import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import type { Settings } from "../src/state/types";
import { writeAtomic } from "./io";

const ENUMS: Partial<Record<keyof Settings, readonly unknown[]>> = {
  theme: ["system", "light", "dark"], editorTheme: ["follow-ui", "light", "dark"],
  accentMode: ["default", "system", "custom"], editorWidthMode: ["fill", "fixed"],
  linkDisplay: ["text-and-url", "text-only"], defaultView: ["document", "split", "markdown"],
  mdBulletChar: ["-", "*", "+"], mdEmphasisChar: ["*", "_"], mdStrongChar: ["**", "__"],
  mdHeadingStyle: ["atx", "setext"], printVersion: ["document", "markdown"],
  printPaperSize: ["a4", "letter", "legal", "a5"], printOrientation: ["portrait", "landscape"],
  printMargins: ["normal", "narrow", "wide", "none"],
};

/** Ignore malformed keys while retaining complete defaults for older settings files. */
export function normalizeSettings(input: unknown): Settings {
  const settings = { ...DEFAULT_SETTINGS };
  if (!input || typeof input !== "object" || Array.isArray(input)) return settings;
  const source = input as Record<string, unknown>;
  const target = settings as unknown as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const value = source[key];
    if (key === "defaultView" && (value === "wysiwyg" || value === "raw")) {
      settings.defaultView = value === "raw" ? "split" : "document";
    } else if (key === "mdHardWrap") {
      if (value === false || (typeof value === "number" && Number.isInteger(value) && value > 0)) target[key] = value;
    } else if (typeof value === typeof DEFAULT_SETTINGS[key] &&
      (typeof value !== "number" || (Number.isFinite(value) && value >= 0)) &&
      (!ENUMS[key] || ENUMS[key]?.includes(value))) {
      target[key] = value;
    }
  }
  settings.recentFilesMaxRetained = Math.floor(settings.recentFilesMaxRetained);
  settings.recentFilesVisibleCount = Math.min(Math.floor(settings.recentFilesVisibleCount), settings.recentFilesMaxRetained);
  settings.maxRetainedTabEditors = Math.max(1, Math.min(20, Math.floor(settings.maxRetainedTabEditors)));
  settings.printScalePercent = Math.max(50, Math.min(200, Math.round(settings.printScalePercent)));
  settings.printCopies = Math.max(1, Math.min(999, Math.floor(settings.printCopies)));
  return settings;
}

/** Locate a scalar TOML value without treating a quoted # as an inline comment. */
function scalarEnd(text: string, start: number): number {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") {
    let end = start;
    while (end < text.length && text[end] !== "\n" && text[end] !== "#" && text[end] !== "\r") end++;
    while (end > start && /\s/.test(text[end - 1]!)) end--;
    return end;
  }
  const delimiter = text.startsWith(quote.repeat(3), start) ? quote.repeat(3) : quote;
  let cursor = start + delimiter.length;
  while (cursor < text.length) {
    if (quote === '"' && text[cursor] === "\\") { cursor += 2; continue; }
    if (text.startsWith(delimiter, cursor)) {
      let end = cursor + delimiter.length;
      if (delimiter.length === 3) while (text[end] === quote) end++;
      return end;
    }
    cursor++;
  }
  return text.length;
}

export function patchSettingsToml(existing: string, settings: Settings): string {
  let text = existing;
  try { parse(text); } catch { text = "# md-easy settings\n# Changes are watched and applied live.\n"; }
  for (const [key, value] of Object.entries(settings)) {
    const scalar = JSON.stringify(value);
    // Root settings precede any optional user-defined tables.
    const table = text.search(/^\s*\[/m);
    const root = table < 0 ? text : text.slice(0, table);
    const match = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*`, "m").exec(root);
    if (match) {
      const start = match.index + match[0].length;
      text = text.slice(0, start) + scalar + text.slice(scalarEnd(text, start));
    } else {
      const separator = root.endsWith("\n") || root.length === 0 ? "" : "\n";
      text = root + separator + `${key} = ${scalar}\n` + (table < 0 ? "" : text.slice(table));
    }
  }
  return text;
}

export async function loadSettingsFile(path: string): Promise<Settings> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await writeAtomic(path, patchSettingsToml("", DEFAULT_SETTINGS));
    }
    return { ...DEFAULT_SETTINGS };
  }
  try { return normalizeSettings(parse(text)); } catch { return { ...DEFAULT_SETTINGS }; }
}

export async function saveSettingsFile(path: string, input: unknown): Promise<void> {
  const existing = await readFile(path, "utf8").catch(() => "");
  await writeAtomic(path, patchSettingsToml(existing, normalizeSettings(input)));
}
