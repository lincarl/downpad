// Focus after a press on Crepe's block handle.
//
// A press on the handle selects its block and focuses the document view.
// The handle lies outside the view and takes no focus, so Chromium then moved
// focus to the page. Crepe focuses the view again only on a release on the
// handle itself. A drag that moves the block focuses the view when the block
// goes in (dropEdge.ts), but a drag that ended anywhere else left focus on the
// page, and the next key was lost. That held for a drag cancelled with
// Escape, one dropped back in place or outside the document, and a Shift+drag,
// which Chromium never starts as a drag because Shift extends a selection.
// Once a press on the handle ends, with a release anywhere or the end of its
// drag, this plugin focuses the view if nothing else has taken focus. The
// handle's block, or the block the drag moved, is then selected, so the next
// key replaces it, as after a click on the handle.

import { Plugin } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

/** Crepe's block handle, which it puts in the element that holds the
 *  document view. */
const HANDLE = ".milkdown-block-handle";

/** Focus the view once a press on its block handle ends with a release or
 *  the end of a drag, unless something else has taken focus by then (see the
 *  header). Returns a function that stops this. */
function focusAfterHandlePress(view: EditorView, holder: HTMLElement): () => void {
  const page = view.dom.ownerDocument;
  let ending: AbortController | null = null;
  const press = (event: MouseEvent): void => {
    const { target } = event;
    if (event.button !== 0 || !(target instanceof Element) || !target.closest(HANDLE)) return;
    ending?.abort();
    const listening = new AbortController();
    ending = listening;
    const end = (): void => {
      listening.abort();
      const active = page.activeElement;
      if (!view.isDestroyed && (!active || active === page.body)) view.focus();
    };
    // In the capture phase, so no listener that stops the event keeps it from
    // this one. Chromium sends no mouseup after a drag, only its dragend.
    page.addEventListener("mouseup", end, { capture: true, signal: listening.signal });
    page.addEventListener("dragend", end, { capture: true, signal: listening.signal });
  };
  holder.addEventListener("mousedown", press, true);
  return () => {
    ending?.abort();
    holder.removeEventListener("mousedown", press, true);
  };
}

/** ProseMirror plugin that focuses the document view after a press on Crepe's
 *  block handle (see the header). Crepe puts the handle in the element that
 *  holds the view. */
export const blockHandle = $prose(
  () =>
    new Plugin({
      view(view) {
        const holder = view.dom.parentElement;
        if (!holder) return {};
        return { destroy: focusAfterHandlePress(view, holder) };
      },
    }),
);
