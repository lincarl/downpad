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
  vi.useRealTimers();
  document.body.replaceChildren();
});

/** Start mounting the document editor on `markdown`, recording its change reports. */
function start(markdown: string): { editor: WysiwygEditor; onChange: ReturnType<typeof vi.fn>; root: HTMLElement; mounting: Promise<void> } {
  const root = document.createElement("div");
  document.body.append(root);
  const onChange = vi.fn();
  editor = new WysiwygEditor();
  const mounting = editor.mount(root, markdown, { onChange }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  return { editor, onChange, root, mounting };
}

/** Mount the document editor on `markdown`, recording its change reports. */
async function open(markdown: string): Promise<{ editor: WysiwygEditor; onChange: ReturnType<typeof vi.fn> }> {
  const { editor, onChange, mounting } = start(markdown);
  await mounting;
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
// "# Title\n\nLine\\\nnext\n\nSee [docs](https://x.y).\n". An edit rewrites
// only the block it changes (WysiwygEditor.blocks.test.ts).
const SOURCE = "Title\n=====\n\nLine  \nnext\n\nSee [docs][d].\n\n[d]: https://x.y\n";

describe("the document view's Markdown", () => {
  it("reports a live edit but cancels a pending report when destroyed", async () => {
    const { editor, onChange } = await open("Start.\n");
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onChange.mockClear();

    // Establish that a live edit reaches the report callback before checking
    // that destruction cancels the next edit's report.
    replace(editor, "Start", "Updated");
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(onChange).toHaveBeenLastCalledWith("Updated.\n");
    onChange.mockClear();

    replace(editor, "Updated", "Pending");
    expect(editor.getMarkdown()).toBe("Pending.\n");
    expect(onChange).not.toHaveBeenCalled();
    await editor.destroy();
    await vi.advanceTimersByTimeAsync(300);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is the exact text of a file Milkdown would rewrite", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open(SOURCE);
    expect(editor.getMarkdown()).toBe(SOURCE);
    await settle();
    // Two edits that cancel out change the document but not its Markdown.
    replace(editor, "docs", "Docs");
    replace(editor, "Docs", "docs");
    await settle();
    expect(onChange).toHaveBeenCalled();
    expect(lastReport(onChange)).toBe(SOURCE);
    expect(editor.getMarkdown()).toBe(SOURCE);
    expect(differing(onChange, SOURCE)).toEqual([]);
  });

  it("is Milkdown's form for an edited block, and the exact text again after undo", { timeout: 60_000 }, async () => {
    const { editor, onChange } = await open(SOURCE);
    replace(editor, "docs", "Docs");
    await settle();
    // The definition goes with the last link that used it.
    expect(lastReport(onChange)).toBe("Title\n=====\n\nLine  \nnext\n\nSee [Docs](https://x.y).\n");
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
    expect(lastReport(onChange)).toBe("Title\n=====\n\nFirst line\\\nnext\n\nSee [docs][d].\n\n[d]: https://x.y\n");
  });

  it("keeps a table in one piece when the split mirror adds a short row to it", { timeout: 60_000 }, async () => {
    const { editor } = await open("Intro.\n\n| x | y |\n| - | - |\n| 1 | 2 |\n");
    // A row with fewer cells than the header. Replacing only the text that
    // changed would cut the table in two there.
    editor.setMarkdown("Intro.\n\n| x | y |\n| - | - |\n| 3 |\n| 1 | 2 |\n");
    expect(editor.getMarkdown()).toBe("Intro.\n\n| x | y |\n| - | - |\n| 3 |\n| 1 | 2 |\n");
    // The document's own form of it, as an edit in the table writes it. The
    // short row is a row of the same table.
    replace(editor, "3", "4");
    expect(editor.getMarkdown()).toBe("Intro.\n\n| x | y |\n| - | - |\n| 4 |   |\n| 1 | 2 |\n");
  });

  it("is the exact text the split mirror set while the editor was opening", { timeout: 60_000 }, async () => {
    const { editor, root, mounting } = start("Start.\n");
    let mounted = false;
    void mounting.then(() => (mounted = true));
    // Mirror into the editor once its document exists, before mount returns.
    for (let step = 0; step < 1_000 && !root.querySelector(".ProseMirror"); step++) await Promise.resolve();
    expect(root.querySelector(".ProseMirror")).not.toBeNull();
    expect(mounted).toBe(false);
    editor.setMarkdown(SOURCE);
    await mounting;
    expect(root.querySelector(".ProseMirror h1")?.textContent).toBe("Title");
    expect(editor.getMarkdown()).toBe(SOURCE);
  });
});
