// Add blocks on empty rows, focus after a press on Crepe's block handle,
// and the handle after the document view changes width.
//
// On an empty paragraph or heading, + opens Crepe's menu in that row. Crepe
// normally inserts another paragraph first. The handle's positioning hook
// records its block, so this uses the hovered row even if the caret is
// elsewhere. Other blocks keep Crepe's insertion behavior.
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
//
// The handle finds the block under the pointer only on a pointer move over
// the document view, at most every 200 ms. After the view changes width, as
// on a switch from the Document view to the Split view, it stayed where it
// was, which could be over the text, such as a list item's bullet or a task's
// box. A click there right after the switch selected the handle's block, and
// the next key replaced it. Once the pointer moved, the handle slid into
// place over 0.2 s and still took clicks on its way. This plugin hides the
// handle whenever the view's width changes, so it takes no press until the
// pointer shows it again beside the block under it, and md-easy's styles have
// it appear there at once rather than slide.

import type { Ctx } from "@milkdown/kit/ctx";
import type { ActiveNode, BlockProviderOptions } from "@milkdown/kit/plugin/block";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

/** Crepe's block handle, which it puts in the element that holds the
 *  document view. */
const HANDLE = ".milkdown-block-handle";

/** The block Crepe last positioned each handle beside. */
const handleBlocks = new WeakMap<HTMLElement, ActiveNode>();

/** Configure Crepe's BlockEdit handle together with the blockHandle plugin.
 *  Its supported positioning hook gives us the hovered block while keeping
 *  Crepe's default spacing. */
export const blockHandleConfig: Pick<BlockProviderOptions, "getOffset"> = {
  getOffset: ({ active, blockDom }) => {
    handleBlocks.set(blockDom, active);
    return 16;
  },
};

/** Crepe does not export this context slice. slashMenuBlur uses the same API. */
type SlashMenuAPI = { show: (pos: number) => void };

/** Open the existing menu on an empty row before Crepe inserts a new one. */
function menuOnEmptyRow(ctx: Ctx, view: EditorView, holder: HTMLElement): () => void {
  const release = (event: PointerEvent): void => {
    if (event.button !== 0 || !view.editable || !(event.target instanceof Element)) return;
    const add = event.target.closest<HTMLElement>(`${HANDLE} > .operation-item:first-child`);
    const handle = add?.parentElement;
    if (!add || !handle || handle.parentElement !== holder || handle.dataset.show !== "true") return;
    const active = handleBlocks.get(handle);
    if (!active || active.$pos.doc !== view.state.doc) return;
    // A nested handle can represent a whole list, quote or table. In a list
    // Crepe also disallows its slash menu, even on an empty continuation row.
    if (active.$pos.depth !== 0 || !["paragraph", "heading"].includes(active.node.type.name) || active.node.content.size !== 0) return;

    event.preventDefault();
    event.stopPropagation();
    add.classList.remove("active");
    const pos = active.$pos.pos + 1;
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)).scrollIntoView());
    handle.dataset.show = "false";
    ctx.get<SlashMenuAPI, "menuAPICtx">("menuAPICtx").show(pos);
  };
  holder.addEventListener("pointerup", release, true);
  return () => holder.removeEventListener("pointerup", release, true);
}

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

/** Hide the view's block handle whenever the view's width changes (see the
 *  header). Returns a function that stops this. */
function hideHandleOnResize(view: EditorView, holder: HTMLElement): () => void {
  let width = view.dom.offsetWidth;
  const observer = new ResizeObserver(() => {
    if (view.dom.offsetWidth === width) return;
    width = view.dom.offsetWidth;
    // Crepe hides the handle the same way, and shows it again on the next
    // pointer move over a block.
    for (const handle of holder.querySelectorAll<HTMLElement>(`:scope > ${HANDLE}`)) handle.dataset.show = "false";
  });
  observer.observe(view.dom);
  return () => observer.disconnect();
}

/** Keep an empty row for the menu, restore focus after handle presses, and
 *  hide the handle when the view's width changes (see the header). */
export const blockHandle = $prose(
  (ctx) =>
    new Plugin({
      view(view) {
        const holder = view.dom.parentElement;
        if (!holder) return {};
        const stops = [menuOnEmptyRow(ctx, view, holder), focusAfterHandlePress(view, holder), hideHandleOnResize(view, holder)];
        return { destroy: () => stops.forEach((stop) => stop()) };
      },
    }),
);
