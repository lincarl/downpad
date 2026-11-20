// Keeps a document where it is scrolled while its editors are built again
// (design, Git).

/** Where the editor area and each pane shown in it are scrolled. */
export type Place = ReadonlyMap<string, number>;

const panes = (editorArea: HTMLElement): HTMLElement[] =>
  [editorArea, ...editorArea.querySelectorAll<HTMLElement>(".editor-pane:not([hidden])")];
const part = (editorArea: HTMLElement, element: HTMLElement): string =>
  element === editorArea ? "area" : element.classList.contains("editor-pane-raw") ? "raw" : "wysiwyg";

/** Where the editor area and its panes are scrolled now. A hidden area, as
 *  behind the Recent view, measures as not scrolled. */
export function capturePlace(editorArea: HTMLElement): Place {
  return new Map(panes(editorArea).map((element) => [part(editorArea, element), element.scrollTop]));
}

/** Scroll the editor area and the panes it shows now to `place`, and once
 *  more in the next frame, as a new document view can still grow then while
 *  its images and diagrams take their place. `still` can call the second
 *  scroll off. */
export function restorePlace(editorArea: HTMLElement, place: Place, still: () => boolean = () => true): void {
  const restore = (): void => {
    if (!still()) return;
    for (const element of panes(editorArea)) {
      const top = place.get(part(editorArea, element));
      if (top !== undefined) element.scrollTop = top;
    }
  };
  restore();
  requestAnimationFrame(restore);
}

/** Run a reload of the document in front and scroll its new editors to where
 *  the old ones were, so a document that Get latest changed stays in place.
 *  `inFront` tells the tab in front. If another tab is in front once the
 *  reload ends, as when the user showed it meanwhile, nothing is scrolled,
 *  since the panes are that tab's then. */
export async function keepingPlace(editorArea: HTMLElement, inFront: () => string | null, reload: () => Promise<void>): Promise<void> {
  const tab = inFront();
  const before = capturePlace(editorArea);
  await reload();
  restorePlace(editorArea, before, () => inFront() === tab);
}
