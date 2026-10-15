// Coordinates edits to the canonical markdown string (the single source of
// truth). Editors call applyEditorMarkdown on every change; loading replaces
// the document wholesale. See docs/design.md §4.

import type { Store } from "../state/store";
import type { Eol } from "../state/types";

/**
 * Apply markdown produced by an active editor. No-op if unchanged (this guards
 * against editors emitting their initial/normalized content on mount, which
 * would otherwise mark a freshly-loaded document dirty).
 */
export function applyEditorMarkdown(store: Store, markdown: string): void {
  if (store.get().doc.markdown === markdown) return;
  store.patchDoc({ markdown, isDirty: true });
}

/**
 * Apply markdown from an editor pane bound to a specific tab (spec §5.19). Like
 * applyEditorMarkdown, but targets the tab by id so a *background* pane writes to
 * its own tab, never the active one. Returns whether the canonical actually
 * changed — the editor host uses this to advance the tab's editor revision (and
 * so invalidate the other view's stale undo). No-op (false) when unchanged or the
 * tab is gone.
 */
export function applyEditorMarkdownForTab(
  store: Store,
  tabId: string,
  markdown: string,
): boolean {
  const tab = store.get().tabs.find((t) => t.id === tabId);
  if (!tab || tab.doc.markdown === markdown) return false;
  store.patchDocById(tabId, { markdown, isDirty: true });
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
    frontmatterCollapsed: false,
  });
}
