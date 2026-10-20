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
// when no input that can move the selection came since ProseMirror set it.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
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

  /** Open the document, focus it and select its image, as a click does, then
   *  let the time pass in which ProseMirror's own check after focus runs. */
  async function selectImage(): Promise<{ view: EditorView; image: number; heading: Text }> {
    const view = await mount(markdown, true);
    let image = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "image-block") image = pos;
    });
    view.dom.focus();
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, image)));
    await vi.advanceTimersByTimeAsync(500);
    return { view, image, heading: view.dom.querySelector("h1")!.firstChild as Text };
  }

  /** Press `key` on the editor without a default action, as jsdom has none. */
  function keydown(view: EditorView, key: string, keyCode: number): void {
    view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, keyCode, bubbles: true, cancelable: true }));
  }

  /** Move the DOM selection to the start of the heading, as Chromium does,
   *  and report it after `wait` ms. */
  async function moveToStart(heading: Text, wait = 20): Promise<void> {
    document.getSelection()!.collapse(heading, 0);
    await vi.advanceTimersByTimeAsync(wait);
    document.dispatchEvent(new Event("selectionchange"));
    await settle();
  }

  it("keeps the block selected when the move came with no input", async () => {
    const { view, image, heading } = await selectImage();
    await moveToStart(heading);
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(view.state.selection.from).toBe(image);
    expect(document.getSelection()!.anchorNode).toBe(view.dom);
  });

  it("keeps the block selected for a key that comes before ProseMirror reads the move, and the key replaces it", async () => {
    const { view, heading } = await selectImage();
    // Chromium moves the selection right before the key's events, and
    // reports the move while they are handled.
    document.getSelection()!.collapse(heading, 0);
    keydown(view, "Q", 81);
    document.dispatchEvent(new Event("selectionchange"));
    await settle();
    view.dom.dispatchEvent(new KeyboardEvent("keypress", { key: "Q", charCode: 81, bubbles: true, cancelable: true }));
    await settle();
    expect(editor!.getMarkdown()).toBe(["# Head", code("a"), "Q", code("b")].join("\n\n") + "\n");
  });

  it("keeps the block selected after Shift on its own", async () => {
    const { view, image, heading } = await selectImage();
    keydown(view, "Shift", 16);
    await moveToStart(heading);
    expect(view.state.selection.from).toBe(image);
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
  });

  it("takes a move after a key the browser handles, such as Page Up", async () => {
    const { view, heading } = await selectImage();
    keydown(view, "PageUp", 33);
    await moveToStart(heading);
    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(view.state.selection.from).toBe(1);
  });
});
