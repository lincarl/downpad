// The notice that a save has waited long for its file's drive (design, Data
// and persistence). It names the document, never takes the place of another
// notice, and goes when that write ends or the document's tab closes.

import type { Store } from "../state/store";
import type { BannerState } from "../state/types";
import { SLOW_WRITE_MS } from "../files/FileService";

export class SlowSaveNotice {
  /** The notice that shows, with its tab. */
  private shown: { tabId: string; banner: BannerState } | null = null;

  constructor(private readonly store: Pick<Store, "get" | "set">) {}

  /** Show that a write of a tab's document has run for SLOW_WRITE_MS without
   *  an answer, naming the document by `label`. Another notice that shows
   *  stays, apart from this notice for another document, which this one
   *  replaces. */
  show(tabId: string, label: string): void {
    const { banner } = this.store.get();
    if (banner && banner !== this.shown?.banner) return;
    const seconds = Math.round(SLOW_WRITE_MS / 1000);
    const next: BannerState = {
      kind: "info",
      message: `Saving “${label}” has not finished after ${seconds} seconds. Its drive may not be answering. To close it without waiting, close it and choose Discard.`,
    };
    this.shown = { tabId, banner: next };
    this.store.set({ banner: next });
  }

  /** Take the notice of a tab's document down if it still shows, as once its
   *  slow write ended, written or not, or once its tab closed, when the notice
   *  no longer has a document to tell about. */
  takeDown(tabId: string): void {
    const { shown } = this;
    if (shown?.tabId !== tabId) return;
    this.shown = null;
    if (this.store.get().banner === shown.banner) this.store.set({ banner: null });
  }
}
