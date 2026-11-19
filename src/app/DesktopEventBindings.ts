// Desktop-only event lifecycle: filesystem notifications, second-launch file
// opens, Explorer drag/drop, Undo and Redo from native menus, and the
// window-close guard. All listener ownership stays in this service so
// AppRuntime can dispose the group as one unit.

import type { DropPoint, EditorHost } from "../editor/EditorHost";
import type { FileService } from "../files/FileService";
import { sameFilePath } from "../files/pathIdentity";
import { fileModifiedTime, readFile } from "../ipc/commands";
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
import type { SessionKeeper } from "./SessionKeeper";

export interface DesktopEventDependencies {
  store: Store;
  files: FileService;
  editorHost: EditorHost;
  scheduler: SnapshotScheduler;
  /** Records the open documents, which a close must wait for. */
  session: Pick<SessionKeeper, "flush">;
  run(action: () => Promise<unknown>): void;
  /** Open or embed dropped files. It reads where they go from `drop`, the
   *  drop event, before it first awaits. */
  handleDrop(paths: string[], drop: DropPoint): Promise<void>;
}

/** A change on disk that the user has not resolved with Reload or Keep mine:
 *  the file's path, its changed text and its mtime, and the document's mtime
 *  when the change was found. */
interface PendingChange {
  path: string;
  markdown: string;
  modifiedMs: number;
  seenModifiedMs: number;
}

export class DesktopEventBindings {
  /** Unresolved changes on disk by tab, which stay while another tab is in
   *  front. */
  private readonly pendingChanges = new Map<string, PendingChange>();
  /** The comparisons of a tab's document with its file under way, by tab.
   *  Automatic saves wait for them. */
  private readonly checks = new Map<string, number>();
  /** The comparisons started so far, and by tab the latest one whose read
   *  was used. Reads can finish out of order. */
  private comparisons = 0;
  private readonly lastUsed = new Map<string, number>();
  private started = false;
  private disposed = false;
  private closing = false;
  private readonly cleanups: Array<() => void> = [];

  constructor(private readonly dependencies: DesktopEventDependencies) {}

  start(): void {
    if (this.started || this.disposed || !isElectron()) return;
    this.started = true;

    this.captureCleanup(onFileChanged((payload) => void this.handleFileChanged(payload)));
    this.captureCleanup(
      onOpenFileRequested((path) =>
        this.dependencies.run(() => this.dependencies.files.openPath(path)),
      ),
    );
    this.captureCleanup(onHistoryRequested(undoOrRedo));
    this.captureCleanup(this.registerDragDrop());
    this.captureCleanup(this.registerCloseGuard());
    this.cleanups.push(this.followRecordedFile());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  /** After another document came to the front: show the bar again for its
   *  unresolved change on disk, and compare it with its file, which was not
   *  watched while another tab was in front. */
  activeDocChanged(): void {
    if (!this.started || this.disposed) return;
    this.showPendingChange();
    void this.compareWithDisk(null);
  }

  /** Whether a save the user did not ask for as such, such as autosave or the
   *  save before Copy file, must wait for the active document: while its file
   *  is being compared with it, or while a change on disk is unresolved, whose
   *  bar then shows again. */
  holdSave(): boolean {
    const tabId = this.dependencies.store.get().activeTabId;
    if (tabId && this.checks.has(tabId)) return true;
    return this.showPendingChange();
  }

  /** Show the bar for a change on disk that the user has not resolved with
   *  Reload or Keep mine, such as after they dismissed it, another notice
   *  replaced it or another tab was in front. Returns whether there is such
   *  a change. */
  showPendingChange(): boolean {
    if (!this.activeChange()) return false;
    this.showChangeBanner();
    return true;
  }

  /** The active document's unresolved change on disk. Save As gives the
   *  document another file, and a save with a later time than the change
   *  replaced it, as Keep mine treats one, so the change is forgotten then,
   *  and so are the changes of closed tabs. */
  private activeChange(): PendingChange | null {
    const { activeTabId, doc, tabs } = this.dependencies.store.get();
    for (const id of this.pendingChanges.keys()) {
      if (!tabs.some((tab) => tab.id === id)) this.pendingChanges.delete(id);
    }
    const change = activeTabId ? this.pendingChanges.get(activeTabId) : undefined;
    if (!activeTabId || !change) return null;
    const savedSince = doc.modifiedMs !== change.seenModifiedMs && doc.modifiedMs >= change.modifiedMs;
    if (!doc.filePath || !sameFilePath(change.path, doc.filePath) || savedSince) {
      this.pendingChanges.delete(activeTabId);
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

  /** When a save, Save As or Keep mine gives the active document another file
   *  or file time, check its unresolved change on disk again: a change that
   *  no longer applies goes, and otherwise the file's text tells whether the
   *  save replaced it. Returns the unsubscribe function. */
  private followRecordedFile(): () => void {
    const { store } = this.dependencies;
    let last = store.get();
    return store.subscribe((state) => {
      const before = last;
      last = state;
      if (state.activeTabId === null || state.activeTabId !== before.activeTabId) return;
      if (state.doc.filePath === before.doc.filePath && state.doc.modifiedMs === before.doc.modifiedMs) return;
      if (!this.pendingChanges.has(state.activeTabId)) return;
      if (!this.activeChange()) this.resolve(state.activeTabId);
      else void this.compareWithDisk(null);
    });
  }

  /** Apply the action exposed by React's external-change banner. */
  handleBannerAction(id: string): void {
    const { files, run, store } = this.dependencies;
    const { activeTabId, doc } = store.get();
    if (id === "reload" && doc.filePath) {
      // The reload takes the file as it is, whatever its time says.
      if (activeTabId) this.pendingChanges.delete(activeTabId);
      const path = doc.filePath;
      run(() => files.openPath(path, { reload: true }));
    } else if (id === "keep") {
      // The file holds the changed text, so the open text is unsaved unless it
      // matches it. A save since then is newer, and already recorded what the
      // file holds, so there is no change left to keep then.
      const change = this.activeChange();
      if (activeTabId) this.pendingChanges.delete(activeTabId);
      if (change) {
        store.patchDoc({
          modifiedMs: change.modifiedMs,
          savedMarkdown: change.markdown,
          isDirty: doc.markdown !== change.markdown,
        });
      }
      store.set({ banner: null });
    }
  }

  /** Distinguish a genuine external edit from our atomic save by comparing the
   *  on-disk text after validating the watcher path and mtime. */
  private async handleFileChanged(payload: FileChangedPayload): Promise<void> {
    if (this.disposed) return;
    const document = this.dependencies.store.get().doc;
    if (!document.filePath) return;
    if (!sameFilePath(payload.path, document.filePath)) return;
    // The file time the document recorded is the version it knows, such as
    // its own save. Any other time, also an older one, can be a change.
    if (payload.modifiedMs === document.modifiedMs) return;
    await this.compareWithDisk(payload.modifiedMs);
  }

  /** Read the active document's file, and offer to reload it when its text
   *  differs from what the document last read or wrote and from the open
   *  text. `reported` is the time the watcher saw. Without it, as when a tab
   *  comes to the front, the file's time alone tells first whether it can
   *  have changed. A recovered document has no file time or text of its own
   *  to compare with, so only the watcher reports its changes. */
  private async compareWithDisk(reported: number | null): Promise<void> {
    const { files, store } = this.dependencies;
    const { activeTabId: tabId, doc } = store.get();
    if (!tabId || !doc.filePath || (reported === null && doc.modifiedMs === 0)) return;
    const path = doc.filePath;
    const comparison = ++this.comparisons;
    this.checks.set(tabId, (this.checks.get(tabId) ?? 0) + 1);
    try {
      if (reported === null) {
        const time = await fileModifiedTime(path).catch(() => null);
        if (time === null || this.disposed) return;
        const pending = this.pendingChanges.get(tabId);
        if (pending ? time === pending.modifiedMs : time === store.get().doc.modifiedMs) return;
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
      // A later comparison already told what the file holds.
      if ((this.lastUsed.get(tabId) ?? 0) > comparison) return;
      this.lastUsed.set(tabId, comparison);
      const current = state.doc;
      if (files.isOwnWrite(tabId, onDisk.content)) return;
      if (onDisk.content === current.savedMarkdown || onDisk.content === current.markdown) {
        // The file holds what the document last read or wrote, whatever its
        // time says, or the open text, so nothing is left to reload or keep.
        this.resolve(tabId);
        store.patchDoc({ modifiedMs: onDisk.modifiedMs, savedMarkdown: onDisk.content, isDirty: current.markdown !== onDisk.content });
        return;
      }

      this.pendingChanges.set(tabId, {
        path,
        markdown: onDisk.content,
        modifiedMs: onDisk.modifiedMs,
        seenModifiedMs: current.modifiedMs,
      });
      this.showChangeBanner();
    } finally {
      const left = (this.checks.get(tabId) ?? 1) - 1;
      if (left > 0) this.checks.set(tabId, left);
      else this.checks.delete(tabId);
    }
  }

  /** The bar that asks whether to reload a file that changed on disk. */
  private showChangeBanner(): void {
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
        this.dependencies.run(() => this.dependencies.handleDrop(paths, event));
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
    return onCloseRequested(() => this.dependencies.run(() => this.handleCloseRequested()));
  }

  private async handleCloseRequested(): Promise<void> {
    if (this.disposed || this.closing) return;
    this.closing = true;
    let accepted = false;
    try {
      const { editorHost, files, scheduler, session } = this.dependencies;
      editorHost.flush();
      const decision = await files.confirmCloseAll();
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
        await desktopBridge().closeWindow();
      }
    } finally {
      try {
        // Clear the main process's quit intent when this close was declined.
        if (!accepted && !this.disposed) await desktopBridge().cancelWindowClose();
      } finally {
        this.closing = false;
      }
    }
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

