// Desktop-only event lifecycle: filesystem notifications, second-launch file
// opens, Explorer drag/drop, Undo and Redo from native menus, and the
// window-close guard. All listener ownership stays in this service so
// AppRuntime can dispose the group as one unit.

import type { DropPoint, EditorHost } from "../editor/EditorHost";
import type { FileService } from "../files/FileService";
import { sameFilePath } from "../files/pathIdentity";
import { fileStamp, readFile } from "../ipc/commands";
import type { FilePayload } from "../ipc/contracts";
import {
  onCloseRequested,
  onFileChanged,
  onHistoryRequested,
  onOpenFileRequested,
  type FileChangedPayload,
} from "../ipc/events";
import { desktopBridge } from "../ipc/bridge";
import { isElectron } from "../ipc/env";
import { undoOrRedo } from "../shell/editorActions";
import type { SnapshotScheduler } from "../recovery/snapshotScheduler";
import type { Store } from "../state/store";
import { isRecoveredDocument, type DocumentState } from "../state/types";
import type { SessionKeeper } from "./SessionKeeper";
import { CloseRequests } from "./closeRequests";

export interface DesktopEventDependencies {
  store: Store;
  files: FileService;
  editorHost: EditorHost;
  scheduler: SnapshotScheduler;
  /** Records the open documents, which a close must wait for. */
  session: Pick<SessionKeeper, "flush">;
  /** Run a file action, and show `failure` with the reason when it fails. */
  run(action: () => Promise<unknown>, failure?: string): void;
  /** Open or embed dropped files. It reads where they go from `drop`, the
   *  drop event, before it first awaits. */
  handleDrop(paths: string[], drop: DropPoint): Promise<void>;
}

/** A change on disk that the user has not resolved with Reload or Keep mine:
 *  the file's path, its changed text, mtime and size, and the document's
 *  mtime when the change was found. */
interface PendingChange {
  path: string;
  markdown: string;
  modifiedMs: number;
  sizeBytes: number;
  seenModifiedMs: number;
}

export class DesktopEventBindings {
  /** Unresolved changes on disk by tab, which stay while another tab is in
   *  front. */
  private readonly pendingChanges = new Map<string, PendingChange>();
  /** The comparisons of a tab's document with its file under way, by tab.
   *  Automatic saves wait for them. */
  private readonly checks = new Map<string, number>();
  /** Callers waiting for a tab's comparisons to end, by tab. */
  private readonly settledWaiters = new Map<string, Array<() => void>>();
  /** The comparisons started so far, and by tab the latest one whose read
   *  was used. Reads can finish out of order. */
  private comparisons = 0;
  private readonly lastUsed = new Map<string, number>();
  /** By tab, how often a save, reload or Keep mine recorded another version
   *  of its file. A read started before such a record is out of date. */
  private readonly revisions = new Map<string, number>();
  /** Set while this class records a file version itself, which makes no read
   *  out of date. */
  private recording = false;
  /** The tabs whose file is known to be gone (`fileGone`). */
  private readonly gone = new Set<string>();
  private started = false;
  private disposed = false;
  /** Closes of the window, one at a time (`CloseRequests`). */
  private readonly closeRequests = new CloseRequests();
  /** Set once this window's close was approved, so a close asked for after it
   *  does nothing. */
  private closeApproved = false;
  private readonly cleanups: Array<() => void> = [];

  constructor(private readonly dependencies: DesktopEventDependencies) {}

  start(): void {
    if (this.started || this.disposed || !isElectron()) return;
    this.started = true;

    this.captureCleanup(onFileChanged((payload) => void this.handleFileChanged(payload)));
    this.captureCleanup(
      onOpenFileRequested((path) =>
        this.dependencies.run(() => this.dependencies.files.openPath(path), "Downpad could not open the file."),
      ),
    );
    this.captureCleanup(onHistoryRequested(undoOrRedo));
    this.captureCleanup(this.registerDragDrop());
    this.captureCleanup(this.registerCloseGuard());
    this.cleanups.push(this.followActiveDocument());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    for (const waiters of this.settledWaiters.values()) for (const resolve of waiters) resolve();
    this.settledWaiters.clear();
  }

  /** After another document came to the front, or the document in front was
   *  shown again, as after a reload: show the bar again for its unresolved
   *  change on disk, and compare it with its file, which was not watched
   *  while another tab was in front, unless that comparison runs already. */
  activeDocChanged(): void {
    if (!this.started || this.disposed) return;
    this.showPendingChange();
    const tabId = this.dependencies.store.get().activeTabId;
    if (tabId && !this.checks.has(tabId)) void this.compareWithDisk(false);
  }

  /** Read the active document's file now and compare it, as when a save that
   *  only writes over the version the document recorded was refused. Resolves
   *  once no comparison of the tab runs, also one that a read found out of
   *  date started again. */
  async recheck(): Promise<void> {
    if (!this.started || this.disposed) return;
    const tabId = this.dependencies.store.get().activeTabId;
    await this.compareWithDisk(true);
    if (tabId) await this.settled(tabId);
  }

  /** The file of the tab's document is gone and stays gone, as when Git got
   *  a latest version without it. An unresolved change on disk of the
   *  document is about a file that is no longer there, so it is forgotten and
   *  its bar goes, and a comparison under way that read the file before it
   *  went counts as out of date, so it shows no bar either. */
  fileGone(tabId: string): void {
    this.revisions.set(tabId, (this.revisions.get(tabId) ?? 0) + 1);
    this.resolve(tabId);
    this.gone.add(tabId);
  }

  /** Whether the file of the tab's document is known to be gone: `fileGone`
   *  said so, and since then no save, Save As or reload recorded a file for
   *  the document, and no read of the file that was begun after it found one.
   *  The file is read on each report of the watcher and each time the tab
   *  comes to the front.
   *  Copy file is not offered meanwhile, since it has no file to copy and its
   *  save writes only over a version the document recorded. */
  isFileGone(tabId: string): boolean {
    const { tabs } = this.dependencies.store.get();
    for (const id of this.gone) {
      if (!tabs.some((tab) => tab.id === id)) this.gone.delete(id);
    }
    return this.gone.has(tabId);
  }

  /** As holdSave, once the comparisons of the tab that run have ended. */
  async holdSaveAfterChecks(tabId: string): Promise<boolean> {
    await this.settled(tabId);
    return this.holdSave(tabId);
  }

  /** Whether a save nobody asked for as such, such as autosave or the save
   *  before Copy file, must wait for the document of `tabId`, by default the
   *  active one: while its file is being compared with it, or while a change
   *  on disk is unresolved, whose bar then shows again if it is in front. */
  holdSave(tabId: string | null = this.dependencies.store.get().activeTabId): boolean {
    if (!tabId) return false;
    if (this.checks.has(tabId)) return true;
    if (!this.changeOf(tabId)) return false;
    if (tabId === this.dependencies.store.get().activeTabId) this.showChangeBanner();
    return true;
  }

  /** Resolve once no comparison of the tab's document with its file runs. */
  settled(tabId: string): Promise<void> {
    if (!this.checks.has(tabId) || this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      this.settledWaiters.set(tabId, [...(this.settledWaiters.get(tabId) ?? []), resolve]);
    });
  }

  /** Show the bar for a change on disk that the user has not resolved with
   *  Reload or Keep mine, such as after they dismissed it, another notice
   *  replaced it or another tab was in front. Returns whether there is such
   *  a change. */
  showPendingChange(): boolean {
    const tabId = this.dependencies.store.get().activeTabId;
    if (!tabId || !this.changeOf(tabId)) return false;
    this.showChangeBanner();
    return true;
  }

  /** The unresolved change on disk of the tab's document. Save As gives the
   *  document another file, a save or reload that recorded a file time at
   *  least as late as the change's replaced it, as Keep mine treats one, and
   *  a reload that recorded the changed text took it, also one with the same
   *  time, so the change is forgotten then, and so are the changes of closed
   *  tabs. */
  private changeOf(tabId: string): PendingChange | null {
    const { tabs } = this.dependencies.store.get();
    for (const id of this.pendingChanges.keys()) {
      if (!tabs.some((tab) => tab.id === id)) this.pendingChanges.delete(id);
    }
    const change = this.pendingChanges.get(tabId);
    const doc = tabs.find((tab) => tab.id === tabId)?.doc;
    if (!change || !doc) return null;
    const recordedSince = doc.modifiedMs !== change.seenModifiedMs && doc.modifiedMs >= change.modifiedMs;
    if (!doc.filePath || !sameFilePath(change.path, doc.filePath) || recordedSince || doc.savedMarkdown === change.markdown) {
      this.pendingChanges.delete(tabId);
      return null;
    }
    return change;
  }

  /** Forget the tab's change on disk and take its bar down. */
  private resolve(tabId: string): void {
    this.pendingChanges.delete(tabId);
    const { activeTabId, banner } = this.dependencies.store.get();
    if (activeTabId === tabId && banner?.kind === "file-changed") this.dependencies.store.set({ banner: null });
  }

  /** Compare a tab with its file as soon as it comes to the front, before its
   *  editor shows, so automatic saves wait from then on. When a save, Save As,
   *  Keep mine or a reload gives the document in front another file or file
   *  time, check its unresolved change on disk again: a change that no longer
   *  applies goes, and otherwise the file's text tells whether it was
   *  replaced. Returns the unsubscribe function. */
  private followActiveDocument(): () => void {
    const { store } = this.dependencies;
    let last = store.get();
    return store.subscribe((state) => {
      const before = last;
      last = state;
      // Every tab's records count, also those of a tab in back, such as a
      // save that ends after the user switched tabs.
      if (state.tabs !== before.tabs) {
        const earlier = new Map(before.tabs.map((tab) => [tab.id, tab.doc]));
        for (const tab of state.tabs) {
          const previous = earlier.get(tab.id);
          if (!previous || previous === tab.doc || !recordsVersion(previous, tab.doc)) continue;
          // A version that is recorded is of a file that is there.
          this.gone.delete(tab.id);
          if (!this.recording) this.revisions.set(tab.id, (this.revisions.get(tab.id) ?? 0) + 1);
        }
      }
      const tabId = state.activeTabId;
      if (tabId === null) return;
      if (tabId !== before.activeTabId) {
        void this.compareWithDisk(false);
        return;
      }
      if (!recordsVersion(before.doc, state.doc)) return;
      if (!this.pendingChanges.has(tabId)) return;
      if (!this.changeOf(tabId)) this.resolve(tabId);
      else void this.compareWithDisk(false);
    });
  }

  /** Apply the action exposed by React's external-change banner. */
  handleBannerAction(id: string): void {
    const { files, run, store } = this.dependencies;
    const { activeTabId, doc } = store.get();
    if (id === "reload" && doc.filePath) {
      // The change stays until the reload records the file, so a reload the
      // user cancels or that fails keeps automatic saves waiting.
      const path = doc.filePath;
      run(() => files.openPath(path, { reload: true }), "Downpad could not reload the file.");
    } else if (id === "keep") {
      // The file holds the changed text, so the open text is unsaved unless it
      // matches it. A save since then is newer, and already recorded what the
      // file holds, so there is no change left to keep then.
      const change = activeTabId ? this.changeOf(activeTabId) : null;
      if (activeTabId) this.pendingChanges.delete(activeTabId);
      if (change) {
        // A record of the file's version, which makes reads started before
        // it out of date.
        store.patchDoc({
          modifiedMs: change.modifiedMs,
          fileSize: change.sizeBytes,
          savedMarkdown: change.markdown,
          isDirty: doc.markdown !== change.markdown,
        });
      }
      store.set({ banner: null });
    }
  }

  /** Distinguish a genuine external edit from our atomic save by comparing the
   *  on-disk text. A program can replace a file and keep its time, so every
   *  report of the file in front is compared, also one with the time the
   *  document recorded, such as for its own save. */
  private async handleFileChanged(payload: FileChangedPayload): Promise<void> {
    if (this.disposed) return;
    const document = this.dependencies.store.get().doc;
    if (!document.filePath) return;
    if (!sameFilePath(payload.path, document.filePath)) return;
    await this.compareWithDisk(true);
  }

  /** Read the active document's file, and offer to reload it when its text
   *  differs from what the document last read or wrote and from the open
   *  text. Without `read`, as when a tab comes to the front, the file's time
   *  and size tell first whether it can have changed. A tab with an
   *  unresolved change is always read, since another program can replace the
   *  file again, or put its earlier text back, with the time and size of the
   *  change, and so is one whose file was gone, since only a read tells that
   *  the file is back, also with the time and size the document recorded. A
   *  recovered document has no file version of its own to compare with, so
   *  only a report of the watcher, a refused save, an unresolved change or a
   *  file that was gone makes it read. */
  private async compareWithDisk(read: boolean): Promise<void> {
    const { files, store } = this.dependencies;
    const { activeTabId: tabId, doc } = store.get();
    if (!tabId || !doc.filePath) return;
    const reads = read || this.pendingChanges.has(tabId) || this.gone.has(tabId);
    if (!reads && isRecoveredDocument(doc)) return;
    const path = doc.filePath;
    // A save, reload or Keep mine that records another file version
    // meanwhile makes this read out of date, and the app compares again then.
    const revision = this.revisions.get(tabId) ?? 0;
    let outOfDate = false;
    const comparison = ++this.comparisons;
    this.checks.set(tabId, (this.checks.get(tabId) ?? 0) + 1);
    try {
      if (!reads) {
        const stamp = await fileStamp(path).catch(() => null);
        if (stamp === null || this.disposed) return;
        if (stamp.modifiedMs === doc.modifiedMs && (doc.fileSize === undefined || stamp.sizeBytes === doc.fileSize)) return;
      }

      let onDisk: FilePayload;
      try {
        onDisk = await readFile(path);
      } catch {
        // Files can briefly be unreadable while another process is replacing them.
        return;
      }
      if (this.disposed) return;

      // The read crossed an async boundary; validate against current state again.
      const state = store.get();
      if (state.activeTabId !== tabId || !state.doc.filePath || !sameFilePath(path, state.doc.filePath)) return;
      if ((this.revisions.get(tabId) ?? 0) !== revision) {
        outOfDate = true;
        return;
      }
      // A later comparison already told what the file holds.
      if ((this.lastUsed.get(tabId) ?? 0) > comparison) return;
      this.lastUsed.set(tabId, comparison);
      // The file is there again, as when another program put it back.
      this.gone.delete(tabId);
      const current = state.doc;
      if (files.isOwnWrite(tabId, onDisk.content)) return;
      if (onDisk.content === current.savedMarkdown || onDisk.content === current.markdown) {
        // The file holds what the document last read or wrote, whatever its
        // time says, or the open text, so nothing is left to reload or keep.
        this.resolve(tabId);
        const patch: Partial<DocumentState> = {};
        if (current.modifiedMs !== onDisk.modifiedMs) patch.modifiedMs = onDisk.modifiedMs;
        if (current.fileSize !== onDisk.sizeBytes) patch.fileSize = onDisk.sizeBytes;
        if (current.savedMarkdown !== onDisk.content) {
          patch.savedMarkdown = onDisk.content;
          patch.isDirty = current.markdown !== onDisk.content;
        }
        // The file holds a version the document knows, so reads that run
        // stay up to date.
        this.recording = true;
        try {
          if (Object.keys(patch).length > 0) store.patchDoc(patch);
        } finally {
          this.recording = false;
        }
        return;
      }

      this.pendingChanges.set(tabId, {
        path,
        markdown: onDisk.content,
        modifiedMs: onDisk.modifiedMs,
        sizeBytes: onDisk.sizeBytes,
        seenModifiedMs: current.modifiedMs,
      });
      this.showChangeBanner();
    } finally {
      // The file may hold a change that the out-of-date read found, so read
      // it again against the version recorded now. That read starts before
      // this one ends, so callers waiting for the tab wait for it too.
      if (outOfDate && !this.disposed && store.get().activeTabId === tabId) void this.compareWithDisk(true);
      const left = (this.checks.get(tabId) ?? 1) - 1;
      if (left > 0) this.checks.set(tabId, left);
      else {
        this.checks.delete(tabId);
        for (const resolve of this.settledWaiters.get(tabId) ?? []) resolve();
        this.settledWaiters.delete(tabId);
      }
    }
  }

  /** The bar that asks whether to reload a file that changed on disk. It
   *  waits while the Recent view is in front, where the document does not
   *  show, and comes when the document does (`activeDocChanged`). */
  private showChangeBanner(): void {
    if (this.dependencies.store.get().view === "recent") return;
    this.dependencies.store.set({
      banner: {
        kind: "file-changed",
        message: "This file changed on disk.",
        actions: [
          { id: "reload", label: "Reload" },
          { id: "keep", label: "Keep mine" },
        ],
      },
    });
  }

  private async registerDragDrop(): Promise<() => void> {
    const hasFiles = (event: DragEvent): boolean =>
      event.dataTransfer?.types.includes("Files") ?? false;
    const dragOver = (event: DragEvent): void => {
      if (hasFiles(event)) event.preventDefault();
    };
    const drop = (event: DragEvent): void => {
      if (!event.dataTransfer || !hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const bridge = desktopBridge();
      const paths = Array.from(event.dataTransfer.files)
        .map((file) => bridge.getPathForFile(file))
        .filter((path) => path.length > 0);
      if (paths.length > 0) {
        this.dependencies.run(() => this.dependencies.handleDrop(paths, event), "Downpad could not take the dropped files.");
      }
    };
    // Capture native file drops before editor plugins upload or navigate them.
    document.addEventListener("dragover", dragOver, true);
    document.addEventListener("drop", drop, true);
    return () => {
      document.removeEventListener("dragover", dragOver, true);
      document.removeEventListener("drop", drop, true);
    };
  }

  private async registerCloseGuard(): Promise<() => void> {
    return onCloseRequested(() => this.dependencies.run(() => this.handleCloseRequested(), "Downpad could not close."));
  }

  /** Ask about unsaved documents and close the window. A close of the window
   *  asked for again while this one waits for a save takes over: this one
   *  keeps the window and leaves the quit intent to the newer one, which asks
   *  again, so Discard closes the window even when a save never returns. */
  private handleCloseRequested(): Promise<void> {
    return this.closeRequests.run(async (signal) => {
      if (this.disposed || this.closeApproved) return;
      let accepted = false;
      try {
        const { editorHost, files, scheduler, session } = this.dependencies;
        editorHost.flush();
        const decision = await files.confirmCloseAll(signal);
        if (decision === "cancel" || this.disposed) return;
        await scheduler.clear();
        // The next start reopens the documents open now, also one that Save
        // just gave a file.
        await session.flush();
        // Recovery cleanup and the session record await disk I/O. Typing, a
        // queued save or a dropped file that arrived meanwhile must keep a Save
        // close from losing work.
        if (!this.disposed && decision !== "discard" && !files.canCloseTabs()) {
          scheduler.start();
          return;
        }
        if (!this.disposed) {
          accepted = true;
          this.closeApproved = true;
          await desktopBridge().closeWindow().catch((error: unknown) => {
            this.closeApproved = false;
            throw error;
          });
        }
      } finally {
        // Clear the main process's quit intent when this close was declined,
        // unless a newer close took over, which then decides.
        if (!accepted && !this.disposed && !signal.aborted) await desktopBridge().cancelWindowClose();
      }
    });
  }

  private captureCleanup(promise: Promise<() => void>): void {
    void promise
      .then((cleanup) => {
        if (this.disposed) cleanup();
        else this.cleanups.push(cleanup);
      })
      .catch(() => {});
  }
}

/** Whether `next` records another version of the document's file than
 *  `previous`: another file, file time, or saved text, as a save, a reload or
 *  Keep mine records. A save under way, which makes the saved text unknown,
 *  records nothing yet. */
function recordsVersion(previous: DocumentState, next: DocumentState): boolean {
  return next.filePath !== previous.filePath || next.modifiedMs !== previous.modifiedMs
    || (next.savedMarkdown !== previous.savedMarkdown && next.savedMarkdown !== null);
}
