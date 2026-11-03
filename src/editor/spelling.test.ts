// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proseWords, SpellingController, spellingAt, spellingEdits } from "./spelling";

const native = vi.hoisted(() => ({
  checkSpelling: vi.fn<(words: string[]) => Promise<string[]>>(),
  spellingSuggestions: vi.fn(async () => ["spelling"]),
  invoke: vi.fn(async () => {}),
  listen: vi.fn((_event: string, _handler: () => void) => () => {}),
}));
vi.mock("../ipc/bridge", () => ({ desktopBridge: () => native }));

const controllers: SpellingController[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  native.checkSpelling.mockReset().mockImplementation(async (words) => words.filter((word) => word !== "spelling" && word !== "correct"));
  native.invoke.mockClear();
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.destroy();
  vi.useRealTimers();
});

/** A model adapter whose identity changes only when its text changes. */
function setup(initial = "speling") {
  let model = { text: initial };
  const root = document.createElement("div");
  const paint = vi.fn();
  const replace = vi.fn();
  const controller = new SpellingController({
    root,
    snapshot: () => { const current = model; return { token: current, words: async () => proseWords(current.text) }; },
    positionAt: () => 2,
    paint,
    replace,
  });
  controllers.push(controller);
  controller.setEnabled(true);
  return { controller, root, paint, replace, change(text: string) { model = { text }; controller.changed(); } };
}

describe("model spelling", () => {
  it("checks loaded text and changed words without a trailing space, caching unchanged words", async () => {
    const { controller, change, paint } = setup("correct spelling");
    await vi.advanceTimersByTimeAsync(300);
    expect(native.checkSpelling).toHaveBeenLastCalledWith(["correct", "spelling"]);
    change("correct speling");
    await vi.advanceTimersByTimeAsync(299);
    expect(native.checkSpelling).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(native.checkSpelling).toHaveBeenLastCalledWith(["speling"]);
    expect(paint).toHaveBeenLastCalledWith([{ word: "speling", from: 8, to: 15 }]);
    await controller.scan();
    expect(native.checkSpelling).toHaveBeenLastCalledWith(["correct", "speling"]);
  });

  it("discards results from an edited or disposed model", async () => {
    let reply: (words: string[]) => void = () => {};
    native.checkSpelling.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
    const { controller, change, paint } = setup();
    const scanning = controller.scan();
    const rejected = expect(scanning).rejects.toThrow("document changed");
    await Promise.resolve();
    await Promise.resolve();
    change("spelling");
    reply(["speling"]);
    await rejected;
    expect(paint).toHaveBeenLastCalledWith([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(paint).toHaveBeenLastCalledWith([]);
    controller.destroy();
    change("speling");
    await vi.advanceTimersByTimeAsync(300);
    expect(native.checkSpelling).toHaveBeenCalledTimes(2);
  });

  it("clears marks and cached correctness on disable and dictionary changes", async () => {
    const { controller, paint } = setup();
    await controller.scan();
    controller.setEnabled(false);
    expect(paint).toHaveBeenLastCalledWith([]);
    await expect(controller.scan()).rejects.toThrow("turned off");
    controller.setEnabled(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(native.checkSpelling).toHaveBeenCalledTimes(2);
    native.listen.mock.calls.at(-1)?.[1]();
    expect(paint).toHaveBeenLastCalledWith([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(native.checkSpelling).toHaveBeenCalledTimes(3);
  });

  it("waits for IME composition to finish before checking", async () => {
    const { controller, root, change, paint } = setup("correct");
    root.dispatchEvent(new CompositionEvent("compositionstart"));
    change("speling");
    paint.mockClear();
    native.listen.mock.calls.at(-1)?.[1]();
    await vi.advanceTimersByTimeAsync(500);
    expect(native.checkSpelling).not.toHaveBeenCalled();
    expect(paint).not.toHaveBeenCalled();
    await expect(controller.scan()).rejects.toThrow("Finish composing");
    root.dispatchEvent(new CompositionEvent("compositionend"));
    await vi.advanceTimersByTimeAsync(300);
    expect(native.checkSpelling).toHaveBeenLastCalledWith(["speling"]);
  });

  it("does not cache dictionary failures as correct spelling", async () => {
    native.checkSpelling.mockRejectedValue(new Error("dictionary unavailable"));
    const { controller, paint } = setup();
    await expect(controller.scan()).rejects.toThrow("dictionary unavailable");
    await expect(controller.scan(false)).rejects.toThrow("dictionary unavailable");
    expect(native.checkSpelling).toHaveBeenCalledTimes(2);
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it("checks a right-click immediately and rejects stale corrections", async () => {
    const { root, controller, change, replace } = setup();
    const choice = await spellingAt(root, 0, 0);
    expect(choice?.word).toBe("speling");
    await controller.scan();
    await choice?.replace("spelling");
    expect(replace).toHaveBeenCalledWith({ word: "speling", from: 0, to: 7 }, "spelling");
    change("different");
    await expect(choice?.replace("spelling")).rejects.toThrow("word changed");
    await expect(choice?.add()).rejects.toThrow("word changed");
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("uses bounded batches for a complete scan and counts word occurrences", async () => {
    const { controller } = setup([...Array.from({ length: 520 }, (_, i) => `word${i}`), "word0"].join(" "));
    const scan = controller.scan();
    await vi.runAllTimersAsync();
    expect(await scan).toBe(521);
    expect(native.checkSpelling.mock.calls.map(([words]) => words.length)).toEqual([256, 256, 8]);
  });
});

describe("prose word boundaries", () => {
  it("keeps Unicode words and apostrophes and skips URLs, email and numbers", () => {
    expect(proseWords("Café naïve don't blåbær 123 https://example.invalid/typpo user@example.invalid").map(({ word }) => word))
      .toEqual(["Café", "naïve", "don't", "blåbær"]);
  });

  it("preserves source formatting when replacing a word split across markers", () => {
    const word = { word: "speling", from: 0, to: 11, parts: [{ from: 0, to: 2 }, { from: 4, to: 6 }, { from: 8, to: 11 }] };
    let text = "sp**el**ing";
    for (const edit of spellingEdits(word, "spelling").reverse()) text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
    expect(text.replaceAll("**", "")).toBe("spelling");
    expect(text.match(/\*\*/g)).toHaveLength(2);
  });
});
