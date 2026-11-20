// Which document a notice in the notice bar is about (design, Data and
// persistence).

import type { Store } from "../state/store";

/** Clear the notice bar as soon as another document, or none, is in front:
 *  another tab, or another file in the same tab. A notice is about the
 *  document that was in front when it showed. It goes at that moment and not
 *  once the new document's editor is built, so a notice that shows while the
 *  editor is built stays, and so does one over a document that is only shown
 *  or reloaded again. Returns the unsubscribe function. */
export function clearNoticesOfOtherDocuments(store: Pick<Store, "get" | "set" | "select">): () => void {
  return store.select(
    (state) => `${state.activeTabId ?? ""}\n${state.doc.filePath ?? ""}`,
    () => {
      if (store.get().banner) store.set({ banner: null });
    },
  );
}
