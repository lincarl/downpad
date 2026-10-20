// @vitest-environment jsdom
// Tests of md-easy's patch of ProseMirror's focus and selection handling, in
// patches/prosemirror-view@1.41.8.patch.
//
// ProseMirror puts its own selection back 20ms after the editor gains focus,
// in case the browser moved the caret on focus. On a busy page that timer can
// run after a key such as End has moved the caret but before ProseMirror reads
// the move, which put the caret back where the click left it. The patch skips
// the restore once a key or click has moved the selection since focus.
//
// Chromium moves a selection it cannot show, such as a selected image between
// two code blocks, to the start of the document whenever the page is focused,
// also while it has focus already. The patch puts the block's selection back
// when no input moved the selection since ProseMirror set it, and before a key
// or text that comes without one goes in.
//
// ProseMirror itself types a key over a selection that is not text, such as
// a selected block or cells, and left text that comes without a key, such as
// from an input method, to Chromium. Over an image between two
// paragraphs, Chromium removed the DOM range around the image, which joined
// the paragraphs. The patch types such text as ProseMirror types a key.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
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

  it("leaves a composition over a selected image, and text over selected text, to the browser", async () => {
    const view = await open(imageBetweenParagraphs, selectImage);
    view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    // ProseMirror reads the DOM selection as a composition starts, which
    // here puts the caret after "Above.", so select the image again.
    view.dispatch(view.state.tr.setSelection(selectImage(view.state.doc)));
    expect(input(view, "か", "insertCompositionText").defaultPrevented).toBe(false);
    expect(input(view, "漢字").defaultPrevented).toBe(false);
    view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: "漢字", bubbles: true }));
    await vi.advanceTimersByTimeAsync(100);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));
    await settle();
    expect(input(view, "漢字").defaultPrevented).toBe(false);
    expect(editor!.getMarkdown()).toBe(imageBetweenParagraphs);
  });
});
