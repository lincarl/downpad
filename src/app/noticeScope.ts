// Which document a notice in the notice bar is about (design, Data and
// persistence).

import type { Store } from "../state/store";

/** Clear the notice bar as soon as another document, or none, is in front:
 *  another tab, another file in the same tab, or the Recent view. A notice is
 *  about what was in front when it showed. It goes at that moment and not
 *  once the new document's editor is built, so a notice that shows while the
 *  editor is built stays, and so does one over a document that is only shown
 *  again. A document that is replaced in its tab, as by a reload, clears the
 *  bar where it is replaced (`AppRuntime.presentActiveDoc`). Returns the
 *  unsubscribe function. */
export function clearNoticesOfOtherDocuments(store: Pick<Store, "get" | "set" | "select">): () => void {
  return store.select(
    (state) => (state.view === "recent" ? "recent" : `${state.activeTabId ?? ""}\n${state.doc.filePath ?? ""}`),
    () => {
      if (store.get().banner) store.set({ banner: null });
    },
  );
}
