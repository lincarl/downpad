// Tab in the document view. Lists (nest or lift an item), tables (next or
// previous cell) and code blocks (indent) keep their own Tab keys. A Tab that
// nothing in the editor uses moves focus out of the document instead of
// trapping it, and Esc then Tab leaves from anywhere in it, as CodeMirror does
// in code blocks. Tab also stays in the document while the slash menu is
// open, and Esc closes the menu.

import { rootDOMCtx } from "@milkdown/kit/core";
import { Plugin } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { focusPast } from "@/components/ui/menu";

/** How long after Esc a Tab leaves the document. CodeMirror uses the same 2 s. */
const ESCAPE_WINDOW_MS = 2000;
/** Keys that keep the Esc window open, as in CodeMirror. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock"]);
/** Nodes whose own Tab keys may do nothing at an end (the first item, the last
 *  cell). Tab stays in the document there rather than leaving it by surprise. */
const TAB_CONTAINERS = new Set(["list_item", "table_cell", "table_header"]);

/** Whether `event` is Tab or Shift+Tab, without other modifiers or an IME composition. */
function isTab(event: KeyboardEvent): boolean {
  return event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing;
}

/** Whether the selection is inside a list item or table cell. */
function inTabContainer(view: EditorView): boolean {
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if (TAB_CONTAINERS.has($from.node(depth).type.name)) return true;
  }
  return false;
}

/** Whether Crepe's slash menu is open in `container`. While open it reads Enter
 *  and the arrow keys from the whole window, so focus must not leave under it. */
function slashMenuOpen(container: HTMLElement): boolean {
  return container.querySelector('.milkdown-slash-menu[data-show="true"]') !== null;
}

/**
 * Listen for Tab on `container`, the element that holds the editor and its
 * widgets, and return the cleanup. The capture listener runs before the editor
 * and code blocks see a key, so Esc then Tab leaves without nesting an item or
 * indenting code. The bubble listener runs after them and only acts on a Tab
 * they left alone.
 */
function installTabExit(container: HTMLElement, view: EditorView): () => void {
  let escapedAt = -Infinity;
  /** Whether keys at `target` go to the document text or a code block in it. */
  const inText = (target: EventTarget | null): boolean =>
    target === view.dom || (target instanceof Element && target.matches(".cm-content") && view.dom.contains(target));
  /** Move focus out of the document, backward for Shift+Tab. */
  const leave = (event: KeyboardEvent): void => {
    event.preventDefault();
    focusPast(container, event.shiftKey);
  };
  /** Note when Esc was pressed, and leave on a Tab that follows it. */
  const capture = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      escapedAt = Date.now();
      return;
    }
    if (MODIFIER_KEYS.has(event.key)) return;
    const escaped = Date.now() - escapedAt <= ESCAPE_WINDOW_MS;
    escapedAt = -Infinity;
    if (!escaped || !isTab(event) || !inText(event.target)) return;
    event.stopPropagation();
    leave(event);
  };
  /** Leave on a Tab the editor left alone, except in a list item or table cell
   *  or under the slash menu. */
  const bubble = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || !isTab(event) || !inText(event.target)) return;
    if (event.target === view.dom && (inTabContainer(view) || slashMenuOpen(container))) event.preventDefault();
    else leave(event);
  };
  container.addEventListener("keydown", capture, true);
  container.addEventListener("keydown", bubble);
  return () => {
    container.removeEventListener("keydown", capture, true);
    container.removeEventListener("keydown", bubble);
  };
}

/** Milkdown plugin that lets Tab leave the document view. Milkdown creates the
 *  editor's root element before plugin views, so it is set when this one starts. */
export const tabExit = $prose(
  (ctx) =>
    new Plugin({
      view: (view) => ({ destroy: installTabExit(ctx.get(rootDOMCtx), view) }),
    }),
);
