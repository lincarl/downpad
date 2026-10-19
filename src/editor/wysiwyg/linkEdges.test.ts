// @vitest-environment jsdom
// Text put in at either end of a link starts plain text, with the real editor.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { toggleMark } from "@milkdown/kit/prose/commands";
import { undo } from "@milkdown/kit/prose/history";
import { TextSelection } from "@milkdown/kit/prose/state";
import { DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";
import type { FindOptions } from "./findEngine";
import { linkUrlKey } from "./linkView";

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

/** Mount the document editor on `markdown`, with its ProseMirror view. */
async function open(markdown: string): Promise<{ editor: WysiwygEditor; view: EditorView }> {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange: () => {} }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  const view = (editor as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);
  return { editor, view };
}

/** The position right after the first `text` in the document, or before it with `before`. */
function at(view: EditorView, text: string, before = false): number {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return found < 0;
    const index = node.text!.indexOf(text);
    if (index >= 0) found = pos + index + (before ? 0 : text.length);
    return false;
  });
  if (found < 0) throw new Error(`No ${text}`);
  return found;
}

/** Put the caret at `pos`, as a click there does. */
function caret(view: EditorView, pos: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

/** Select `from`..`to`. */
function select(view: EditorView, from: number, to: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

/** Hand ProseMirror text that replaces `from`..`to`, as the browser does for
 *  a key typed over the selection there, or for a change it makes elsewhere,
 *  such as a spelling fix. */
function input(view: EditorView, from: number, to: number, text: string): void {
  const insert = () => view.state.tr.insertText(text, from, to);
  if (!view.someProp("handleTextInput", (handle) => handle(view, from, to, text, insert))) view.dispatch(insert());
}

/** Type `text` over the selection as ProseMirror does for a key. */
function type(view: EditorView, text: string): void {
  input(view, view.state.selection.from, view.state.selection.to, text);
}

/** Set the marks of the text before the caret as stored marks without moving
 *  it, as the virtual cursor's Left does at a link's end where text follows. */
function leftToLinkSide(view: EditorView): void {
  const { $head } = view.state.selection;
  view.dispatch(view.state.tr.setStoredMarks(view.state.doc.resolve($head.pos - 1).marks()));
}

/** The side of the URL suffix drawn at `pos`, as the editor draws it now. */
function suffixSide(view: EditorView, pos: number): number | undefined {
  const plugin = linkUrlKey.get(view.state)!;
  const set = plugin.props.decorations?.call(plugin, view.state);
  const [suffix] = set instanceof DecorationSet ? set.find(pos, pos) : [];
  return (suffix?.spec as { side?: number } | undefined)?.side;
}

const opts: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };

describe("text put in at a link's edge", () => {
  it.each([
    ["the end of a paragraph", "Intro [link](https://e.com/a)\n", "link", false, "Intro [link](https://e.com/a)xy\n"],
    ["the end of a link before text", "A [link](https://e.com/b)s more.\n", "link", false, "A [link](https://e.com/b)xys more.\n"],
    ["the start of a paragraph that starts with a link", "[link](https://e.com/k) here.\n", "link", true, "xy[link](https://e.com/k) here.\n"],
    ["the end of a list item", "- item [link](https://e.com/g)\n- second\n", "link", false, "- item [link](https://e.com/g)xy\n- second\n"],
    ["the end of a heading", "# Title [link](https://e.com/h)\n", "link", false, "# Title [link](https://e.com/h)xy\n"],
    ["the end of a quote", "> Quote [link](https://e.com/q)\n", "link", false, "> Quote [link](https://e.com/q)xy\n"],
    ["the end of a link before a line break", "Line [link](https://e.com/r)\\\nnext\n", "link", false, "Line [link](https://e.com/r)xy\\\nnext\n"],
    ["the place between two links", "Two [one](https://e.com/1)[two](https://e.com/2)\n", "one", false, "Two [one](https://e.com/1)xy[two](https://e.com/2)\n"],
    ["the end of a bare URL", "Visit https://e.com/m\n", "https://e.com/m", false, "Visit <https://e.com/m>xy\n"],
    ["the end of a bold link", "Text **[bold](https://e.com/e)**\n", "bold", false, "Text **[bold](https://e.com/e)xy**\n"],
  ])("is plain at %s", { timeout: 60_000 }, async (_where, markdown, text, before, expected) => {
    const { editor, view } = await open(markdown);
    caret(view, at(view, text, before));
    type(view, "x");
    type(view, "y");
    expect(editor.getMarkdown()).toBe(expected);
  });

  it("joins the link inside it", { timeout: 60_000 }, async () => {
    const { editor, view } = await open("A [link](https://e.com/l) b.\n");
    caret(view, at(view, "li"));
    type(view, "xy");
    expect(editor.getMarkdown()).toBe("A [lixynk](https://e.com/l) b.\n");
  });

  it.each([
    ["the link's last characters", "A [link](https://e.com/b)s more.\n", 2, "ZZ", "A [liZZ](https://e.com/b)s more.\n"],
    ["the whole link text at the end of a paragraph", "Intro [link](https://e.com/a)\n", 4, "new", "Intro [new](https://e.com/a)\n"],
  ])("keeps the link for every key typed over %s", { timeout: 60_000 }, async (_what, markdown, length, text, expected) => {
    const { editor, view } = await open(markdown);
    const end = at(view, "link");
    select(view, end - length, end);
    for (const key of text) type(view, key);
    expect(editor.getMarkdown()).toBe(expected);
  });

  it("is plain after Backspace takes the link's last character", { timeout: 60_000 }, async () => {
    const { editor, view } = await open("Intro [link](https://e.com/a)\n");
    const end = at(view, "link");
    caret(view, end);
    // ProseMirror reads the browser's deletion and keeps the deleted text's marks.
    const { doc } = view.state;
    view.dispatch(view.state.tr.delete(end - 1, end).ensureMarks(doc.resolve(end - 1).marksAcross(doc.resolve(end)) ?? []));
    type(view, "x");
    expect(editor.getMarkdown()).toBe("Intro [lin](https://e.com/a)x\n");
  });

  it("is plain for a paste and for Ctrl+B at the end of a link", { timeout: 60_000 }, async () => {
    const { editor, view } = await open("Intro [link](https://e.com/a)\n\nNext [two](https://e.com/2)\n");
    caret(view, at(view, "link"));
    // Milkdown's clipboard pastes plain text this way.
    view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.text("pasted"), true));
    caret(view, at(view, "two"));
    toggleMark(view.state.schema.marks.strong)(view.state, view.dispatch);
    type(view, "B");
    expect(editor.getMarkdown()).toBe("Intro [link](https://e.com/a)pasted\n\nNext [two](https://e.com/2)**B**\n");
  });

  it("is plain after the caret arrives with the link's marks, as the virtual cursor's Right from inside sets", { timeout: 60_000 }, async () => {
    const { editor, view } = await open("Intro [link](https://e.com/a)\n");
    const end = at(view, "link");
    const link = view.state.doc.resolve(end - 1).marks();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)).setStoredMarks(link));
    type(view, "x");
    expect(editor.getMarkdown()).toBe("Intro [link](https://e.com/a)x\n");
  });

  it("joins the link after the virtual cursor's Left switches to the link's side, then a click back makes z plain", { timeout: 60_000 }, async () => {
    const { editor, view } = await open("A [link](https://e.com/b)s more.\n");
    caret(view, at(view, "link"));
    leftToLinkSide(view);
    type(view, "x");
    type(view, "y");
    expect(editor.getMarkdown()).toBe("A [linkxy](https://e.com/b)s more.\n");
    caret(view, at(view, "linkxy"));
    type(view, "z");
    expect(editor.getMarkdown()).toBe("A [linkxy](https://e.com/b)zs more.\n");
  });

  it("is plain again after undo puts the caret back at the link's end", { timeout: 60_000 }, async () => {
    const { editor, view } = await open("Intro [link](https://e.com/a)\n");
    caret(view, at(view, "link"));
    type(view, "x");
    undo(view.state, view.dispatch);
    type(view, "y");
    expect(editor.getMarkdown()).toBe("Intro [link](https://e.com/a)y\n");
  });
});

describe("changes away from a caret at a link's edge", () => {
  // Find selects its first match, and the user then clicks at a link's end
  // while the find card stays open.
  it("keep each match's marks for Replace All after a click at a link's end", { timeout: 60_000 }, async () => {
    const { editor, view } = await open("Intro [link](https://e.com/a)\n\nSome **bold** and [bold](https://e.com/b) words.\n");
    editor.search("bold", opts);
    caret(view, at(view, "link"));
    editor.replaceAll("BOLD", "bold", opts);
    expect(editor.getMarkdown()).toBe("Intro [link](https://e.com/a)\n\nSome **BOLD** and [BOLD](https://e.com/b) words.\n");
  });

  it("keep the match's marks for Replace after a click at a link's end", { timeout: 60_000 }, async () => {
    const { editor, view } = await open("Intro [link](https://e.com/a)\n\nSome **bold** word.\n");
    editor.search("bold", opts);
    caret(view, at(view, "link"));
    editor.replaceCurrent("BOLD", "bold", opts);
    expect(editor.getMarkdown()).toBe("Intro [link](https://e.com/a)\n\nSome **BOLD** word.\n");
  });

  it("keep a letter the browser puts inside the link in the link", { timeout: 60_000 }, async () => {
    const { editor, view } = await open("Intro [lnk](https://e.com/a)\n");
    const end = at(view, "lnk");
    caret(view, end);
    expect(view.state.storedMarks).not.toBeNull();
    input(view, end - 2, end - 2, "i");
    expect(editor.getMarkdown()).toBe("Intro [link](https://e.com/a)\n");
  });

  it("keep a fix of the link's last letters in the link", { timeout: 60_000 }, async () => {
    const { editor, view } = await open("Intro [teh](https://e.com/a)\n");
    const end = at(view, "teh");
    caret(view, end);
    input(view, end - 2, end, "he");
    expect(editor.getMarkdown()).toBe("Intro [the](https://e.com/a)\n");
  });
});

describe("the URL shown after a link", () => {
  it("is drawn before a plain caret at the link's end, where typed text goes", { timeout: 60_000 }, async () => {
    const { view } = await open("A [link](https://e.com/b)s more.\n");
    const end = at(view, "link");
    caret(view, end);
    expect(suffixSide(view, end)).toBe(-1);
  });

  it("stays after a caret on the link's side", { timeout: 60_000 }, async () => {
    const { view } = await open("A [link](https://e.com/b)s more.\n");
    const end = at(view, "link");
    caret(view, end);
    leftToLinkSide(view);
    expect(suffixSide(view, end)).toBe(1);
  });

  it("stays after a selection that ends at the link's end", { timeout: 60_000 }, async () => {
    const { view } = await open("Intro [link](https://e.com/a)\n");
    const end = at(view, "link");
    select(view, end - 1, end);
    expect(suffixSide(view, end)).toBe(1);
  });
});
