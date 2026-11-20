// Keeps a document where it is scrolled while its editors are built again
// (design, Git).

/** Run a reload of the document in front and scroll its new editors to where
 *  the old ones were, so a document that Get latest changed stays in place.
 *  `inFront` tells the tab in front. If another tab is in front once the
 *  reload ends, as when the user showed it meanwhile, nothing is scrolled,
 *  since the panes are that tab's then. */
export async function keepingPlace(editorArea: HTMLElement, inFront: () => string | null, reload: () => Promise<void>): Promise<void> {
  const panes = (): HTMLElement[] => [editorArea, ...editorArea.querySelectorAll<HTMLElement>(".editor-pane:not([hidden])")];
  const place = (element: HTMLElement): string =>
    element === editorArea ? "area" : element.classList.contains("editor-pane-raw") ? "raw" : "wysiwyg";
  const tab = inFront();
  const before = new Map(panes().map((element) => [place(element), element.scrollTop]));
  await reload();
  const restore = (): void => {
    if (inFront() !== tab) return;
    for (const element of panes()) {
      const top = before.get(place(element));
      if (top !== undefined) element.scrollTop = top;
    }
  };
  restore();
  // The new document view can still grow in the next frame, as its images
  // and diagrams take their place.
  requestAnimationFrame(restore);
}
