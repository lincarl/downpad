// Desktop-only event lifecycle: filesystem notifications, second-launch file
// opens, Explorer drag/drop, and the window-close guard. All listener ownership
// stays in this service so AppRuntime can dispose the group as one unit.

import type { EditorHost } from "../editor/EditorHost";
import type { FileService } from "../files/FileService";
import { readFile } from "../ipc/commands";
import { onFileChanged, onOpenFileRequested, type FileChangedPayload } from "../ipc/events";
import { isTauri } from "../ipc/env";
import type { SnapshotScheduler } from "../recovery/snapshotScheduler";
import type { Store } from "../state/store";

export interface TauriEventDependencies {
  store: Store;
  files: FileService;
  editorHost: EditorHost;
  scheduler: SnapshotScheduler;
  run(action: () => Promise<unknown>): void;
  handleDrop(paths: string[]): Promise<void>;
}

export class TauriEventBindings {
  private pendingChangeMs = 0;
  private started = false;
  private disposed = false;
  private readonly cleanups: Array<() => void> = [];

  constructor(private readonly dependencies: TauriEventDependencies) {}

  start(): void {
    if (this.started || this.disposed || !isTauri()) return;
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
      run(() => files.openPath(path));
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
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    return getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type !== "drop") return;
      this.dependencies.run(() => this.dependencies.handleDrop(payload.paths));
    });
  }

  private async registerCloseGuard(): Promise<() => void> {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().onCloseRequested(async (event) => {
      const { editorHost, files, scheduler } = this.dependencies;
      editorHost.flush();
      if (files.anyDirty()) {
        const discard = await files.confirmDiscardAll();
        if (!discard) {
          event.preventDefault();
          return;
        }
      }
      await scheduler.clear();
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

/** Windows paths may arrive with either separator and casing. */
export function sameFilePath(left: string, right: string): boolean {
  const normalize = (path: string): string => path.replace(/\\/g, "/").toLowerCase();
  return normalize(left) === normalize(right);
}
