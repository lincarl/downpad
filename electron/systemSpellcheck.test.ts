import { describe, expect, it, vi } from "vitest";
import { spellingWord, spellingWords } from "./spellingRequests";
import { systemSpellingLanguage, WindowsSpelling } from "./systemSpellcheck";

describe("Windows language resolution", () => {
  it("maps Chromium base IDs to installed regional dictionaries", () => {
    expect(systemSpellingLanguage("nb", ["nb-NO", "en-US"], [])).toBe("nb-NO");
    expect(systemSpellingLanguage("sv", ["sv-FI", "sv-SE"], [])).toBe("sv-SE");
    expect(systemSpellingLanguage("sv", ["sv-FI", "sv-SE"], ["sv-FI"])).toBe("sv-FI");
    expect(systemSpellingLanguage("en-US", ["en-GB", "en-US"], ["en-GB"])).toBe("en-US");
  });

  it("preserves explicit regions and scripts instead of silently checking another language", () => {
    expect(systemSpellingLanguage("en-GB", ["en-US"], [])).toBeUndefined();
    expect(systemSpellingLanguage("sr-Latn", ["sr-Cyrl-RS", "sr-Latn-RS"], [])).toBe("sr-Latn-RS");
    expect(systemSpellingLanguage("sr-Latn", ["sr-Cyrl-RS"], [])).toBeUndefined();
  });
});

describe("Windows spelling batches", () => {
  /** Make independent fake checkers whose language selection affects their results. */
  function fixture() {
    const create = vi.fn(() => {
      let language = "";
      return {
        getLanguages: () => ["en-US", "sv-SE"],
        setLanguage: (value: string) => { language = value; return true; },
        check: (word: string) => (language === "en-US" ? word === "hello" : word === "hej") ? [] : [{ start: 0, length: word.length }],
        getSuggestions: () => language === "en-US" ? ["hello", "help"] : ["hej", "help"],
      };
    });
    return { create, checker: new WindowsSpelling(create) };
  }

  it("accepts words in any selected dictionary without querying Hunspell for native-only selections", () => {
    const { checker, create } = fixture();
    expect(checker.check(["hello", "hej", "helo"], ["en-US", "sv"], [])).toEqual({ words: ["helo"], useHunspell: false });
    expect(checker.suggestions("helo", ["en-US", "sv"], [])).toEqual({ suggestions: ["hello", "help", "hej"], useHunspell: false });
    expect(create).toHaveBeenCalledTimes(2);
    checker.invalidate();
    checker.check(["helo"], ["en-US", "sv"], []);
    expect(create).toHaveBeenCalledTimes(4);
  });

  it("consults Hunspell only when an active language lacks OS support", () => {
    const { checker } = fixture();
    expect(checker.check(["hello", "hej"], ["en-US", "nb"], [])).toEqual({ words: ["hej"], useHunspell: true });
    expect(checker.hunspellLanguages(["en-US", "nb"], [])).toEqual(["nb"]);
    expect(checker.check(["hello"], ["en-GB"], [])).toEqual({ words: ["hello"], useHunspell: true });
  });

  it("reports native load, dictionary-open, and checking failures", () => {
    const missing = new WindowsSpelling(() => { throw new Error("Addon unavailable"); });
    expect(() => missing.check(["word"], ["en-US"], [])).toThrow("Addon unavailable");
    const failing = {
      getLanguages: () => ["en-US"], setLanguage: vi.fn(() => false),
      check: () => { throw new Error("OS check failed"); }, getSuggestions: () => [],
    };
    const checker = new WindowsSpelling(() => failing);
    expect(() => checker.check(["word"], ["en-US"], [])).toThrow("could not be opened");
    failing.setLanguage.mockReturnValue(true);
    expect(() => checker.check(["word"], ["en-US"], [])).toThrow("OS check failed");
  });
});

describe("spelling IPC validation", () => {
  it("allows bounded Unicode words and rejects malformed or oversized input", () => {
    expect(spellingWords(["hello", "Ångström", "can't"])).toEqual(["hello", "Ångström", "can't"]);
    expect(spellingWords([])).toEqual([]);
    for (const value of [null, {}, "hello", Array.from({ length: 257 }, () => "word")]) {
      expect(() => spellingWords(value)).toThrow("256");
    }
    for (const value of [null, 1, "", "two words", "line\nbreak", "null\0byte", "\ud800", "x".repeat(129)]) {
      expect(() => spellingWord(value)).toThrow("single word");
      expect(() => spellingWords([value])).toThrow("single word");
    }
  });
});
