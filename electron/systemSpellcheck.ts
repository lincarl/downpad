import { createRequire } from "node:module";
import type { NativeSpellingResult, NativeSuggestionsResult } from "./spellingRequests";

/** The small N-API contract used from the pinned Windows spelling addon. */
export interface SystemSpellchecker {
  getLanguages(): string[];
  setLanguage(language: string): boolean;
  check(text: string): { start: number; length: number }[];
  getSuggestions(word: string): string[];
}

/** Load the copied N-API binary only when Windows spelling is requested. */
function createSystemSpellchecker(): SystemSpellchecker {
  const addon = createRequire(import.meta.url)("./spellcheck.node") as { SpellChecker: new () => SystemSpellchecker };
  return new addon.SpellChecker();
}

/** Resolve generic Chromium IDs without replacing an explicitly selected region or script. */
export function systemSpellingLanguage(language: string, available: readonly string[], preferred: readonly string[]): string | undefined {
  const requested = new Intl.Locale(language.replaceAll("_", "-"));
  const exact = available.find((candidate) => candidate.toLowerCase() === requested.baseName.toLowerCase());
  if (exact) return exact;
  const matches = available.filter((candidate) => {
    const locale = new Intl.Locale(candidate);
    return locale.language === requested.language && (!requested.region || locale.region === requested.region) &&
      (!requested.script || locale.maximize().script === requested.script);
  });
  for (const preference of preferred) {
    const match = matches.find((candidate) => candidate.toLowerCase() === preference.replaceAll("_", "-").toLowerCase());
    if (match) return match;
  }
  const likely = requested.maximize();
  return matches.find((candidate) => {
    const locale = new Intl.Locale(candidate).maximize();
    return locale.region === likely.region && locale.script === likely.script;
  }) ?? matches[0];
}

/** Keep Windows dictionaries on the main thread and consult every selected language. */
export class WindowsSpelling {
  private configured: { key: string; checkers: SystemSpellchecker[]; useHunspell: boolean; hunspellLanguages: string[] } | undefined;

  constructor(private readonly create: () => SystemSpellchecker = createSystemSpellchecker) {}

  /** Recreate native instances after language or custom dictionary changes. */
  invalidate(): void {
    this.configured = undefined;
  }

  /** Identify dictionaries whose readiness must be checked before using webFrame. */
  hunspellLanguages(languages: string[], preferred: string[]): string[] {
    return this.dictionaries(languages, preferred).hunspellLanguages;
  }

  /** Reject a word only when every selected native dictionary rejects it. */
  check(words: string[], languages: string[], preferred: string[]): NativeSpellingResult {
    const { checkers, useHunspell } = this.dictionaries(languages, preferred);
    return { words: words.filter((word) => checkers.every((checker) => checker.check(word).length > 0)), useHunspell };
  }

  /** Combine native suggestions without returning more than the menu can show. */
  suggestions(word: string, languages: string[], preferred: string[]): NativeSuggestionsResult {
    const { checkers, useHunspell } = this.dictionaries(languages, preferred);
    return { suggestions: [...new Set(checkers.flatMap((checker) => checker.getSuggestions(word)))].slice(0, 6), useHunspell };
  }

  /** Distinguish missing OS language packs from failures of an installed dictionary. */
  private dictionaries(languages: string[], preferred: string[]) {
    const key = JSON.stringify([languages, preferred]);
    if (this.configured?.key === key) return this.configured;
    if (!languages.length) throw new Error("No spelling dictionary is selected.");
    const first = this.create();
    const available = first.getLanguages();
    const checkers: SystemSpellchecker[] = [];
    const selected = new Set<string>();
    const hunspellLanguages: string[] = [];
    for (const language of languages) {
      const resolved = systemSpellingLanguage(language, available, preferred);
      if (!resolved) { hunspellLanguages.push(language); continue; }
      if (selected.has(resolved)) continue;
      const checker = checkers.length ? this.create() : first;
      if (!checker.setLanguage(resolved)) throw new Error(`The Windows spelling dictionary for ${resolved} could not be opened.`);
      selected.add(resolved);
      checkers.push(checker);
    }
    this.configured = { key, checkers, useHunspell: hunspellLanguages.length > 0, hunspellLanguages };
    return this.configured;
  }
}
