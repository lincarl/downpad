import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { parse } from "smol-toml";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import { normalizeSettings, patchSettingsToml } from "./settings";
import { Spellchecker, systemSpellcheckLanguages } from "./spellcheck";
import { WindowsSpelling } from "./systemSpellcheck";

/** A native-session substitute that keeps language and custom-word state. */
function fixture(platform = "linux", changed = vi.fn(), windows?: WindowsSpelling) {
  let languages = ["en-US"];
  const words = new Set(["Downpad", "Zorblax"]);
  const session = Object.assign(new EventEmitter(), {
    availableSpellCheckerLanguages: ["en-US", "en-GB", "sv", "nb"],
    getSpellCheckerLanguages: () => languages,
    setSpellCheckerLanguages: vi.fn((selected: string[]) => { languages = selected; }),
    setSpellCheckerEnabled: vi.fn(),
    listWordsInSpellCheckerDictionary: vi.fn(async () => [...words]),
    addWordToSpellCheckerDictionary: vi.fn((word: string) => { words.add(word); return true; }),
    removeWordFromSpellCheckerDictionary: vi.fn((word: string) => words.delete(word)),
  });
  return { session, changed, checker: new Spellchecker(session, platform, () => ["sv-SE", "en-GB"], changed, windows) };
}

describe("native spelling preferences", () => {
  it("maps regional OS preferences to available dictionaries and deduplicates them", () => {
    expect(systemSpellcheckLanguages(["nb_NO", "en-GB", "nb"], ["en-US", "en-GB", "nb"]))
      .toEqual(["nb", "en-GB"]);
    expect(systemSpellcheckLanguages(["zz"], ["sv", "en-US"])).toEqual(["en-US"]);
    expect(systemSpellcheckLanguages([], [])).toEqual([]);
  });

  it("uses multiple saved languages, restores OS defaults, and applies the enabled toggle", () => {
    const { checker, session } = fixture();
    checker.apply({ spellCheckEnabled: true, spellCheckLanguages: ["en-GB", "nb", "nb", "zz"] });
    expect(checker.info().activeLanguages).toEqual(["en-GB", "nb"]);
    checker.apply({ spellCheckEnabled: false, spellCheckLanguages: [] });
    expect(checker.info().activeLanguages).toEqual(["sv", "en-GB"]);
    expect(session.setSpellCheckerEnabled).toHaveBeenLastCalledWith(false);
    checker.apply({ spellCheckEnabled: true, spellCheckLanguages: ["zz"] });
    expect(checker.info().activeLanguages).toEqual(["sv", "en-GB"]);
    expect(session.setSpellCheckerLanguages).toHaveBeenCalledTimes(2);
  });

  it("leaves macOS language selection to the OS and reports the shared dictionary", () => {
    const { checker, session } = fixture("darwin");
    checker.apply({ spellCheckEnabled: true, spellCheckLanguages: ["nb"] });
    expect(session.setSpellCheckerLanguages).not.toHaveBeenCalled();
    expect(checker.info()).toMatchObject({ languageSelectionSupported: false, dictionarySharedWithSystem: true });
    expect(fixture("win32").checker.info().dictionarySharedWithSystem).toBe(true);
    expect(fixture().checker.info().dictionarySharedWithSystem).toBe(false);
  });

  it("validates language arrays and round-trips them without losing TOML comments", () => {
    for (const value of [null, {}, "en-US", ["en-US", 3], ["en-US", ""], ["bad value"]]) {
      expect(normalizeSettings({ spellCheckLanguages: value }).spellCheckLanguages).toEqual([]);
    }
    const settings = normalizeSettings({ spellCheckLanguages: ["sv", "en-US", "sv", "zz"] });
    expect(settings.spellCheckLanguages).toEqual(["sv", "en-US", "zz"]);
    const toml = patchSettingsToml('spellCheckLanguages = ["en-US"] # languages\ncustom = 42\n', settings);
    expect(toml).toContain('# languages\ncustom = 42');
    expect(parse(toml)).toMatchObject({ spellCheckLanguages: ["sv", "en-US", "zz"], custom: 42 });
    expect(normalizeSettings({}).spellCheckLanguages).toEqual(DEFAULT_SETTINGS.spellCheckLanguages);
  });
});

describe("native custom dictionary", () => {
  it("retains old words while adding and removing individual entries", async () => {
    const { checker, session } = fixture();
    expect(await checker.words()).toEqual(["Downpad", "Zorblax"]);
    await checker.add("Ångströmnix");
    await checker.remove("Zorblax");
    expect(await checker.words()).toEqual(["Ångströmnix", "Downpad"]);
    await checker.add("Downpad");
    await checker.remove("missing");
    expect(session.addWordToSpellCheckerDictionary).toHaveBeenCalledTimes(1);
    expect(session.removeWordFromSpellCheckerDictionary).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid words and reports native read and write failures", async () => {
    const { checker, session } = fixture();
    for (const word of ["", "two words", "line\nbreak", "null\0byte", "x".repeat(129)]) {
      await expect(checker.add(word)).rejects.toThrow("Enter a single word");
    }
    expect(session.addWordToSpellCheckerDictionary).not.toHaveBeenCalled();
    session.addWordToSpellCheckerDictionary.mockReturnValue(false);
    await expect(checker.add("newword")).rejects.toThrow("could not be added");
    session.removeWordFromSpellCheckerDictionary.mockReturnValue(false);
    await expect(checker.remove("Downpad")).rejects.toThrow("could not be removed");
    session.listWordsInSpellCheckerDictionary.mockRejectedValue(new Error("Read failed"));
    await expect(checker.words()).rejects.toThrow("Read failed");
  });
});

describe("on-demand native spelling", () => {
  it("filters session custom words before asking the renderer on Linux", async () => {
    const { checker, session } = fixture();
    session.emit("spellcheck-dictionary-initialized", {}, "en-US");
    expect(await checker.check(["Downpad", "typo"])).toEqual({ words: ["typo"], useHunspell: true });
    await checker.add("typo");
    expect(await checker.check(["typo"])).toEqual({ words: [], useHunspell: true });
    await checker.remove("typo");
    expect(await checker.check(["typo"])).toEqual({ words: ["typo"], useHunspell: true });
  });

  it("waits for loaded dictionaries, reports failed downloads, and removes listeners", () => {
    const { checker, session, changed } = fixture();
    checker.apply({ spellCheckEnabled: true, spellCheckLanguages: ["en-US", "sv"] });
    expect(() => checker.ready()).toThrow("still loading");
    session.emit("spellcheck-dictionary-initialized", {}, "en-US");
    expect(() => checker.ready()).toThrow("sv");
    session.emit("spellcheck-dictionary-download-failure", {}, "sv");
    expect(() => checker.ready()).toThrow("could not be downloaded");
    session.emit("spellcheck-dictionary-initialized", {}, "sv");
    expect(() => checker.ready()).not.toThrow();
    expect(changed).toHaveBeenCalledTimes(4);
    checker.dispose();
    expect(session.listenerCount("spellcheck-dictionary-initialized")).toBe(0);
    expect(session.listenerCount("spellcheck-dictionary-download-failure")).toBe(0);
  });

  it("honors custom words and rebuilds Windows checkers after dictionary changes", async () => {
    const create = vi.fn(() => ({
      getLanguages: () => ["en-US"], setLanguage: () => true,
      check: () => [{ start: 0, length: 1 }], getSuggestions: () => ["word"],
    }));
    const { checker, changed } = fixture("win32", vi.fn(), new WindowsSpelling(create));
    expect(await checker.check(["Downpad", "typo"])).toEqual({ words: ["typo"], useHunspell: false });
    await checker.add("typo");
    expect(await checker.check(["typo"])).toEqual({ words: [], useHunspell: false });
    await checker.remove("typo");
    expect(await checker.check(["typo"])).toEqual({ words: ["typo"], useHunspell: false });
    expect(create).toHaveBeenCalledTimes(3);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("requires only actual Hunspell fallback dictionaries to finish loading on Windows", async () => {
    const create = () => ({
      getLanguages: () => ["en-US"], setLanguage: () => true,
      check: () => [{ start: 0, length: 1 }], getSuggestions: () => [],
    });
    const { checker, session } = fixture("win32", vi.fn(), new WindowsSpelling(create));
    checker.apply({ spellCheckEnabled: true, spellCheckLanguages: ["en-US", "sv"] });
    await expect(checker.check(["typo"])).rejects.toThrow("still loading (sv)");
    session.emit("spellcheck-dictionary-initialized", {}, "sv");
    expect(await checker.check(["typo"])).toEqual({ words: ["typo"], useHunspell: true });
  });
});
