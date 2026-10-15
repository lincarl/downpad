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

/** Editors to destroy after each test. */
let opened: { destroy(): Promise<unknown> }[] = [];
afterEach(async () => {
  for (const editor of opened) await editor.destroy();
  opened = [];
  document.body.replaceChildren();
});

/** Mount the document editor on `markdown`. */
async function open(markdown: string): Promise<{ editor: WysiwygEditor; root: HTMLElement }> {
  const root = document.createElement("div");
  document.body.append(root);
  const editor = new WysiwygEditor();
  opened.push(editor);
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

/** A Crepe editor on `markdown` with these plugins, the way WysiwygEditor adds them. */
async function openCrepe(markdown = ""): Promise<{ crepe: Crepe; root: HTMLElement; view: EditorView }> {
  const root = document.createElement("div");
  document.body.append(root);
  const crepe = new Crepe({ root, defaultValue: markdown });
  opened.push(crepe);
  crepe.editor.use(mathDelimiters);
  await crepe.create();
  return { crepe, root, view: crepe.editor.ctx.get(editorViewCtx) };
}

/** Type `text` one character at a time, the way the browser reports keys. */
function type(view: EditorView, text: string): void {
  for (const character of text) {
    const { from, to } = view.state.selection;
    const insert = () => view.state.tr.insertText(character, from, to);
    if (!view.someProp("handleTextInput", (handle) => handle(view, from, to, character, insert))) view.dispatch(insert());
  }
}

/** Commit `text` the way an input method or dead key does, which inserts it
 *  without the typing hook, then end the composition. */
async function compose(view: EditorView, text: string): Promise<void> {
  view.dispatch(view.state.tr.insertText(text));
  view.dom.dispatchEvent(new Event("compositionend"));
  // Milkdown runs the typing shortcuts in a timeout after the composition ends.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const PLAIN_SEARCH = { caseSensitive: true, wholeWord: false, regex: false };

/** Change "Edit." to "Edited.", so the editor writes the whole document again
 *  instead of reporting the text it opened. */
function edit(editor: WysiwygEditor): void {
  expect(editor.search("Edit.", PLAIN_SEARCH).total).toBe(1);
  editor.replaceAll("Edited.", "Edit.", PLAIN_SEARCH);
}

describe("math and strikethrough delimiters", () => {
  it("opens dollar amounts as text and formulas as math", { timeout: 60_000 }, async () => {
    const { editor, root } = await open(
      [
        "Edit.",
        "Tickets cost $5 for kids and $10 for adults.",
        "Spaced $ x $ is text.",
        "Pay $5-$10 today.",
        "Odd $$5$ is text.",
        "Type $USD or \\$ for dollars.",
        "> Pay $5 for kids\n> and $10 for adults.",
        "The formula $E = mc^2$ stays math.",
      ].join("\n\n") + "\n",
    );
    expect(formulas(root)).toEqual(["E = mc^2"]);
    expect([...root.querySelectorAll(".ProseMirror > p")].map((p) => p.textContent).slice(1, 6)).toEqual([
      "Tickets cost $5 for kids and $10 for adults.",
      "Spaced $ x $ is text.",
      "Pay $5-$10 today.",
      "Odd $$5$ is text.",
      "Type $USD or $ for dollars.",
    ]);
    edit(editor);
    // The dollar signs are escaped once saved, which every reader shows as `$`.
    expect(editor.getMarkdown()).toBe(
      [
        "Edited.",
        "Tickets cost \\$5 for kids and \\$10 for adults.",
        "Spaced \\$ x \\$ is text.",
        "Pay \\$5-\\$10 today.",
        "Odd \\$\\$5\\$ is text.",
        "Type \\$USD or \\$ for dollars.",
        "> Pay \\$5 for kids\n> and \\$10 for adults.",
        "The formula $E = mc^2$ stays math.",
      ].join("\n\n") + "\n",
    );
  });

  it("reads Markdown between two dollar amounts", { timeout: 60_000 }, async () => {
    const { editor, root } = await open(
      "Edit.\n\nPay $5 (**kids**) [here](https://x.y), `now`, &amp;, \\*, <b>bold</b> or $10.\n\nPay $5 and  \n$10 later.\n",
    );
    expect(formulas(root)).toEqual([]);
    const paragraph = root.querySelectorAll(".ProseMirror > p")[1];
    expect(paragraph.querySelector("strong")?.textContent).toBe("kids");
    expect(paragraph.querySelector("a")?.getAttribute("href")).toBe("https://x.y");
    expect(paragraph.querySelector("code")?.textContent).toBe("now");
    expect(paragraph.textContent).toContain(", &, *, ");
    expect(root.querySelectorAll(".ProseMirror > p")[2].querySelector("br")).not.toBeNull();
    edit(editor);
    expect(editor.getMarkdown()).toBe(
      "Edited.\n\nPay \\$5 (**kids**) [here](https://x.y), `now`, &, \\*, <b>bold</b> or \\$10.\n\nPay \\$5 and\\\n\\$10 later.\n",
    );
  });

  it("opens a formula after a dollar amount in the same paragraph", { timeout: 60_000 }, async () => {
    const { editor, root } = await open("Edit.\n\nCosts $5 and $x$ here.\n");
    expect(formulas(root)).toEqual(["x"]);
    expect(root.querySelectorAll(".ProseMirror > p")[1].textContent).toMatch(/^Costs \$5 and /);
    edit(editor);
    const saved = editor.getMarkdown();
    // Whether Milkdown escapes text that ends in a space depends on its text
    // writer. Both forms open the same way.
    expect(saved).toMatch(/^Edited\.\n\nCosts \\?\$5 and \$x\$ here\.\n$/);
    expect(formulas((await open(saved)).root)).toEqual(["x"]);
  });

  it("opens a paragraph that is only $$...$$ as a math block", { timeout: 60_000 }, async () => {
    const { editor } = await open("Edit.\n\n$$E = mc^2$$\n\nInline $$x$$ math.\n\n- $$y$$\n");
    edit(editor);
    // Inside other text, and as a list item's first line, which must stay a
    // paragraph, it stays inline math.
    expect(editor.getMarkdown()).toBe("Edited.\n\n$$\nE = mc^2\n$$\n\nInline $x$ math.\n\n- $y$\n");
  });

  it.each([
    // Single dollars right before a digit read as text.
    ["Value $x$1 more", ["x"], "Value $$x$$1 more\n"],
    ["Let $a$, $b$ and $c$2", ["a", "b", "c"], "Let $a$, $b$ and $$c$$2\n"],
  ])("saves typed %j so it opens with the same formulas", { timeout: 60_000 }, async (typed, math, markdown) => {
    const { crepe, root, view } = await openCrepe();
    type(view, typed);
    expect(formulas(root)).toEqual(math);
    expect(crepe.getMarkdown()).toBe(markdown);
    const reopened = await openCrepe(markdown);
    expect(formulas(reopened.root)).toEqual(math);
    expect(reopened.crepe.getMarkdown()).toBe(markdown);
  });

  it.each([
    // TeX ignores the spaces around a formula, and single dollars with a space
    // just inside read as text.
    [" x ", "Math $x$ here.\n", ["x"]],
    // `\ ` is a space in TeX, which may come before the closing `$`.
    ["a\\ ", "Math $a\\ $ here.\n", ["a\\ "]],
    // `\$` does not close single-dollar math.
    ["a\\", "Math $$a\\$$ here.\n", ["a\\"]],
    // An empty formula shows nothing, and `$$` would read as text.
    ["", "Math  here.\n", []],
  ])("saves the formula %j so it opens the same way", { timeout: 60_000 }, async (value, markdown, math) => {
    const { crepe, view } = await openCrepe("Math $q$ here.\n");
    let position = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "math_inline") position = pos;
    });
    view.dispatch(view.state.tr.setNodeMarkup(position, undefined, { value }));
    expect(crepe.getMarkdown()).toBe(markdown);
    expect(formulas((await openCrepe(markdown)).root)).toEqual(math);
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
    const { crepe, root, view } = await openCrepe();
    type(view, typed);
    expect(formulas(root)).toEqual([]);
    expect(root.querySelector("del")).toBeNull();
    expect(crepe.getMarkdown()).toBe(markdown);
  });

  it.each([
    ["Expect ~5 to ", "~", "Expect \\~5 to \\~\n"],
    ["Pay $5 for ", "$", "Pay \\$5 for \\$\n"],
  ])("keeps a %j followed by a composed %j as text", { timeout: 60_000 }, async (typed, composed, markdown) => {
    const { crepe, root, view } = await openCrepe();
    type(view, typed);
    await compose(view, composed);
    expect(formulas(root)).toEqual([]);
    expect(root.querySelector("del")).toBeNull();
    expect(crepe.getMarkdown()).toBe(markdown);
  });

  it("still types math and strikethrough where the closing mark follows text", { timeout: 60_000 }, async () => {
    const { crepe, root, view } = await openCrepe();
    type(view, "Inline $E=mc^2$, ~~old~~ and ~new~.");
    expect(formulas(root)).toEqual(["E=mc^2"]);
    expect([...root.querySelectorAll("del")].map((del) => del.textContent)).toEqual(["old", "new"]);
    expect(crepe.getMarkdown()).toBe("Inline $E=mc^2$, ~~old~~ and ~~new~~.\n");
    // The same holds when the closing mark is composed.
    type(view, " Then $x");
    await compose(view, "$");
    type(view, " and ~~gone~");
    await compose(view, "~");
    expect(formulas(root)).toEqual(["E=mc^2", "x"]);
    expect([...root.querySelectorAll("del")].map((del) => del.textContent)).toEqual(["old", "new", "gone"]);
  });
});
