// Autosave + crash-recovery snapshots (spec §5.11). Two timers:
//   - recovery snapshots are ALWAYS on: every recoverySnapshotIntervalSeconds,
//     write each dirty tab's buffer to disk, including background tabs. Delete
//     its snapshot once saved or closed, and clear all on an accepted shutdown.
//   - autosave-to-file is opt-in: every autosaveIntervalSeconds, if enabled and
//     the doc has a path and is dirty, save it.
// No-op outside Electron.

import type { Store } from "../state/store";
import type { FileService } from "../files/FileService";
import { writeSnapshot, deleteSnapshot } from "../ipc/commands";
import { isElectron } from "../ipc/env";

export class SnapshotScheduler {
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly snapshotIds = new Set<string>();
  private readonly pending = new Map<string, Promise<void>>();
  private clearing: Promise<void> | null = null;
  private stopVersion = 0;

  constructor(
    private readonly store: Store,
    private readonly files: FileService,
  ) {}

  start(): void {
    if (!isElectron() || this.recoveryTimer !== null || this.clearing) return;
    const s = this.store.get().settings;
    const recoveryMs = Math.max(2, s.recoverySnapshotIntervalSeconds) * 1000;
    const autosaveMs = Math.max(5, s.autosaveIntervalSeconds) * 1000;
    this.recoveryTimer = setInterval(() => this.tickRecovery(), recoveryMs);
    this.autosaveTimer = setInterval(() => void this.tickAutosave(), autosaveMs);
  }

  stop(): void {
    this.stopVersion++;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    if (this.autosaveTimer) clearInterval(this.autosaveTimer);
    this.recoveryTimer = this.autosaveTimer = null;
  }

  /** Stop scheduling, finish dispatched writes, then delete this session's
   *  snapshots. A failed cleanup cancels shutdown and resumes recovery unless
   *  the caller stopped the scheduler while cleanup was pending. */
  clear(): Promise<void> {
    if (!isElectron()) return Promise.resolve();
    if (this.clearing) return this.clearing;
    const wasRunning = this.recoveryTimer !== null;
    this.stop();
    const version = this.stopVersion;
    this.clearing = this.clearSnapshots().then(
      () => { this.clearing = null; },
      (error: unknown) => {
        this.clearing = null;
        if (wasRunning && this.stopVersion === version) this.start();
        throw error;
      },
    );
    return this.clearing;
  }

  /** Keep every tab's existing-format snapshot independent. A slow operation
   *  skips only its own tab until the next interval, without queuing stale text. */
  private tickRecovery(): void {
    const tabs = new Map(this.store.get().tabs.map((tab) => [tab.id, tab.doc]));
    for (const id of new Set([...this.snapshotIds, ...tabs.keys()])) {
      if (this.pending.has(id)) continue;
      const doc = tabs.get(id);
      if (doc?.isDirty) {
        // Tab UUIDs already satisfy snapshot ID validation. Remember ownership
        // before writing, even if the tab closes or the write reports failure.
        this.snapshotIds.add(id);
        this.track(id, writeSnapshot({
          sessionId: id,
          savedAt: new Date().toISOString(),
          filePath: doc.filePath,
          markdown: doc.markdown,
          isDirty: true,
        }));
      } else if (this.snapshotIds.has(id)) {
        this.track(id, this.deleteOwnedSnapshot(id));
      }
    }
  }

  /** Retain failed work for the next interval and expose completion to clear. */
  private track(id: string, operation: Promise<void>): void {
    this.pending.set(id, operation.catch(() => {}).finally(() => { this.pending.delete(id); }));
  }

  /** Forget ownership only after deletion succeeds, so failures can be retried. */
  private async deleteOwnedSnapshot(id: string): Promise<void> {
    await deleteSnapshot(id);
    this.snapshotIds.delete(id);
  }

  /** Wait for all cleanup attempts before resuming after any failure. */
  private async clearSnapshots(): Promise<void> {
    await Promise.all(this.pending.values());
    const results = await Promise.allSettled([...this.snapshotIds].map((id) => this.deleteOwnedSnapshot(id)));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  /** Save the active document if autosave is on. A typed closing `$` or `~`
   *  that still waits for the next character is saved as Save would write it,
   *  but keeps waiting in the editor, so a pause in typing never decides it
   *  there. */
  private async tickAutosave(): Promise<void> {
    const { doc, settings } = this.store.get();
    if (settings.autosaveEnabled && doc.filePath && doc.isDirty) {
      await this.files.save({ keepTypedMark: true }).catch(() => {});
    }
  }
}
