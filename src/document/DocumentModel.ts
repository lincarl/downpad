// Coordinates edits to the canonical markdown string (the single source of
// truth). Editor panes call applyEditorMarkdownForTab on every change; loading
// replaces the document wholesale. A document is unsaved while its text differs
// from the text last read from or written to its file. See docs/design.md §4.

import type { Store } from "../state/store";
import type { Eol } from "../state/types";

/**
 * Apply markdown from an editor pane bound to a specific tab (spec §5.19). It
 * targets the tab by id so a *background* pane writes to its own tab, never the
 * active one. An edit back to the saved text leaves the document saved. Returns
 * whether the canonical actually changed. The editor host uses this to advance
 * the tab's editor revision (and so invalidate the other view's stale undo).
 * No-op (false) when the tab is gone or the text is unchanged. The second case
 * keeps an editor that emits its initial or normalized content on mount from
 * marking a freshly loaded document dirty.
 */
export function applyEditorMarkdownForTab(
  store: Store,
  tabId: string,
  markdown: string,
): boolean {
  const tab = store.get().tabs.find((t) => t.id === tabId);
  if (!tab || tab.doc.markdown === markdown) return false;
  store.patchDocById(tabId, { markdown, isDirty: markdown !== tab.doc.savedMarkdown });
  return true;
}

/**
 * Load fresh document content into the active tab (replacing whatever it held),
 * creating a tab if none is open. Resets dirty state and records the
 * path/encoding metadata. Markdown is the canonical LF-normalized form.
 */
export function loadDocument(
  store: Store,
  markdown: string,
  meta: { filePath: string | null; eol: Eol; hadBom: boolean; modifiedMs?: number },
): void {
  store.replaceActiveDoc({
    markdown,
    filePath: meta.filePath,
    eol: meta.eol,
    hadBom: meta.hadBom,
    modifiedMs: meta.modifiedMs ?? 0,
    isDirty: false,
    savedMarkdown: markdown,
    frontmatterCollapsed: false,
  });
}
