// @vitest-environment jsdom
// Dollar signs and tildes become math and strikethrough only where Pandoc,
// Obsidian and VS Code read them that way. These tests use the real editor.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { mathDelimiters } from "./mathDelimiters";
import { WysiwygEditor } from "./WysiwygEditor";

// Crepe's code block view watches whether it is on screen, which jsdom cannot tell.
vi.stubGlobal("IntersectionObserver", class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});

let editor: WysiwygEditor | null = null;
let crepe: Crepe | null = null;
afterEach(async () => {
  await editor?.destroy();
  await crepe?.destroy();
  editor = null;
  crepe = null;
  document.body.replaceChildren();
});

/** Mount the document editor on `markdown`. */
async function open(markdown: string): Promise<{ editor: WysiwygEditor; root: HTMLElement }> {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange: vi.fn() }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  return { editor, root };
}

/** The formula of each inline math node on screen. */
const formulas = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('[data-type="math_inline"]')].map((math) => math.dataset.value);

/** An empty Crepe editor with these plugins, the way WysiwygEditor adds them. */
async function openCrepe(): Promise<{ crepe: Crepe; root: HTMLElement }> {
  const root = document.createElement("div");
  document.body.append(root);
  crepe = new Crepe({ root, defaultValue: "" });
  crepe.editor.use(mathDelimiters);
  await crepe.create();
  return { crepe, root };
}

/** Type `text` one character at a time, the way the browser reports keys. */
function type(view: EditorView, text: string): void {
  for (const character of text) {
    const { from, to } = view.state.selection;
    const insert = () => view.state.tr.insertText(character, from, to);
    if (!view.someProp("handleTextInput", (handle) => handle(view, from, to, character, insert))) view.dispatch(insert());
  }
}

const PLAIN_SEARCH = { caseSensitive: true, wholeWord: false, regex: false };

describe("math and strikethrough delimiters", () => {
  it("opens dollar amounts as text and formulas as math", { timeout: 60_000 }, async () => {
    const { editor, root } = await open(
      [
        "Tickets cost $5 for kids and $10 for adults.",
        "Spaced $ x $ is text.",
        "> Pay $5 for kids\n> and $10 for adults.",
        "The formula $E = mc^2$ stays math.",
      ].join("\n\n") + "\n",
    );
    expect(formulas(root)).toEqual(["E = mc^2"]);
    expect(root.querySelector(".ProseMirror p")?.textContent).toBe("Tickets cost $5 for kids and $10 for adults.");
    // The dollar signs are escaped once saved, which every reader shows as `$`.
    expect(editor.getMarkdown()).toBe(
      [
        "Tickets cost \\$5 for kids and \\$10 for adults.",
        "Spaced \\$ x \\$ is text.",
        "> Pay \\$5 for kids\n> and \\$10 for adults.",
        "The formula $E = mc^2$ stays math.",
      ].join("\n\n") + "\n",
    );
  });

  it("opens a paragraph that is only $$...$$ as a math block", { timeout: 60_000 }, async () => {
    const { editor } = await open("Edit.\n\n$$E = mc^2$$\n\nInline $$x$$ math.\n\n- $$y$$\n");
    expect(editor.search("Edit.", PLAIN_SEARCH).total).toBe(1);
    editor.replaceAll("Edited.", "Edit.", PLAIN_SEARCH);
    // Inside other text, and as a list item's first line, which must stay a
    // paragraph, it stays inline math.
    expect(editor.getMarkdown()).toBe("Edited.\n\n$$\nE = mc^2\n$$\n\nInline $x$ math.\n\n- $y$\n");
  });

  it.each([
    // A closing mark after a space.
    ["Tickets cost $5 for kids and $10.", "Tickets cost \\$5 for kids and \\$10.\n"],
    ["Expect ~5 to ~10 minutes.", "Expect \\~5 to \\~10 minutes.\n"],
    // An opening mark with a space after it.
    ["Costs $ 5 or x$.", "Costs \\$ 5 or x\\$.\n"],
    // Milkdown's shortcut would strike from the first `~`, not from `~~`.
    ["About ~5, not ~~old~~.", "About \\~5, not \\~\\~old\\~\\~.\n"],
  ])("types %j as text", { timeout: 60_000 }, async (typed, markdown) => {
    const { crepe, root } = await openCrepe();
    type(crepe.editor.ctx.get(editorViewCtx), typed);
    expect(formulas(root)).toEqual([]);
    expect(root.querySelector("del")).toBeNull();
    expect(crepe.getMarkdown()).toBe(markdown);
  });

  it("still types math and strikethrough where the closing mark follows text", { timeout: 60_000 }, async () => {
    const { crepe, root } = await openCrepe();
    type(crepe.editor.ctx.get(editorViewCtx), "Inline $E=mc^2$, ~~old~~ and ~new~.");
    expect(formulas(root)).toEqual(["E=mc^2"]);
    expect([...root.querySelectorAll("del")].map((del) => del.textContent)).toEqual(["old", "new"]);
    expect(crepe.getMarkdown()).toBe("Inline $E=mc^2$, ~~old~~ and ~~new~~.\n");
  });
});
