// @vitest-environment jsdom
// Replace in the document view, with the real editor: Replace moves on to the
// next match.

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";
import type { FindOptions } from "./findEngine";

// Crepe's code block view watches whether it is on screen, which jsdom cannot tell.
vi.stubGlobal("IntersectionObserver", class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});

const opts: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the document editor on `markdown`. */
async function open(markdown: string): Promise<WysiwygEditor> {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange: () => {} }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  return editor;
}

/** The text of the block that holds the current match. */
const currentBlock = () => document.querySelector(".md-find-current")?.closest("p, h1")?.textContent;

describe("replace in the document view", () => {
  it("moves on to the next match after Replace", { timeout: 60_000 }, async () => {
    const editor = await open("# Heading alpha\n\nalpha one\n\nalpha two\n\nalpha three\n");
    expect(editor.search("alpha", opts)).toEqual({ current: 1, total: 4 });
    editor.findNext();
    expect(editor.findNext()).toEqual({ current: 3, total: 4 });

    expect(editor.replaceCurrent("BETA", "alpha", opts)).toEqual({ current: 3, total: 3 });
    expect(currentBlock()).toBe("alpha three");
    expect(editor.getMarkdown()).toBe("# Heading alpha\n\nalpha one\n\nBETA two\n\nalpha three\n");

    // After the last match it wraps to the first.
    expect(editor.replaceCurrent("BETA", "alpha", opts)).toEqual({ current: 1, total: 2 });
    expect(currentBlock()).toBe("Heading alpha");
  });

  it("skips a replacement that contains the query", { timeout: 60_000 }, async () => {
    const editor = await open("cat one\n\ncat two\n");
    editor.search("cat", opts);
    expect(editor.replaceCurrent("cats", "cat", opts)).toEqual({ current: 2, total: 2 });
    expect(currentBlock()).toBe("cat two");
  });
});
