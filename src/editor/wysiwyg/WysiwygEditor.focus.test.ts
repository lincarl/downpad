// @vitest-environment jsdom
// ProseMirror puts its own selection back 20ms after the editor gains focus,
// in case the browser moved the caret on focus. On a busy page that timer can
// run after a key such as End has moved the caret but before ProseMirror reads
// the move, which put the caret back where the click left it. The patch in
// patches/prosemirror-view@1.41.8.patch skips the restore once a key or click
// has moved the selection since focus.

import { afterEach, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
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

/** Mount the document editor on one line and return its view and text node. */
async function open(): Promise<{ view: EditorView; text: Text }> {
  const root = document.createElement("div");
  document.body.append(root);
  editor = new WysiwygEditor();
  await editor.mount(root, "First line. Markdown.\n", { onChange: vi.fn() }, serializerStyleFromSettings(DEFAULT_SETTINGS), {
    getSettings: () => DEFAULT_SETTINGS,
    getFilePath: () => null,
    requestSave: async () => false,
  });
  const view = (editor as unknown as { crepe: Crepe }).crepe.editor.ctx.get(editorViewCtx);
  // Timers from here on run only when the test says so.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
