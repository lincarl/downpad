// Global keyboard routing for the application shell. The dependency surface is
// deliberately callback-based so shortcut policy can be tested independently
// from the long-lived runtime and editor implementations.

import type { Store } from "../state/store";

export interface AppShortcutActions {
  store: Store;
  isPrintOpen(): boolean;
  isFindOpen(): boolean;
  findNext(): void;
  findPrevious(): void;
  showFind(mode: "find" | "replace"): void;
  focusRecentSearch(): void;
  save(saveAs: boolean): void;
  open(): void;
  create(): void;
  print(): void;
}

/** Install the app-wide shortcuts and return their exact teardown function. */
export function installAppShortcuts(actions: AppShortcutActions): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    // The print workspace owns its own key handling while it covers the window.
    if (actions.isPrintOpen()) return;

    if (event.key === "F3") {
      if (actions.store.get().view === "wysiwyg" && actions.isFindOpen()) {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) actions.findPrevious();
        else actions.findNext();
      }
      return;
    }

    if (!event.ctrlKey && !event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      actions.save(event.shiftKey);
    } else if (key === "o" && !event.shiftKey) {
      event.preventDefault();
      actions.open();
    } else if (key === "n" && !event.shiftKey) {
      event.preventDefault();
      actions.create();
    } else if (key === "p") {
      // Always suppress browser/WebView printing. Ctrl+Shift+P is reserved and
      // intentionally does not open md-easy's print workspace.
      event.preventDefault();
      if (!event.shiftKey) actions.print();
    } else if (key === "f" && !event.shiftKey && actions.store.get().view === "recent") {
      event.preventDefault();
      actions.focusRecentSearch();
    } else if ((key === "f" || key === "h") && !event.shiftKey) {
      const state = actions.store.get();
      // Search is permanent application chrome. It targets the formatted
      // document or raw Markdown according to the selected editor layout, so
      // Ctrl+F always focuses the same already-visible field.
      if (state.view === "wysiwyg") {
        event.preventDefault();
        event.stopPropagation();
        actions.showFind(key === "h" ? "replace" : "find");
      }
    }
  };

  // Capture before editor-local keymaps so CodeMirror cannot open a second
  // search panel underneath the permanent application strip.
  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
