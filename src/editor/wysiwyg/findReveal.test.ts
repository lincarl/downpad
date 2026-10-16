// @vitest-environment jsdom
// Find in the document view highlights matches inside code blocks, which Crepe
// draws with CodeMirror, like the rest of the document. These tests use the
// real editor.

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";
import type { FindOptions } from "./findEngine";

// Crepe draws a code block's CodeMirror once the block nears the screen, which
// jsdom cannot tell, so each test says when the blocks are on screen. Other
// components watch elements too, so each element keeps its own observer's callback.
type Entries = Array<{ target: Element; isIntersecting: boolean }>;
const watched = new Map<Element, (entries: Entries) => void>();
vi.stubGlobal(
  "IntersectionObserver",
  class {
    constructor(private readonly callback: (entries: Entries) => void) {}
    observe(element: Element): void {
      watched.set(element, this.callback);
    }
    unobserve(element: Element): void {
      watched.delete(element);
    }
    disconnect(): void {}
  },
);

const opts: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  watched.clear();
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

/** Draw every code block's CodeMirror, as scrolling to the blocks would. */
async function showCodeBlocks(): Promise<void> {
  for (const [target, callback] of watched) {
    if (target.classList.contains("milkdown-code-block")) callback([{ target, isIntersecting: true }]);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The highlighted text inside code blocks matching `selector`. */
const inCodeBlocks = (selector: string) =>
  [...document.querySelectorAll(`.milkdown-code-block .cm-content ${selector}`)].map((mark) => mark.textContent);

describe("find highlights in code blocks", () => {
  it("highlights matches inside a code block, including the current one", { timeout: 60_000 }, async () => {
    const editor = await open("Intro zeta.\n\n```js\nconst zeta = 1;\n```\n");
    await showCodeBlocks();

    expect(editor.search("zeta", opts)).toEqual({ current: 1, total: 2 });
    expect(inCodeBlocks(".md-find-match")).toEqual(["zeta"]);
    expect(inCodeBlocks(".md-find-current")).toEqual([]);

    expect(editor.findNext()).toEqual({ current: 2, total: 2 });
    expect(inCodeBlocks(".md-find-current")).toEqual(["zeta"]);

    editor.clearSearch();
    expect(inCodeBlocks(".md-find-match")).toEqual([]);
  });

  it("highlights a code block whose CodeMirror is drawn after the search", { timeout: 60_000 }, async () => {
    const editor = await open("Intro.\n\n```js\nconst zeta = 1;\n```\n");
    expect(editor.search("zeta", opts)).toEqual({ current: 1, total: 1 });
    expect(document.querySelector(".milkdown-code-block .cm-content")).toBeNull();

    await showCodeBlocks();
    expect(inCodeBlocks(".md-find-current")).toEqual(["zeta"]);
  });

  it("moves the highlights with a replacement in the code block", { timeout: 60_000 }, async () => {
    const editor = await open("Intro.\n\n```js\nconst zeta = zeta + 1;\n```\n");
    await showCodeBlocks();

    expect(editor.search("zeta", opts)).toEqual({ current: 1, total: 2 });
    expect(editor.replaceCurrent("x", "zeta", opts)).toEqual({ current: 1, total: 1 });
    expect(document.querySelector(".milkdown-code-block .cm-content")?.textContent).toBe("const x = zeta + 1;");
    expect(inCodeBlocks(".md-find-current")).toEqual(["zeta"]);
    expect(inCodeBlocks(".md-find-match")).toEqual(["zeta"]);
  });
});
