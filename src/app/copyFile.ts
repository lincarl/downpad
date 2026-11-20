// Copy file in the document's right-click menu (spec, Core experience; design,
// Desktop integration). It saves what the active document shows through the
// guarded automatic save, which writes only over the version the document
// recorded, and then puts the document's file on the clipboard.

import type { EditorHost } from "../editor/EditorHost";
import type { FileService } from "../files/FileService";
import { copyFileToClipboard } from "../ipc/commands";
import type { Store } from "../state/store";
import type { DesktopEventBindings } from "./DesktopEventBindings";

export interface CopyFileDependencies {
  store: Store;
  files: Pick<FileService, "save">;
  editorHost: Pick<EditorHost, "flush">;
  desktopEvents: Pick<DesktopEventBindings, "settled" | "showPendingChange" | "holdSaveAfterChecks" | "recheck">;
  /** Whether Copy file can run now, as the menu asks. */
  canCopyFile(): boolean;
  isDisposed(): boolean;
}

/** Put the active document's file on the clipboard, as the file manager
 *  copies it, to paste into a folder or as an attachment. Unsaved changes are
 *  saved first, and an untitled document asks where to save it, so the file
 *  holds what the editor shows. Cancelling that Save As copies nothing. A
 *  recovered document, whose file may have changed while Downpad was closed,
 *  asks the user to save it first, and a change on disk that is not resolved
 *  shows its notice instead. Failures show as an error notice. */
export async function copyActiveFile(dependencies: CopyFileDependencies): Promise<void> {
  const { store, files, editorHost, desktopEvents, canCopyFile, isDisposed } = dependencies;
  // The menu can stay open while the file changes on disk.
  if (!canCopyFile()) return;
  const tabId = store.get().activeTabId;
  if (!tabId) return;
  /** Whether Copy file still acts on the tab it started for. */
  const stillInFront = (): boolean => !isDisposed() && store.get().activeTabId === tabId;
  // A comparison of the document with its file that runs, as after a switch
  // of tabs, tells first whether the file changed.
  await desktopEvents.settled(tabId);
  if (!stillInFront() || !canCopyFile()) return;
  // A change on disk whose bar was dismissed or replaced is still unresolved,
  // so the bar asks again and nothing is saved or copied.
  if (desktopEvents.showPendingChange()) return;
  editorHost.flush();
  const doc = store.get().tabs.find((tab) => tab.id === tabId)?.doc;
  if (!doc) return;
  try {
    // A recovered document has no file time or saved text of its own until
    // it is saved, and its file may have changed while Downpad was closed,
    // which nothing tells, so only a save the user asks for writes it. A
    // document whose save is being written has no saved text either, but has
    // a file time, and so has a file that says it was written in 1970.
    if (doc.filePath && doc.modifiedMs === 0 && doc.savedMarkdown === null) {
      store.set({ banner: { kind: "info", message: "Save this recovered document first. Its file may have changed while Downpad was closed." } });
      return;
    }
    // A change on disk found while the save waited in the queue stops it
    // too, and so does one the app has not seen yet.
    const saved = !doc.isDirty && doc.filePath
      ? true
      : await files.save({ automatic: (id) => desktopEvents.holdSaveAfterChecks(id) });
    if (!saved) {
      // An untitled document whose Save As the user cancelled copies nothing,
      // and a document no longer in front tells its change when it comes back.
      if (!doc.filePath || !stillInFront()) return;
      // The file changed on disk, which the bar then asks about.
      await desktopEvents.recheck();
      if (!stillInFront() || desktopEvents.showPendingChange()) return;
      store.set({ banner: { kind: "error", message: "Could not save the file before copying it. Please try again." } });
      return;
    }
    const path = store.get().tabs.find((tab) => tab.id === tabId)?.doc.filePath;
    if (path) await copyFileToClipboard(path);
  } catch (error) {
    console.error("Downpad: copying the file failed", error);
    if (!isDisposed()) store.set({ banner: { kind: "error", message: "Could not copy the file. Please try again." } });
  }
}
