// The error notice of a Save or Save As that failed (design, Data and
// persistence). It names the document, and a later write of that document
// that works takes it down.

import { failureReason } from "../ipc/failureReason";
import type { Store } from "../state/store";
import type { BannerState } from "../state/types";

export class SaveFailureNotice {
  /** The notice of the last save that failed, with its tab. */
  private shown: { tabId: string; banner: BannerState } | null = null;

  constructor(private readonly store: Pick<Store, "get" | "set">) {}

  /** Show that the save of a tab's document failed with `error`. The notice
   *  names the document by `label`, since another tab can be in front. */
  show(tabId: string, label: string, error: unknown): void {
    const banner: BannerState = { kind: "error", message: `Downpad could not save “${label}”. ${failureReason(error)}`.trimEnd() };
    this.shown = { tabId, banner };
    this.store.set({ banner });
  }

  /** A write of a tab's document worked, whoever asked for it: a save the
   *  user asks for, autosave or the save before Copy file. The notice of that
   *  tab's failed save goes if it still shows. A notice that was dismissed or
   *  replaced stays as it is, and so does the notice of another tab. */
  saved(tabId: string): void {
    const { shown } = this;
    if (shown?.tabId !== tabId) return;
    this.shown = null;
    if (this.store.get().banner === shown.banner) this.store.set({ banner: null });
  }
}
