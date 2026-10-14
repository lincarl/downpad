// Desktop-only event lifecycle: filesystem notifications, second-launch file
// opens, Explorer drag/drop, and the window-close guard. All listener ownership
// stays in this service so AppRuntime can dispose the group as one unit.

import type { EditorHost } from "../editor/EditorHost";
import type { FileService } from "../files/FileService";
import { sameFilePath } from "../files/pathIdentity";
import { readFile } from "../ipc/commands";
import { onCloseRequested, onFileChanged, onOpenFileRequested, type FileChangedPayload } from "../ipc/events";
import { desktopBridge } from "../ipc/bridge";
import { isElectron } from "../ipc/env";
import type { SnapshotScheduler } from "../recovery/snapshotScheduler";
import type { Store } from "../state/store";

export interface DesktopEventDependencies {
  store: Store;
  files: FileService;
  editorHost: EditorHost;
  scheduler: SnapshotScheduler;
  run(action: () => Promise<unknown>): void;
  handleDrop(paths: string[]): Promise<void>;
}

export class DesktopEventBindings {
  private pendingChangeMs = 0;
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
    this.captureCleanup(this.registerDragDrop());
    this.captureCleanup(this.registerCloseGuard());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  /** Clear watcher state after the active document changes. */
  resetPendingChange(): void {
    this.pendingChangeMs = 0;
  }

  /** Apply the action exposed by React's external-change banner. */
  handleBannerAction(id: string): void {
    const { files, run, store } = this.dependencies;
    const path = store.get().doc.filePath;
    if (id === "reload" && path) {
      run(() => files.openPath(path, { reload: true }));
    } else if (id === "keep") {
      store.patchDoc({ modifiedMs: this.pendingChangeMs });
      store.set({ banner: null });
    }
  }

  /** Distinguish a genuine external edit from our atomic save by comparing the
   *  on-disk text after validating the watcher path and mtime. */
  private async handleFileChanged(payload: FileChangedPayload): Promise<void> {
    if (this.disposed) return;
    const { store } = this.dependencies;
    const document = store.get().doc;
    if (!document.filePath) return;
    if (!sameFilePath(payload.path, document.filePath)) return;
    if (payload.modifiedMs <= document.modifiedMs) return;

    let onDisk: string;
    try {
      onDisk = (await readFile(document.filePath)).content;
    } catch {
      // Files can briefly be unreadable while another process is replacing them.
      return;
    }
    if (this.disposed) return;

    // The read crossed an async boundary; validate against current state again.
    const current = store.get().doc;
    if (!current.filePath || !sameFilePath(payload.path, current.filePath)) return;
    if (payload.modifiedMs <= current.modifiedMs) return;
    if (onDisk === current.markdown) {
      store.patchDoc({ modifiedMs: payload.modifiedMs });
      return;
    }

    this.pendingChangeMs = payload.modifiedMs;
    store.set({
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
        this.dependencies.run(() => this.dependencies.handleDrop(paths));
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
      const { editorHost, files, scheduler } = this.dependencies;
      editorHost.flush();
      if (files.anyDirty()) {
        const discard = await files.confirmDiscardAll();
        if (!discard || this.disposed) return;
      }
      await scheduler.clear();
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

