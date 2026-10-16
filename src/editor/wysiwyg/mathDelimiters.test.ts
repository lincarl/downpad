// @vitest-environment jsdom
// Dollar signs and tildes become math and strikethrough only where Pandoc,
// Obsidian and VS Code read them that way. These tests use the real editor.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { createCodeBlockCommand } from "@milkdown/kit/preset/commonmark";
import { undo } from "@milkdown/kit/prose/history";
import { undoInputRule } from "@milkdown/kit/prose/inputrules";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { callCommand } from "@milkdown/kit/utils";
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
// prosemirror-view's pasteText makes a ClipboardEvent, which jsdom lacks.
vi.stubGlobal("ClipboardEvent", class extends Event {});

/** Editors to destroy after each test. */
let opened: { destroy(): Promise<unknown> }[] = [];
afterEach(async () => {
  for (const editor of opened) await editor.destroy();
  opened = [];
  document.body.replaceChildren();
});

/** Mount the document editor on `markdown`, reporting its edits to `onChange`. */
async function open(markdown: string, onChange = vi.fn()): Promise<{ editor: WysiwygEditor; root: HTMLElement }> {
  const root = document.createElement("div");
  document.body.append(root);
  const editor = new WysiwygEditor();
  opened.push(editor);
  await editor.mount(root, markdown, { onChange }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
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

/** Start composing `text` the way an input method or dead key does. The
 *  browser reports the text through the typing hook while `view.composing` is
 *  set, and marks the change as part of a composition. */
function startComposition(view: EditorView, text: string): void {
  Object.defineProperty(view, "composing", { value: true, configurable: true });
  const { from, to } = view.state.selection;
  const insert = () => view.state.tr.insertText(text, from, to).setMeta("composition", 1);
  if (!view.someProp("handleTextInput", (handle) => handle(view, from, to, text, insert))) view.dispatch(insert());
}

/** End the composition, and wait for the timeouts that Milkdown and md-easy
 *  set when it ends. */
async function endComposition(view: EditorView): Promise<void> {
  Reflect.deleteProperty(view, "composing");
  view.dom.dispatchEvent(new Event("compositionend"));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Commit `text` through a composition. */
async function compose(view: EditorView, text: string): Promise<void> {
  startComposition(view, text);
  await endComposition(view);
}

/** Press `key`, running the editor's key handlers the way a keydown does. */
function press(view: EditorView, key: string): void {
  view.someProp("handleKeyDown", (handle) => handle(view, new KeyboardEvent("keydown", { key })));
}

/** Put the cursor at `position`. */
function moveTo(view: EditorView, position: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position)));
}

/** Put the cursor at the end of the first textblock whose text starts with
 *  `start`. */
function moveToEnd(view: EditorView, start: string): void {
  let end = -1;
  view.state.doc.descendants((node, pos) => {
    if (end < 0 && node.isTextblock && node.textContent.startsWith(start)) end = pos + node.nodeSize - 1;
  });
  moveTo(view, end);
}

/** The document editor's view, for typing, which its public API cannot do. */
const viewOf = (editor: WysiwygEditor) => (editor as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);

/** The struck text on screen. */
const strikes = (root: HTMLElement) => [...root.querySelectorAll("del")].map((del) => del.textContent);

/** The position of the first inline formula. */
function formulaAt(view: EditorView): number {
  let position = -1;
  view.state.doc.descendants((node, pos) => {
    if (position < 0 && node.type.name === "math_inline") position = pos;
  });
  return position;
}

/** The tag of each block on screen. */
const blocks = (root: HTMLElement) =>
  [...root.querySelectorAll(".ProseMirror > :not(.ProseMirror-widget)")].map((block) => block.tagName);

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

  it("reads single-dollar math by Pandoc's rules and saves it so it opens the same way", { timeout: 60_000 }, async () => {
    const markdown = "Two $a$$b$ formulas, an escaped $\\$5$ and $x$.\n";
    const { crepe, root } = await openCrepe(markdown);
    // The first `$` that no backslash escapes ends a formula, even before another `$`.
    expect(formulas(root)).toEqual(["a", "b", "\\$5", "x"]);
    const saved = "Two $a$$b$ formulas, an escaped $$\\$5$$ and $x$.\n";
    expect(crepe.getMarkdown()).toBe(saved);
    expect(formulas((await openCrepe(saved)).root)).toEqual(["a", "b", "\\$5", "x"]);
  });

  it.each([
    // remark-math's own `$$` for a formula that holds a `$`.
    ["Price $$\\$5$$\n\nNext.\n", "$$$\\$5$$$\n\nNext.\n", "\\$5"],
    // `$$` because the formula ends in a backslash, which would escape a single `$`.
    ["Price $$a\\$$\n\nNext.\n", "$$$a\\$$$\n\nNext.\n", "a\\"],
  ])("keeps the formula in %j inline once it is alone in its paragraph", { timeout: 60_000 }, async (markdown, saved, math) => {
    const { crepe, view } = await openCrepe(markdown);
    // Delete "Price ", as a reader editing the line would.
    view.dispatch(view.state.tr.delete(1, formulaAt(view)));
    // A paragraph that is only `$$...$$` reads as a math block.
    expect(crepe.getMarkdown()).toBe(saved);
    const reopened = await openCrepe(saved);
    expect(formulas(reopened.root)).toEqual([math]);
    expect(blocks(reopened.root)).toEqual(["P", "P"]);
  });

  it.each([
    // A digit right after single-dollar math makes it text, so the formula is
    // saved with `$$`.
    ["Math $x$ items.", "Math $$x$$2 items.", "x"],
    // A formula that spans lines and then starts a line, at the start of the
    // paragraph or after a soft line break. A line that is `$$` and text with
    // no other `$` opens a math block, so its line endings are saved as spaces.
    ["$a +\nb$ items.", "$$a + b$$2 items.", "a + b"],
    ["The value\n$a +\nb$ items.", "The value\n$$a + b$$2 items.", "a + b"],
  ])("saves %j with a digit typed after the formula so it opens the same way", { timeout: 60_000 }, async (paragraph, saved, math) => {
    const rest = "\n\n## Later heading\n\nAfter.\n";
    const { crepe, view } = await openCrepe(paragraph + rest);
    moveTo(view, formulaAt(view) + 1);
    type(view, "2");
    expect(crepe.getMarkdown()).toBe(saved + rest);
    const reopened = await openCrepe(saved + rest);
    expect(formulas(reopened.root)).toEqual([math]);
    expect(blocks(reopened.root)).toEqual(["P", "H2", "P"]);
    expect(reopened.root.querySelector(".ProseMirror > p:last-child")?.textContent).toBe("After.");
  });

  it.each([
    // TeX ignores the spaces around a formula, and single dollars with a space
    // just inside read as text.
    [" x ", "Math $x$ here.\n", ["x"]],
    // `\ ` is a space in TeX, which may come before the closing `$`.
    ["a\\ ", "Math $a\\ $ here.\n", ["a\\ "]],
    // `\$` does not close single-dollar math.
    ["a\\", "Math $$a\\$$ here.\n", ["a\\"]],
    // A single `$` inside would end single-dollar math.
    ["a$$b", "Math $$$a$$b$$$ here.\n", ["a$$b"]],
    // An empty formula shows nothing, and `$$` would read as text.
    ["", "Math  here.\n", []],
  ])("saves the formula %j so it opens the same way", { timeout: 60_000 }, async (value, markdown, math) => {
    const { crepe, view } = await openCrepe("Math $q$ here.\n");
    view.dispatch(view.state.tr.setNodeMarkup(formulaAt(view), undefined, { value }));
    expect(crepe.getMarkdown()).toBe(markdown);
    expect(formulas((await openCrepe(markdown)).root)).toEqual(math);
  });

  it.each([
    // GFM ends a table cell at a `|` that no backslash escapes.
    ["|x| + |y|", "$\\|x\\| + \\|y\\|$", "|x| + |y|"],
    // No backslash may come before that `|`, so TeX's `\|` is saved as
    // `\Vert`, which TeX reads the same.
    ["\\|x\\|_2 + \\|\\|", "$\\Vert x\\Vert_2 + \\Vert\\Vert$", "\\Vert x\\Vert_2 + \\Vert\\Vert"],
    // KaTeX reads `@` as a letter in a command's name, as in `\Vert@`.
    ["\\|@x", "$\\Vert @x$", "\\Vert @x"],
    // An escaped backslash escapes nothing.
    ["a \\\\| b", "$a \\\\\\| b$", "a \\\\| b"],
    // A cell is one line.
    ["a\n|b|", "$a \\|b\\|$", "a |b|"],
  ])("saves the formula %j in a table cell so the table opens with the same cells", { timeout: 60_000 }, async (value, written, math) => {
    const { crepe, view } = await openCrepe("| a | b |\n| --- | --- |\n| c $q$ ok | d |\n");
    view.dispatch(view.state.tr.setNodeMarkup(formulaAt(view), undefined, { value }));
    const saved = crepe.getMarkdown();
    expect(saved).toContain(`| c ${written} ok |`);
    const { root } = await openCrepe(saved);
    expect(root.querySelectorAll("th, td")).toHaveLength(4);
    expect(formulas(root)).toEqual([math]);
  });

  it("reads `\\|` in a formula in a table cell as `|`, as GitHub does", { timeout: 60_000 }, async () => {
    const { root } = await openCrepe("| a | b |\n| --- | --- |\n| c $\\|x\\|$ and $$\\|y\\|$$2 | $a\\\\b$ |\n\nOutside $\\|z\\|$.\n");
    expect(root.querySelectorAll("th, td")).toHaveLength(4);
    expect(formulas(root)).toEqual(["|x|", "|y|", "a\\\\b", "\\|z\\|"]);
  });

  it("keeps the backslash of an escaped dollar before a character Markdown escapes", { timeout: 60_000 }, async () => {
    const markdown = "Read \\$_GET['a'].\\$_POST['b'], \\$[a]\\$[b] and \\$~5,\\$~6.\n";
    const { editor, root } = await open(`Edit.\n\n${markdown}`);
    expect(formulas(root)).toEqual([]);
    edit(editor);
    const saved = editor.getMarkdown();
    // remark-math's escape for a text `$` was dropped before `_`, `[` and `~`,
    // and two such dollars then read as a formula.
    expect(saved.match(/\\?\$/g)).toEqual(Array(6).fill("\\$"));
    expect(formulas((await open(saved)).root)).toEqual([]);
  });

  it.each([
    "$a$$\\$5$ q",
    "$\\$5$$a$ q",
    "$x\\$$$x_1$ q",
    "$x\\$$$\\{x\\}$ q",
  ])("saves the side-by-side formulas in %j with single dollars", { timeout: 60_000 }, async (paragraph) => {
    const { editor, root } = await open(`Edit.\n\n${paragraph}\n`);
    const math = formulas(root);
    expect(math).toHaveLength(2);
    edit(editor);
    // Right after a formula, a run of dollars reads as text.
    expect(editor.getMarkdown()).toBe(`Edited.\n\n${paragraph}\n`);
    expect(formulas((await open(editor.getMarkdown())).root)).toEqual(math);
  });

  it("keeps a whole Windows line ending after a backslash at the end of a formula", { timeout: 60_000 }, async () => {
    const { editor, root } = await open("Edit.\n\n$a\\\r\n$ b\n");
    expect(formulas(root)).toEqual(["a\\\r\n"]);
    edit(editor);
    expect(editor.getMarkdown()).toBe("Edited.\n\n$a\\\r\n$ b\n");
    expect(formulas((await open(editor.getMarkdown())).root)).toEqual(["a\\\r\n"]);
  });

  it.each([
    // A closing mark after a space.
    ["Tickets cost $5 for kids and $10.", "Tickets cost \\$5 for kids and \\$10.\n"],
    ["Expect ~5 to ~10 minutes.", "Expect \\~5 to \\~10 minutes.\n"],
    // An opening mark with a space after it.
    ["Costs $ 5 or x$.", "Costs \\$ 5 or x\\$.\n"],
    // A digit right after a closing `$` makes it text, and so does a letter
    // after a `~` that follows punctuation. Both are only known once the next
    // character is typed.
    ["Pay $5-$10, $5/$10, $5–$10 or $5,$10 today.", "Pay \\$5-\\$10, \\$5/\\$10, \\$5–\\$10 or \\$5,\\$10 today.\n"],
    ["Value $x$1 more.", "Value \\$x\\$1 more.\n"],
    ["Expect ~5-~10 or ~~5-~~10 min.", "Expect \\~5-\\~10 or \\~\\~5-\\~\\~10 min.\n"],
    // A third `~` makes the run too long to close.
    ["Expect ~5-~~ min.", "Expect \\~5-\\~\\~ min.\n"],
    // A backslash before a mark makes it text in a file.
    ["Pay \\$x$ or \\~y~ now.", "Pay \\\\\\$x\\$ or \\\\\\~y\\~ now.\n"],
  ])("types %j as text", { timeout: 60_000 }, async (typed, markdown) => {
    const { crepe, root, view } = await openCrepe();
    type(view, typed);
    expect(formulas(root)).toEqual([]);
    expect(root.querySelector("del")).toBeNull();
    expect(crepe.getMarkdown()).toBe(markdown);
    // The same text opens as text.
    const reopened = await openCrepe(typed);
    expect(formulas(reopened.root)).toEqual([]);
    expect(reopened.root.querySelector("del")).toBeNull();
  });

  it.each([
    ["Let $a$, $b$ and $c$.", ["a", "b", "c"], "Let $a$, $b$ and $c$.\n"],
    // The first `$` that no backslash escapes ends a formula.
    ["Try $a$$b$ now.", ["a", "b"], "Try $a$$b$ now.\n"],
    // An escaped `$` is no part of a run of dollars.
    ["Pay \\$$x$ now.", ["x"], "Pay \\\\\\$$x$ now.\n"],
  ])("saves typed %j so it opens with the same formulas", { timeout: 60_000 }, async (typed, math, markdown) => {
    const { crepe, root, view } = await openCrepe();
    type(view, typed);
    expect(formulas(root)).toEqual(math);
    expect(crepe.getMarkdown()).toBe(markdown);
    const reopened = await openCrepe(markdown);
    expect(formulas(reopened.root)).toEqual(math);
    expect(reopened.crepe.getMarkdown()).toBe(markdown);
  });

  it("never pairs a typed closing `$` across a formula or with part of `$$`", { timeout: 60_000 }, async () => {
    const { crepe, root, view } = await openCrepe();
    // Crepe's shortcut replaced the formula between the marks with U+FFFC.
    type(view, "Cost $5 and $x$ items, about 7$. Inline $$E=mc^2$$ here.");
    expect(formulas(root)).toEqual(["x"]);
    const saved = crepe.getMarkdown();
    // Whether Milkdown escapes text that ends in a space depends on its text
    // writer. Both forms open the same way.
    expect(saved).toMatch(/^Cost \\?\$5 and \$x\$ items, about 7\\\$\. Inline \\\$\\\$E=mc\^2\\\$\\\$ here\.\n$/);
    expect(formulas((await openCrepe(saved)).root)).toEqual(["x"]);
  });

  it.each([
    // Milkdown's shortcut would strike from the first `~`, not from `~~`.
    // Whether Milkdown escapes text that ends in a space depends on its text
    // writer. Both forms open the same way.
    ["About ~5, not ~~old~~.", ["old"], /^About \\?~5, not ~~old~~\.\n$/],
    // A run right after a letter can close.
    ["Cross ~old~ab out.", ["old"], /^Cross ~~old~~ab out\.\n$/],
    // A tilde inside struck text pairs with nothing after it.
    ["It ~~takes ~5 min~~ now 10~ish.", ["takes ~5 min"], /^It ~~takes \\?~5 min~~ now 10\\~ish\.\n$/],
    // md-easy's Markdown reader reads 😀 by its first UTF-16 unit, which is
    // no punctuation, so the run between `)` and 😀 closes nothing.
    ["Cross ~(a)~😀 out.", [], /^Cross \\~\(a\)\\~😀 out\.\n$/],
    // The text typed after the closing run is outside the italic text too.
    ["Cross ~*old*~ out.", ["old"], /^Cross \*~~old~~\* out\.\n$/],
  ])("strikes typed %j as GFM reads it", { timeout: 60_000 }, async (typed, struck, markdown) => {
    const { crepe, root, view } = await openCrepe();
    type(view, typed);
    expect(strikes(root)).toEqual(struck);
    const saved = crepe.getMarkdown();
    expect(saved).toMatch(markdown);
    // The saved file, and a file with the same text, open the same way.
    expect(strikes((await openCrepe(saved)).root)).toEqual(struck);
    expect(strikes((await openCrepe(typed)).root)).toEqual(struck);
  });

  it.each([
    ["Sizes 10~20 and 30~40 cm.", "Sizes 10\\~20 and 30\\~40 cm.\n"],
    ["Open 9~5, lunch 12~1 daily.", "Open 9\\~5, lunch 12\\~1 daily.\n"],
    ["Plan 3~5일, 7~9일.", "Plan 3\\~5일, 7\\~9일.\n"],
    ["Cross a~b~c and x~~y~~z out.", "Cross a\\~b\\~c and x\\~\\~y\\~\\~z out.\n"],
    // Letters outside the Basic Multilingual Plane take two UTF-16 units.
    ["Cross 𠀀~a~ and 𝑥~b~ out.", "Cross 𠀀\\~a\\~ and 𝑥\\~b\\~ out.\n"],
  ])("opens no strikethrough with a typed tilde right after a letter or digit in %j", { timeout: 60_000 }, async (typed, markdown) => {
    const { crepe, root, view } = await openCrepe();
    type(view, typed);
    // As in Milkdown's shortcut. GFM strikes some of these in a file, such as
    // "20 and 30" in the first.
    expect(strikes(root)).toEqual([]);
    expect(crepe.getMarkdown()).toBe(markdown);
    expect(strikes((await openCrepe(markdown)).root)).toEqual([]);
  });

  it.each([
    ["Expect ~5 to ", "~", "", "Expect \\~5 to \\~\n"],
    ["Pay $5 for ", "$", "", "Pay \\$5 for \\$\n"],
    // A composed closing mark waits for the next character like a typed one.
    ["Pay $5-", "$", "10", "Pay \\$5-\\$10\n"],
    ["Expect ~5-", "~", "10", "Expect \\~5-\\~10\n"],
  ])("keeps %j followed by a composed %j and %j as text", { timeout: 60_000 }, async (typed, composed, after, markdown) => {
    const { crepe, root, view } = await openCrepe();
    type(view, typed);
    await compose(view, composed);
    type(view, after);
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
    type(view, ".");
    expect(formulas(root)).toEqual(["E=mc^2", "x"]);
    expect([...root.querySelectorAll("del")].map((del) => del.textContent)).toEqual(["old", "new", "gone"]);
  });

  it("decides a mark that waits before a composed character once the composition ends", { timeout: 60_000 }, async () => {
    const { crepe, root, view } = await openCrepe();
    type(view, "Then $x$");
    await compose(view, "か");
    expect(formulas(root)).toEqual(["x"]);
    type(view, " and ~~old~~");
    startComposition(view, "な");
    // Changing the text around a composition restarts it in the browser, which
    // typed its first character twice.
    expect(view.state.doc.textContent).toMatch(/~~old~~な$/);
    await endComposition(view);
    expect(strikes(root)).toEqual(["old"]);
    expect(crepe.getMarkdown()).toBe("Then $x$か and ~~old~~な\n");
  });

  it("decides a closing mark on Enter or once the cursor leaves it", { timeout: 60_000 }, async () => {
    const { crepe, root, view } = await openCrepe("Start 1\n");
    // Before an existing digit, the cursor leaving keeps it text.
    moveTo(view, 7);
    type(view, "$x$");
    moveTo(view, 1);
    expect(formulas(root)).toEqual([]);
    // Enter ends the line, so the mark closes.
    moveTo(view, view.state.doc.content.size - 1);
    type(view, " $y$");
    expect(formulas(root)).toEqual([]);
    press(view, "Enter");
    expect(formulas(root)).toEqual(["y"]);
    // So does the cursor leaving it at the end of a paragraph.
    type(view, "Then $z$");
    moveTo(view, 1);
    expect(formulas(root)).toEqual(["y", "z"]);
    // Backspace where the cursor went does not undo that.
    expect(undoInputRule(view.state)).toBe(false);
    const saved = crepe.getMarkdown();
    // Whether Milkdown escapes text that ends in a space depends on its text
    // writer. Both forms open the same way.
    expect(saved).toMatch(/^Start \\?\$x\\?\$1 \$y\$\n\nThen \$z\$\n$/);
    const reopened = await openCrepe(saved);
    expect(formulas(reopened.root)).toEqual(["y", "z"]);
    expect(reopened.root.querySelector(".ProseMirror > p")?.textContent).toMatch(/^Start \$x\$1 /);
  });

  it("decides typed marks in a heading, after Tab in a list and after a paste", { timeout: 60_000 }, async () => {
    const { crepe, root, view } = await openCrepe("# Head\n\n- item\n- next\n\nOne.\n");
    // Milkdown gives a heading a new id after each key, which is no edit.
    moveToEnd(view, "Head");
    type(view, " $x$ and ~~old~~ end");
    expect(formulas(root)).toEqual(["x"]);
    expect(strikes(root)).toEqual(["old"]);
    moveToEnd(view, "next");
    type(view, " $y$");
    press(view, "Tab");
    type(view, " more");
    moveToEnd(view, "One.");
    type(view, " Let $z$");
    view.pasteText(" is small");
    expect(formulas(root)).toEqual(["x", "y", "z"]);
    const saved = crepe.getMarkdown();
    expect(saved).toMatch(/^# Head \$x\$ and ~~old~~ end\n\n[*-] item\n  [*-] next \$y\$ more\n\nOne\. Let \$z\$ is small\n$/);
    const reopened = await openCrepe(saved);
    expect(formulas(reopened.root)).toEqual(["x", "y", "z"]);
    expect(strikes(reopened.root)).toEqual(["old"]);
  });

  it.each([
    ["strong", "Let $x$**bold** now.\n"],
    ["emphasis", "Let $x$*bold* now.\n"],
  ])("gives the text typed right after a typed formula the %s set for it", { timeout: 60_000 }, async (mark, markdown) => {
    const { crepe, root, view } = await openCrepe();
    type(view, "Let $x$");
    // Ctrl+B or Ctrl+I with no selection sets the mark for the next character.
    const { schema } = view.state;
    view.dispatch(view.state.tr.addStoredMark(schema.marks[mark].create()));
    type(view, "bold");
    view.dispatch(view.state.tr.removeStoredMark(schema.marks[mark]));
    type(view, " now.");
    expect(formulas(root)).toEqual(["x"]);
    expect(crepe.getMarkdown()).toBe(markdown);
  });

  it("decides a typed closing mark when the editor loses focus", { timeout: 60_000 }, async () => {
    const { crepe, root, view } = await openCrepe("One.\n");
    moveToEnd(view, "One.");
    type(view, " $x$ and ~~old~~");
    view.dom.dispatchEvent(new FocusEvent("blur"));
    expect(strikes(root)).toEqual(["old"]);
    type(view, " $y$");
    view.dom.dispatchEvent(new FocusEvent("blur"));
    expect(formulas(root)).toEqual(["x", "y"]);
    expect(crepe.getMarkdown()).toBe("One. $x$ and ~~old~~ $y$\n");
  });

  it("types the text after a mark decided by leaving the editor outside the strikethrough and with the marks set for it", { timeout: 60_000 }, async () => {
    const { crepe, root, view } = await openCrepe("# Head\n\nOne.\n");
    // Save, Find, a view or tab switch and the split's Markdown pane decide
    // the mark the same way.
    const leave = () => view.dom.dispatchEvent(new FocusEvent("blur"));
    moveToEnd(view, "One.");
    type(view, " Not ~~old~~");
    leave();
    type(view, " but new, see ~a~");
    leave();
    type(view, ", b and $x$");
    // Ctrl+B with no selection sets bold for the next character.
    view.dispatch(view.state.tr.addStoredMark(view.state.schema.marks.strong.create()));
    leave();
    type(view, "bold");
    // The heading's new id is a second change, which cleared those marks.
    moveToEnd(view, "Head");
    type(view, " ~~old~~");
    leave();
    type(view, " new");
    expect(strikes(root)).toEqual(["old", "old", "a"]);
    expect(crepe.getMarkdown()).toBe("# Head ~~old~~ new\n\nOne. Not ~~old~~ but new, see ~~a~~, b and $x$**bold**\n");
  });

  it("types the text after a closing tilde outside the strikethrough after Left and End", { timeout: 60_000 }, async () => {
    const { crepe, root, view } = await openCrepe("One.\n");
    moveToEnd(view, "One.");
    type(view, " see ~a~");
    // The mark waits while the cursor is inside the span, and End decides it.
    const end = view.state.selection.from;
    moveTo(view, end - 1);
    moveTo(view, end);
    type(view, ", b");
    expect(strikes(root)).toEqual(["a"]);
    expect(crepe.getMarkdown()).toBe("One. see ~~a~~, b\n");
  });

  it("keeps bold set inside the text a mark closes when leaving the editor decides the mark", { timeout: 60_000 }, async () => {
    const { crepe, view } = await openCrepe("One.\n\nTwo.\n");
    const leave = () => view.dom.dispatchEvent(new FocusEvent("blur"));
    const bold = () => view.dispatch(view.state.tr.addStoredMark(view.state.schema.marks.strong.create()));
    moveToEnd(view, "One.");
    type(view, " see ~old~");
    // Between "ol" and "d", where the text typed next is struck too.
    moveTo(view, view.state.selection.from - 2);
    bold();
    leave();
    type(view, "X");
    moveToEnd(view, "Two.");
    type(view, " a $xy$");
    // Between x and y, which the formula takes, so the text goes after it.
    moveTo(view, view.state.selection.from - 2);
    bold();
    leave();
    type(view, "X");
    expect(crepe.getMarkdown()).toBe("One. see ~~ol**X**d~~\n\nTwo. a $xy$**X**\n");
  });

  it("reports a waiting closing mark as Save writes it, and decides it before Save", { timeout: 60_000 }, async () => {
    const onChange = vi.fn();
    const { editor, root } = await open("One.\n\nTwo.\n", onChange);
    const view = viewOf(editor);
    moveToEnd(view, "One.");
    type(view, " $x$");
    // The edit is reported once typing pauses, with the mark still waiting.
    // Autosave writes that report, so closing or leaving the tab later finds
    // nothing new to save.
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith("One. $x$\n\nTwo.\n"));
    expect(formulas(root)).toEqual([]);
    // A click in the document pane itself may land inside the formula's text,
    // and autosave must not change the document while the user types.
    editor.reportPendingChange({ keepTypedMark: true });
    expect(formulas(root)).toEqual([]);
    // A digit typed next keeps the mark text.
    type(view, "5");
    editor.reportPendingChange({ keepTypedMark: true });
    expect(onChange).toHaveBeenLastCalledWith("One. \\$x\\$5\n\nTwo.\n");
    moveToEnd(view, "Two.");
    type(view, " was ~old~");
    // Save, a view switch or a click in the split's Markdown pane.
    editor.reportPendingChange();
    expect(formulas(root)).toEqual([]);
    expect(strikes(root)).toEqual(["old"]);
    expect(onChange).toHaveBeenLastCalledWith("One. \\$x\\$5\n\nTwo. was ~~old~~\n");
  });

  it("keeps a formula when the text typed after it is undone", { timeout: 60_000 }, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { crepe, root, view } = await openCrepe("One.\n");
      moveToEnd(view, "One.");
      type(view, " Let $z$");
      // A pause makes the next key start a new undo step.
      vi.setSystemTime(Date.now() + 700);
      type(view, " wrong");
      undo(view.state, view.dispatch);
      expect(formulas(root)).toEqual(["z"]);
      type(view, " right $w$");
      press(view, "Enter");
      undo(view.state, view.dispatch);
      expect(formulas(root)).toEqual(["z", "w"]);
      expect(crepe.getMarkdown()).toBe("One. Let $z$ right $w$\n");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a closing mark waiting while the cursor is inside the text it closes", { timeout: 60_000 }, async () => {
    const { crepe, root, view } = await openCrepe("One.\n");
    moveToEnd(view, "One.");
    type(view, " $xy$");
    let end = view.state.selection.from;
    // Left puts the cursor before the closing `$`, and a click between x and y.
    moveTo(view, end - 1);
    moveTo(view, end - 2);
    // A `~` typed there is part of the formula.
    type(view, "Q~");
    expect(formulas(root)).toEqual([]);
    expect(view.state.doc.textContent).toBe("One. $xQ~y$");
    // Leaving the span decides the mark.
    moveTo(view, end + 2);
    expect(formulas(root)).toEqual(["xQ~y"]);
    type(view, " and ~~old~~");
    end = view.state.selection.from;
    moveTo(view, end - 3);
    type(view, "e");
    expect(strikes(root)).toEqual([]);
    moveTo(view, 1);
    expect(strikes(root)).toEqual(["oled"]);
    expect(crepe.getMarkdown()).toBe("One. $xQ~y$ and ~~oled~~\n");
  });

  it.each([" a $x$", " a ~~x~~"])("keeps %j as code when Ctrl+Alt+C makes its paragraph a code block right after", { timeout: 60_000 }, async (typed) => {
    const { crepe, root, view } = await openCrepe("Start.\n");
    moveToEnd(view, "Start.");
    type(view, typed);
    crepe.editor.action(callCommand(createCodeBlockCommand.key));
    expect(formulas(root)).toEqual([]);
    expect(crepe.getMarkdown()).toBe(`\`\`\`\nStart.${typed}\n\`\`\`\n`);
  });

  it("keeps dollars and tildes typed in inline code as code text", { timeout: 60_000 }, async () => {
    const { crepe, root, view } = await openCrepe("Run `echo something` now.\n");
    // Between "echo so" and "mething" in the code span.
    moveTo(view, 12);
    type(view, " $HOME $x$ q ~a~ b ");
    // A code span typed around a formula or struck text, and a formula typed
    // around a code span. A backtick inside a formula starts no code span.
    moveToEnd(view, "Run");
    type(view, " Use `$y$` and `~~z~~`, not $a`c`b$. Then $a`b$` end.");
    expect(formulas(root)).toEqual(["a`b"]);
    expect(strikes(root)).toEqual([]);
    const saved = crepe.getMarkdown();
    // Whether Milkdown escapes text that ends in a space depends on its text
    // writer. Both forms open the same way.
    expect(saved).toMatch(/^Run `echo so \$HOME \$x\$ q ~a~ b mething` now\. Use `\$y\$` and `~~z~~`, not \\\$a`c`b\\?\$\. Then \$a`b\$\\` end\.\n$/);
    const reopened = await openCrepe(saved);
    expect(formulas(reopened.root)).toEqual(["a`b"]);
    expect([...reopened.root.querySelectorAll("code")].map((code) => code.textContent)).toEqual([
      "echo so $HOME $x$ q ~a~ b mething",
      "$y$",
      "~~z~~",
      "c",
    ]);
  });

  it("keeps a mark waiting while a selection covers it, so typing replaces it", { timeout: 60_000 }, async () => {
    const { crepe, root, view } = await openCrepe("One.\n");
    moveToEnd(view, "One.");
    type(view, " $x$");
    // Shift+Left selects the mark.
    const { from } = view.state.selection;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from - 1)));
    expect(formulas(root)).toEqual([]);
    expect(view.state.selection.empty).toBe(false);
    type(view, "y");
    expect(crepe.getMarkdown()).toBe("One. \\$xy\n");
  });
});
