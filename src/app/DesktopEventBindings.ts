// Desktop-only event lifecycle: filesystem notifications, second-launch file
// opens, Explorer drag/drop, Undo and Redo from native menus, and the
// window-close guard. All listener ownership stays in this service so
// AppRuntime can dispose the group as one unit.

import type { DropPoint, EditorHost } from "../editor/EditorHost";
import type { FileService } from "../files/FileService";
import { sameFilePath } from "../files/pathIdentity";
import { readFile } from "../ipc/commands";
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
 *  the file's path, its changed text and its mtime. */
interface PendingChange {
  path: string;
  markdown: string;
  modifiedMs: number;
}

export class DesktopEventBindings {
  /** Unresolved changes on disk by tab, which stay while another tab is in
   *  front. */
  private readonly pendingChanges = new Map<string, PendingChange>();
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
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  /** After another document came to the front: show the bar again for its
   *  unresolved change on disk, or else compare it with its file, which was
   *  not watched while another tab was in front. */
  activeDocChanged(): void {
    if (!this.started || this.disposed) return;
    if (!this.showPendingChange()) void this.compareWithDisk(null);
  }

  /** Whether the active document has a change on disk that the user has not
   *  resolved with Reload or Keep mine. */
  hasPendingChange(): boolean {
    return this.activeChange() !== null;
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

  /** The active document's unresolved change on disk. A save since the
   *  change replaced it, as Keep mine treats a newer save, and Save As gives
   *  the document another file, so the change is forgotten then, and so are
   *  the changes of closed tabs. */
  private activeChange(): PendingChange | null {
    const { activeTabId, doc, tabs } = this.dependencies.store.get();
    for (const id of this.pendingChanges.keys()) {
      if (!tabs.some((tab) => tab.id === id)) this.pendingChanges.delete(id);
    }
    const change = activeTabId ? this.pendingChanges.get(activeTabId) : undefined;
    if (!activeTabId || !change) return null;
    if (!doc.filePath || !sameFilePath(change.path, doc.filePath) || change.modifiedMs <= doc.modifiedMs) {
      this.pendingChanges.delete(activeTabId);
      return null;
    }
    return change;
  }

  /** Apply the action exposed by React's external-change banner. */
  handleBannerAction(id: string): void {
    const { files, run, store } = this.dependencies;
    const path = store.get().doc.filePath;
    if (id === "reload" && path) {
      run(() => files.openPath(path, { reload: true }));
    } else if (id === "keep") {
      // The file holds the changed text, so the open text is unsaved unless it
      // matches it. A Save or a later change on disk since then is newer, and
      // already recorded what the file holds.
      const change = this.activeChange();
      const activeTabId = store.get().activeTabId;
      if (activeTabId) this.pendingChanges.delete(activeTabId);
      if (change && change.modifiedMs > store.get().doc.modifiedMs) {
        store.patchDoc({
          modifiedMs: change.modifiedMs,
          savedMarkdown: change.markdown,
          isDirty: store.get().doc.markdown !== change.markdown,
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
    if (payload.modifiedMs <= document.modifiedMs) return;
    await this.compareWithDisk(payload.modifiedMs);
  }

  /** Read the active document's file, and offer to reload it when it changed
   *  since the document last recorded it, at `reported` as the watcher saw
   *  it, or else at the time the read gives. A recovered document has no time
   *  of its own to compare with, so only the watcher reports its changes. */
  private async compareWithDisk(reported: number | null): Promise<void> {
    const { store } = this.dependencies;
    const document = store.get().doc;
    if (!document.filePath || (reported === null && document.modifiedMs === 0)) return;
    const path = document.filePath;

    let onDisk: FilePayload;
    try {
      onDisk = await readFile(path);
    } catch {
      // Files can briefly be unreadable while another process is replacing them.
      return;
    }
    if (this.disposed) return;

    // The read crossed an async boundary; validate against current state again.
    const { activeTabId, doc: current } = store.get();
    if (!activeTabId || !current.filePath || !sameFilePath(path, current.filePath)) return;
    const modifiedMs = reported ?? onDisk.modifiedMs;
    if (modifiedMs <= current.modifiedMs) return;
    // Reads can finish out of order. A newer change read while this one waited
    // is what the file holds now.
    const pending = this.pendingChanges.get(activeTabId);
    if (pending && pending.modifiedMs >= modifiedMs) return;
    if (onDisk.content === current.markdown) {
      // The file holds the open text, so an earlier change has nothing left to
      // reload or keep.
      store.patchDoc({ modifiedMs, savedMarkdown: onDisk.content, isDirty: false });
      this.pendingChanges.delete(activeTabId);
      if (store.get().banner?.kind === "file-changed") store.set({ banner: null });
      return;
    }

    this.pendingChanges.set(activeTabId, { path: current.filePath, markdown: onDisk.content, modifiedMs });
    this.showChangeBanner();
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

