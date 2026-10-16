// Tab in the document view. Lists (nest or lift an item), tables (next or
// previous cell) and code blocks (indent) keep their own Tab keys. A Tab that
// nothing in the editor uses moves focus out of the document instead of
// trapping it, and Esc then Tab leaves from anywhere in it, as CodeMirror does
// in code blocks. In a code block, Esc then Tab first reaches the block's own
// language and Copy buttons, and Tab from the last of them leaves. Tab also
// stays in the document while the slash menu is open, and Esc closes the menu.

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

/** The language and Copy buttons of the code block that holds `target`, in Tab
 *  order, or none outside a code block. */
function codeBlockTools(target: Element): HTMLElement[] {
  const block = target.closest(".milkdown-code-block");
  return block ? Array.from(block.querySelectorAll<HTMLElement>(".language-button, .tools-button-group > button")) : [];
}

/** Whether Crepe's slash menu is open in `container`. Tab stays in the
 *  document while it is. */
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
  /** Move between a code block's buttons, back into its code before the first
   *  and out of the document after the last. */
  const moveInTools = (event: KeyboardEvent, tools: HTMLElement[], at: number): void => {
    event.preventDefault();
    event.stopPropagation();
    const next = at + (event.shiftKey ? -1 : 1);
    if (next >= tools.length) focusPast(container, false);
    else if (next >= 0) tools[next].focus();
    else tools[0].closest(".milkdown-code-block")?.querySelector<HTMLElement>(".cm-content")?.focus();
  };
  /** Note when Esc was pressed, and leave on a Tab that follows it. A code
   *  block's buttons come first after Esc in its code. */
  const capture = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      escapedAt = Date.now();
      return;
    }
    if (MODIFIER_KEYS.has(event.key)) return;
    const escaped = Date.now() - escapedAt <= ESCAPE_WINDOW_MS;
    escapedAt = -Infinity;
    if (!isTab(event) || !(event.target instanceof HTMLElement)) return;
    const tools = codeBlockTools(event.target);
    const at = tools.indexOf(event.target);
    if (at >= 0) return moveInTools(event, tools, at);
    if (!escaped || !inText(event.target)) return;
    if (!event.shiftKey && tools.length > 0 && event.target.matches(".cm-content")) return moveInTools(event, tools, -1);
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
