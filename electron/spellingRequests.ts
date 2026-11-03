/** Validate a bounded word batch before either native spelling implementation runs. */
export function spellingWords(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error("Check at most 256 words at a time.");
  for (const word of value) spellingWord(word);
  return value as string[];
}

/** Reject whitespace, control characters, and oversized spelling requests. */
export function spellingWord(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128 || /[\s\p{Cc}\p{Cs}]/u.test(value)) {
    throw new Error("Enter a single word of at most 128 characters, without spaces.");
  }
  return value;
}

/** Words not accepted by custom or Windows dictionaries, still needing any renderer check. */
export interface NativeSpellingResult {
  words: string[];
  useHunspell: boolean;
}

/** Native corrections and whether the renderer must consult a fallback dictionary. */
export interface NativeSuggestionsResult {
  suggestions: string[];
  useHunspell: boolean;
}
