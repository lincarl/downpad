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

/** Where the documents were scrolled that the Recent view came to the front
 *  over. A hidden editor area can be neither measured nor scrolled, so a
 *  document's place is taken as the Recent view comes, and put back the next
 *  time the document shows, also after another tab was in front, and also in
 *  editors built meanwhile, as when Get latest replaced the document. Editors
 *  that were not rebuilt are at that place already. */
export class PlacesBehindRecent {
  private readonly places = new Map<string, Place>();

  /** The Recent view comes to the front: take the place of the tab whose
   *  editors the area shows, which is `shownTab`, and forget the tabs that
   *  are not among `openTabs` any more. */
  take(editorArea: HTMLElement, shownTab: string | null, openTabs: readonly string[]): void {
    for (const tab of this.places.keys()) {
      if (!openTabs.includes(tab)) this.places.delete(tab);
    }
    if (shownTab !== null) this.places.set(shownTab, capturePlace(editorArea));
  }

  /** The document of `tab` shows: put the place back that was taken for it,
   *  once. `inFront` tells the tab in front in the next frame. */
  giveBack(editorArea: HTMLElement, tab: string | null, inFront: () => string | null): void {
    const place = tab === null ? undefined : this.places.get(tab);
    if (tab === null || !place) return;
    this.places.delete(tab);
    restorePlace(editorArea, place, () => inFront() === tab);
  }
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
