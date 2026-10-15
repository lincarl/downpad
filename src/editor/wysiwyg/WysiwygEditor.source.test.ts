// @vitest-environment jsdom
// The document view reports a file's exact text until the user changes it,
// instead of Milkdown's rewrite of it. These tests use the real editor.

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";

// Crepe's code block view watches whether it is on screen, which jsdom cannot tell.
vi.stubGlobal("IntersectionObserver", class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});

let editor: WysiwygEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

/** Mount the document editor on `markdown`, recording its change reports. */
async function open(markdown: string): Promise<{ editor: WysiwygEditor; onChange: ReturnType<typeof vi.fn> }> {
  const root = document.createElement("div");
  document.body.append(root);
  const onChange = vi.fn();
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  return { editor, onChange };
}

/** Wait past a list's first frame and the 200ms change report. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** The last Markdown the editor reported. */
const lastReport = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.lastCall?.[0] as string | undefined;

/** The reported Markdown that differs from `markdown`. */
const differing = (onChange: ReturnType<typeof vi.fn>, markdown: string) =>
  onChange.mock.calls.map(([reported]) => reported as string).filter((reported) => reported !== markdown);

/** Replace every `query` in the document, as the find card does. */
function replace(target: WysiwygEditor, query: string, replacement: string): void {
  const options = { caseSensitive: true, wholeWord: false, regex: false };
  target.search(query, options);
  target.replaceAll(replacement, query, options);
}

/** Press Ctrl+Z in the document, as the user does. */
function pressUndo(): void {
  const view = document.querySelector(".ProseMirror");
  view?.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
}

// A setext heading, a hard break and a reference link. Milkdown writes this as
// "# Title\n\nLine\\\nnext\n\nSee [docs](https://x.y).\n".
const SOURCE = "Title\n=====\n\nLine  \nnext\n\nSee [docs][d].\n\n[d]: https://x.y\n";

describe("the document view's Markdown", () => {
  it("is the exact text of a file Milkdown would rewrite", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open(SOURCE);
    expect(editor.getMarkdown()).toBe(SOURCE);
    await settle();
    editor.clearSearch();
    await settle();
    expect(editor.getMarkdown()).toBe(SOURCE);
    expect(differing(onChange, SOURCE)).toEqual([]);
  });

  it("is Milkdown's form after an edit, and the exact text again after undo", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open(SOURCE);
    replace(editor, "docs", "Docs");
    await settle();
    expect(lastReport(onChange)).toBe("# Title\n\nLine\\\nnext\n\nSee [Docs](https://x.y).\n");
    pressUndo();
    await settle();
    expect(lastReport(onChange)).toBe(SOURCE);
    expect(editor.getMarkdown()).toBe(SOURCE);
  });

  it("keeps the frontmatter and the exact body after it", { timeout: 60_000 }, async () => {
    const markdown = "---\ntitle: x\n---\n\n" + SOURCE;
    const { editor, onChange } = await open(markdown);
    await settle();
    expect(editor.getMarkdown()).toBe(markdown);
    expect(differing(onChange, markdown)).toEqual([]);
  });

  it("is the exact text the split mirror set, until an edit", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open("Start.\n");
    editor.setMarkdown(SOURCE);
    expect(editor.getMarkdown()).toBe(SOURCE);
    await settle();
    expect(differing(onChange, SOURCE)).toEqual([]);
    replace(editor, "Line", "First line");
    await settle();
    expect(lastReport(onChange)).toBe("# Title\n\nFirst line\\\nnext\n\nSee [docs](https://x.y).\n");
  });
});
