// Copy file in the document's right-click menu (spec, Core experience; design,
// Desktop integration). It saves what the active document shows through the
// guarded automatic save, which writes only over the version the document
// recorded, and then puts the document's file on the clipboard.

import type { EditorHost } from "../editor/EditorHost";
import type { FileService } from "../files/FileService";
import { copyFileToClipboard } from "../ipc/commands";
import type { Store } from "../state/store";
import { isRecoveredDocument } from "../state/types";
import type { DesktopEventBindings } from "./DesktopEventBindings";

export interface CopyFileDependencies {
  store: Store;
  files: Pick<FileService, "save" | "untilSaved" | "isSaving">;
  editorHost: Pick<EditorHost, "flush">;
  desktopEvents: Pick<DesktopEventBindings, "settled" | "showPendingChange" | "holdSaveAfterChecks" | "recheck">;
  /** Whether Copy file can run now, as the menu asks. */
  canCopyFile(): boolean;
  isDisposed(): boolean;
}

/** Put the active document's file on the clipboard, as the file manager
 *  copies it, to paste into a folder or as an attachment. Unsaved changes are
 *  saved first, and an untitled document asks where to save it, so the file
 *  holds what the editor shows. Cancelling that Save As copies nothing. Copy
 *  file first waits for a save of the tab under way, and does nothing when a
 *  Save As among them failed or was cancelled. A recovered document
 *  that no save has recorded, whose file may have changed while Downpad was
 *  closed, asks the user to save it first, and a change on disk that is not
 *  resolved shows its notice instead. Failures show as an error notice. */
export async function copyActiveFile(dependencies: CopyFileDependencies): Promise<void> {
  const { store, files, editorHost, desktopEvents, canCopyFile, isDisposed } = dependencies;
  // The menu can stay open while the file changes on disk.
  if (!canCopyFile()) return;
  const tabId = store.get().activeTabId;
  if (!tabId) return;
  /** Whether Copy file still acts on the tab it started for. */
  const stillInFront = (): boolean => !isDisposed() && store.get().activeTabId === tabId;
  // A save of the tab under way records its file first, so a recovered
  // document that the user is saving counts as saved. A comparison of the
  // document with its file that runs, as after a switch of tabs, then tells
  // whether the file changed. Each can start while Copy file waits for the
  // other, so it waits until neither runs.
  do {
    // After a Save As that failed, the document still has the file the user
    // was leaving, which Copy file's own save must not write then. The
    // failed save has told the user.
    if (!(await files.untilSaved(tabId))) return;
    await desktopEvents.settled(tabId);
  } while (files.isSaving(tabId));
  if (!stillInFront() || !canCopyFile()) return;
  // A change on disk whose bar was dismissed or replaced is still unresolved,
  // so the bar asks again and nothing is saved or copied.
  if (desktopEvents.showPendingChange()) return;
  editorHost.flush();
  const doc = store.get().tabs.find((tab) => tab.id === tabId)?.doc;
  if (!doc) return;
  try {
    // The file of a recovered document may have changed while Downpad was
    // closed, which nothing tells, so only a save the user asks for writes it.
    if (isRecoveredDocument(doc)) {
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
