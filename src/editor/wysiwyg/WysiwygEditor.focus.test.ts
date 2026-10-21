// @vitest-environment jsdom
// Tests of md-easy's patch of ProseMirror's focus and selection handling, in
// patches/prosemirror-view@1.42.6.patch.
//
// ProseMirror puts its own selection back 20ms after the editor gains focus,
// in case the browser moved the caret on focus. On a busy page that timer can
// run after a key such as End has moved the caret but before ProseMirror reads
// the move, which put the caret back where the click left it. The patch skips
// the restore once a key or click has moved the selection since focus, and so
// does ProseMirror's own check for a move to the start of the document within
// 200 ms of focus, which undid Ctrl+Home.
//
// Chromium moves a selection it cannot show, such as a selected image between
// two code blocks, to the start of the document whenever the page is focused,
// also while it has focus already. ProseMirror's own check puts it back only
// within 200 ms of a focus event and not before a leading block that takes no
// caret. The patch puts the block's selection back when no input moved the
// selection since ProseMirror set it, and before a key goes in.
//
// ProseMirror itself types a key over a selection that is not text, such as
// a selected block or cells, and left text that comes without a key, such as
// from an input method, to Chromium. Over an image between two
// paragraphs, Chromium removed the DOM range around the image, which joined
// the paragraphs. The patch types such text as ProseMirror types a key, after
// it reads a move of the DOM selection that it has not read yet.
//
// A composition cannot be cancelled, so the patch leaves it to Chromium. The
// document view's compositionstart handler (lineEnd.ts) replaces such a
// selection as a key does first, and undoes that if the composition commits
// nothing.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { undo, undoDepth } from "@milkdown/kit/prose/history";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { NodeSelection, TextSelection, type Selection } from "@milkdown/kit/prose/state";
import { CellSelection } from "@milkdown/kit/prose/tables";
import type { EditorView } from "@milkdown/kit/prose/view";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { serializerStyleFromSettings } from "../../state/types";
import { WysiwygEditor } from "./WysiwygEditor";

let editor: WysiwygEditor | null = null;
let releaseSelectionChange: (() => void) | null = null;
afterEach(async () => {
  vi.useRealTimers();
  releaseSelectionChange?.();
  releaseSelectionChange = null;
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

// Crepe's code block view watches whether it is on screen, which jsdom cannot tell.
vi.stubGlobal("IntersectionObserver", class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});

/** Mount the document editor on `markdown` and return its view. Timers from
 *  then on run only when the test says so, and so does the clock if `clock`
 *  is set. */
async function mount(markdown: string, clock = false): Promise<EditorView> {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  await editor.mount(root, markdown, { onChange: vi.fn() }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  const view = (editor as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);
  vi.useFakeTimers({ toFake: clock ? ["setTimeout", "clearTimeout", "Date"] : ["setTimeout", "clearTimeout"] });
  return view;
}

/** Mount the document editor on one line and return its view and text node. */
async function open(): Promise<{ view: EditorView; text: Text }> {
  const view = await mount("First line. Markdown.\n");
  return { view, text: view.dom.querySelector("p")!.firstChild as Text };
}

/** Let the editor finish reacting to an event, as the browser does before it
 *  runs the event's default action or the next event. */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** Put the DOM caret at `offset` in `text` and let ProseMirror read it. */
async function placeCaret(text: Text, offset: number): Promise<void> {
  document.getSelection()!.collapse(text, offset);
  document.dispatchEvent(new Event("selectionchange"));
  await settle();
}

/** Keep selectionchange events from ProseMirror, as a busy page can deliver
 *  them after its restore timer. */
function holdSelectionChange(): void {
  const hold = (event: Event) => event.stopImmediatePropagation();
  document.addEventListener("selectionchange", hold, true);
  releaseSelectionChange = () => document.removeEventListener("selectionchange", hold, true);
}

const caretOffset = () => document.getSelection()!.anchorOffset;

it("keeps the caret where End moved it right after a click focused the editor", async () => {
  const { view, text } = await open();
  // A click in the middle of the line focuses the editor and places the caret.
  view.dom.focus();
  await placeCaret(text, "First line. Mar".length);
  holdSelectionChange();
  // ProseMirror reads the caret on keydown, then the browser moves it.
  view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "End", keyCode: 35, bubbles: true }));
  await settle();
  document.getSelection()!.collapse(text, text.length);
  await vi.advanceTimersByTimeAsync(20);
  expect(caretOffset()).toBe(text.length);
});

it("still puts the editor's caret back when focus alone moved it", async () => {
  const { view, text } = await open();
  view.dom.focus();
  await placeCaret(text, "First line. Mar".length);
  view.dom.blur();
  // Focus comes back with no key or click, and the browser moves the caret.
  holdSelectionChange();
  view.dom.focus();
  document.getSelection()!.collapse(text, "First".length);
  await vi.advanceTimersByTimeAsync(20);
  expect(caretOffset()).toBe("First line. Mar".length);
});

it("keeps the caret where Ctrl+Home moved it right after focus came back", async () => {
  const view = await mount("First line. Markdown.\n\nSecond line.\n", true);
  const text = view.dom.querySelector("p")!.firstChild as Text;
  view.dom.focus();
  await placeCaret(text, "First".length);
  await vi.advanceTimersByTimeAsync(500);
  view.dom.blur();
  // Focus comes back, and within 200 ms the browser moves the caret to the
  // start of the document for Ctrl+Home, which ProseMirror's own check after
  // focus took for a move by the browser.
  view.dom.focus();
  view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", keyCode: 36, ctrlKey: true, bubbles: true, cancelable: true }));
  await placeCaret(text, 0);
  await vi.advanceTimersByTimeAsync(20);
  expect(view.state.selection.from).toBe(1);
  expect(caretOffset()).toBe(0);
});

describe("a selected block that the page moves to the start of the document", () => {
  const code = (name: string) => "```js\nconst " + name + " = 1;\n```";
  const markdown = ["# Head", code("a"), "![Pic](pic.png)", code("b")].join("\n\n") + "\n";

  /** Open `source`, focus it and select its image, as a click does, then let
   *  the time pass in which ProseMirror's own check after focus runs. `start`
   *  is the node at whose start Chromium puts the caret when it moves the
   *  selection, the heading's text or, before a rule, the document. */
  async function selectImage(source = markdown): Promise<{ view: EditorView; image: number; start: Node }> {
    const view = await mount(source, true);
    let image = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "image-block") image = pos;
    });
    view.dom.focus();
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, image)));
    await vi.advanceTimersByTimeAsync(500);
    return { view, image, start: view.dom.querySelector("h1")?.firstChild ?? view.dom };
  }

  /** Press `key` on the editor without a default action, as jsdom has none. */
  function keydown(view: EditorView, key: string, keyCode: number, init: KeyboardEventInit = {}): void {
    view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, keyCode, bubbles: true, cancelable: true, ...init }));
  }

  /** Move the DOM selection to the start of `node`, as Chromium does, and
   *  report it after `wait` ms. */
  async function moveToStart(node: Node, wait = 20): Promise<void> {
    document.getSelection()!.collapse(node, 0);
    await vi.advanceTimersByTimeAsync(wait);
    document.dispatchEvent(new Event("selectionchange"));
    await settle();
  }

  it("keeps the block selected when the move came with no input", async () => {
    const { view, image, start } = await selectImage();
    await moveToStart(start);
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(view.state.selection.from).toBe(image);
    expect(document.getSelection()!.anchorNode).toBe(view.dom);
  });

  it("keeps the block selected for a key that comes before ProseMirror reads the move, and the key replaces it", async () => {
    const { view, start } = await selectImage();
    // Chromium moves the selection right before the key's events, and
    // reports the move while they are handled.
    document.getSelection()!.collapse(start, 0);
    keydown(view, "Q", 81);
    document.dispatchEvent(new Event("selectionchange"));
    await settle();
    view.dom.dispatchEvent(new KeyboardEvent("keypress", { key: "Q", charCode: 81, bubbles: true, cancelable: true }));
    await settle();
    expect(editor!.getMarkdown()).toBe(["# Head", code("a"), "Q", code("b")].join("\n\n") + "\n");
  });

  it("keeps the block selected for text that comes without a key before ProseMirror reads the move, and the text replaces it", async () => {
    const { view, start } = await selectImage();
    // An input method or the emoji panel can focus the page, which moves the
    // selection, and insert its text before Chromium reports the move.
    document.getSelection()!.collapse(start, 0);
    const input = new InputEvent("beforeinput", { inputType: "insertText", data: "漢", bubbles: true, cancelable: true });
    view.dom.dispatchEvent(input);
    document.dispatchEvent(new Event("selectionchange"));
    await settle();
    expect(input.defaultPrevented).toBe(true);
    expect(editor!.getMarkdown()).toBe(["# Head", code("a"), "漢", code("b")].join("\n\n") + "\n");
  });

  it("keeps the block selected for a composition that starts before ProseMirror reads the move, and the composition replaces it", async () => {
    const { view, image, start } = await selectImage();
    document.getSelection()!.collapse(start, 0);
    view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    // An empty paragraph takes the image's place, with the caret in it.
    const { $from } = view.state.selection;
    expect(view.state.selection.empty).toBe(true);
    expect($from.parent.type.name).toBe("paragraph");
    expect($from.parent.content.size).toBe(0);
    expect($from.before()).toBe(image);
  });

  it("keeps the block selected when the page moves the selection before a rule at the start", async () => {
    const { view, image, start } = await selectImage(["---", code("a"), "![Pic](pic.png)", code("b")].join("\n\n") + "\n");
    expect(view.state.doc.firstChild!.type.name).toBe("hr");
    // ProseMirror reads the caret before the rule as a gap cursor, not a
    // caret in the first text.
    await moveToStart(start);
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(view.state.selection.from).toBe(image);
  });

  it("keeps the block selected after a key that moves nothing, such as Ctrl+C", async () => {
    const { view, image, start } = await selectImage();
    keydown(view, "Control", 17, { ctrlKey: true });
    keydown(view, "c", 67, { ctrlKey: true });
    // The key's event is over and left the selection where it was.
    await settle();
    await moveToStart(start);
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(view.state.selection.from).toBe(image);
  });

  it("keeps the block selected after Shift on its own", async () => {
    const { view, image, start } = await selectImage();
    keydown(view, "Shift", 16);
    await moveToStart(start);
    expect(view.state.selection.from).toBe(image);
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
  });

  it("takes a move after a key the browser handles, such as Page Up", async () => {
    const { view, start } = await selectImage();
    keydown(view, "PageUp", 33);
    await moveToStart(start);
    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(view.state.selection.from).toBe(1);
  });

  it("takes such a move before text that comes without a key, and leaves the block", async () => {
    const { view, start } = await selectImage();
    keydown(view, "PageUp", 33);
    // The text comes before Chromium reports the move of Page Up.
    document.getSelection()!.collapse(start, 0);
    const input = new InputEvent("beforeinput", { inputType: "insertText", data: "漢", bubbles: true, cancelable: true });
    view.dom.dispatchEvent(input);
    expect(input.defaultPrevented).toBe(false);
    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(view.state.selection.from).toBe(1);
    expect(editor!.getMarkdown()).toBe(markdown);
  });

  it("takes such a move before a composition, and leaves the block", async () => {
    const { view, start } = await selectImage();
    keydown(view, "PageUp", 33);
    document.getSelection()!.collapse(start, 0);
    view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(view.state.selection.from).toBe(1);
    expect(editor!.getMarkdown()).toBe(markdown);
  });
});

describe("text that comes without a key over a selection that is not text", () => {
  const imageBetweenParagraphs = ["Above.", "![Pic](pic.png)", "Below."].join("\n\n") + "\n";

  /** The position of the first node in `doc` that `test` accepts. */
  function find(doc: ProseNode, test: (node: ProseNode) => boolean): number {
    let found = -1;
    doc.descendants((node, pos) => {
      if (found < 0 && test(node)) found = pos;
      return found < 0;
    });
    return found;
  }

  /** Open `markdown`, focus it and give it the selection `select` makes. */
  async function open(markdown: string, select: (doc: ProseNode) => Selection): Promise<EditorView> {
    const view = await mount(markdown);
    view.dom.focus();
    view.dispatch(view.state.tr.setSelection(select(view.state.doc)));
    await settle();
    return view;
  }

  const selectImage = (doc: ProseNode) => NodeSelection.create(doc, find(doc, (node) => node.type.name === "image-block"));

  /** Send `data` as an input method, the emoji panel or dictation does, with
   *  no key, and return the event. jsdom has no default action, so text that
   *  the editor leaves to the browser goes nowhere. */
  function input(view: EditorView, data: string, inputType = "insertText"): InputEvent {
    const event = new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true });
    view.dom.dispatchEvent(event);
    return event;
  }

  it("replaces an image selected between two paragraphs, and the paragraphs stay apart", async () => {
    const view = await open(imageBetweenParagraphs, selectImage);
    expect(input(view, "漢字").defaultPrevented).toBe(true);
    await settle();
    expect(editor!.getMarkdown()).toBe(["Above.", "漢字", "Below."].join("\n\n") + "\n");
  });

  it("replaces selected table cells as a key does", async () => {
    const table = "| A | B |\n| --- | --- |\n| one | two |\n| three | four |";
    const view = await open(["Above.", table].join("\n\n") + "\n", (doc) => {
      const cell = (text: string) => find(doc, (node) => node.type.spec.tableRole === "cell" && node.textContent === text);
      return CellSelection.create(doc, cell("one"), cell("two"));
    });
    expect(input(view, "漢字").defaultPrevented).toBe(true);
    await settle();
    // The text goes in the cell where the selection ends, and the other
    // selected cell is emptied. Milkdown pads the columns of a table it writes.
    expect(editor!.getMarkdown()).toBe(["Above.", "| A     | B    |\n| ----- | ---- |\n|       | 漢字   |\n| three | four |"].join("\n\n") + "\n");
  });

  it("leaves text over selected text to the browser", async () => {
    const view = await open(imageBetweenParagraphs, (doc) => TextSelection.create(doc, 1, 3));
    expect(input(view, "漢字").defaultPrevented).toBe(false);
    expect(editor!.getMarkdown()).toBe(imageBetweenParagraphs);
  });
});

describe("a composition over a selection that is not text", () => {
  const imageBetweenParagraphs = ["Above.", "![Pic](pic.png)", "Below."].join("\n\n") + "\n";
  const table = "| A | B |\n| --- | --- |\n| one | two |\n| three | four |";

  /** The position of the first node in `doc` that `test` accepts. */
  function find(doc: ProseNode, test: (node: ProseNode) => boolean): number {
    let found = -1;
    doc.descendants((node, pos) => {
      if (found < 0 && test(node)) found = pos;
      return found < 0;
    });
    return found;
  }

  /** Open `markdown` and give it the selection `select` makes, with focus
   *  in the document view. */
  async function open(markdown: string, select: (doc: ProseNode) => Selection): Promise<EditorView> {
    const view = await mount(markdown);
    view.dom.focus();
    view.dispatch(view.state.tr.setSelection(select(view.state.doc)));
    // Crepe's code block view takes focus in its code when it is selected,
    // and the block handle that selects one gives focus back to the document
    // view (blockHandle.ts).
    view.focus();
    await settle();
    return view;
  }

  const selectImage = (doc: ProseNode) => NodeSelection.create(doc, find(doc, (node) => node.type.name === "image-block"));

  /** The first text node in the document view that reads `text`. */
  function textNode(view: EditorView, text: string): Text {
    const walker = document.createTreeWalker(view.dom, NodeFilter.SHOW_TEXT, (node) => (node.textContent === text ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP));
    return walker.nextNode() as Text;
  }

  /** Start a composition of `text` as Chromium does. Chromium reads the
   *  selection once compositionstart is handled and puts the text there, in
   *  a text node of its own in an empty text block. Then it puts the caret at
   *  the text offset where the selection started before compositionstart,
   *  plus the text's length, which is `caret` after the editor changed the
   *  document. ProseMirror reads that caret with the text. Returns the text
   *  node, which stays the composition's as long as it is in the document. */
  async function startComposition(view: EditorView, text: string, caret: [Node, number]): Promise<Text> {
    view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const { focusNode, focusOffset } = document.getSelection()!;
    const block = focusNode as Element;
    const node = document.createTextNode(text);
    block.insertBefore(node, block.childNodes[focusOffset] ?? null);
    block.querySelector("br")?.remove();
    document.getSelection()!.collapse(...caret);
    await settle();
    return node;
  }

  /** End the composition with `text` committed, and let ProseMirror and the
   *  editor read its end. */
  async function endComposition(view: EditorView, text: string): Promise<void> {
    view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: text, bubbles: true }));
    await vi.advanceTimersByTimeAsync(100);
  }

  it("replaces an image selected between two paragraphs as it starts, and one undo brings the image back", async () => {
    const view = await open(imageBetweenParagraphs, selectImage);
    const above = textNode(view, "Above.");
    // Chromium puts the caret at the end of the paragraph above. ProseMirror
    // took that paragraph's text for the composition's and drew the new
    // paragraph's text again, which ended the composition.
    const composed = await startComposition(view, "漢字", [above, above.length]);
    expect(composed.isConnected).toBe(true);
    expect(document.getSelection()!.focusNode).toBe(composed);
    await endComposition(view, "漢字");
    expect(editor!.getMarkdown()).toBe(["Above.", "漢字", "Below."].join("\n\n") + "\n");
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor!.getMarkdown()).toBe(imageBetweenParagraphs);
    expect(view.state.selection.eq(selectImage(view.state.doc))).toBe(true);
  });

  it("puts the image back, selected, when the composition commits nothing, and adds no undo step", async () => {
    const view = await open(imageBetweenParagraphs, selectImage);
    const depth = undoDepth(view.state);
    const composed = await startComposition(view, "か", [textNode(view, "Above."), 6]);
    expect(find(view.state.doc, (node) => node.type.name === "image-block")).toBe(-1);
    // The composition is emptied, which ends it.
    composed.remove();
    await settle();
    await endComposition(view, "");
    expect(editor!.getMarkdown()).toBe(imageBetweenParagraphs);
    expect(view.state.selection.eq(selectImage(view.state.doc))).toBe(true);
    expect(undoDepth(view.state)).toBe(depth);
  });

  it.each([
    ["an image", imageBetweenParagraphs, selectImage],
    ["a code block", ["Above.", "```js\nconst x = 1;\n```", "Below."].join("\n\n") + "\n", (doc: ProseNode) => NodeSelection.create(doc, find(doc, (node) => node.type.name === "code_block"))],
  ])("still replaces %s with text committed without a composition after one that ended empty", async (_block, markdown, select) => {
    // IBus empties the composition, which ends it, and then commits its text
    // without one. If the block is back by then, that text replaces it. Crepe's
    // code block view takes focus in its code when it is selected, and the
    // text went there.
    const view = await open(markdown, select);
    const composed = await startComposition(view, "明", [textNode(view, "Above."), 6]);
    composed.remove();
    await settle();
    await endComposition(view, "");
    expect(view.hasFocus()).toBe(true);
    expect(view.state.selection.eq(select(view.state.doc))).toBe(true);
    const commit = new InputEvent("beforeinput", { inputType: "insertText", data: "明", bubbles: true, cancelable: true });
    view.dom.dispatchEvent(commit);
    expect(commit.defaultPrevented).toBe(true);
    await settle();
    expect(editor!.getMarkdown()).toBe(["Above.", "明", "Below."].join("\n\n") + "\n");
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(editor!.getMarkdown()).toBe(markdown);
  });

  it("replaces selected table cells as a key does", async () => {
    const view = await open(["Above.", table].join("\n\n") + "\n", (doc) => {
      const cell = (text: string) => find(doc, (node) => node.type.spec.tableRole === "cell" && node.textContent === text);
      return CellSelection.create(doc, cell("one"), cell("two"));
    });
    // The cell the text goes in lost the text before it, so Chromium's caret
    // lands that much further on.
    const composed = await startComposition(view, "漢字", [textNode(view, "three"), 1]);
    expect(composed.isConnected).toBe(true);
    await endComposition(view, "漢字");
    // The text goes in the cell where the selection ends, and the other
    // selected cell is emptied. Milkdown pads the columns of a table it writes.
    expect(editor!.getMarkdown()).toBe(["Above.", "| A     | B    |\n| ----- | ---- |\n|       | 漢字   |\n| three | four |"].join("\n\n") + "\n");
  });

  it("leaves a composition over selected text or at a caret to the browser", async () => {
    const view = await open(imageBetweenParagraphs, (doc) => TextSelection.create(doc, 1, 3));
    for (const selection of [TextSelection.create(view.state.doc, 1, 3), TextSelection.create(view.state.doc, 3)]) {
      view.dispatch(view.state.tr.setSelection(selection));
      const { doc } = view.state;
      view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      expect(view.state.doc).toBe(doc);
      expect(view.state.selection.eq(selection)).toBe(true);
      await endComposition(view, "");
      expect(view.state.doc).toBe(doc);
    }
  });
});
