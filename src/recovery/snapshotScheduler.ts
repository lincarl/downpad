// Autosave + crash-recovery snapshots (spec §5.11). Two timers:
//   - recovery snapshots are ALWAYS on: every recoverySnapshotIntervalSeconds,
//     while the doc is dirty, write the buffer to disk; once clean again, delete
//     the snapshot (so a clean shutdown leaves nothing to recover).
//   - autosave-to-file is opt-in: every autosaveIntervalSeconds, if enabled and
//     the doc has a path and is dirty, save it.
// No-op outside Tauri.

import type { Store } from "../state/store";
import type { FileService } from "../files/FileService";
import { writeSnapshot, deleteSnapshot } from "../ipc/commands";
import { isTauri } from "../ipc/env";

export class SnapshotScheduler {
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;
  private wroteSnapshot = false;

  constructor(
    private readonly store: Store,
    private readonly files: FileService,
  ) {}

  start(): void {
    if (!isTauri()) return;
    const s = this.store.get().settings;
    const recoveryMs = Math.max(2, s.recoverySnapshotIntervalSeconds) * 1000;
    const autosaveMs = Math.max(5, s.autosaveIntervalSeconds) * 1000;
    this.recoveryTimer = setInterval(() => this.tickRecovery(), recoveryMs);
    this.autosaveTimer = setInterval(() => void this.tickAutosave(), autosaveMs);
  }

  stop(): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    if (this.autosaveTimer) clearInterval(this.autosaveTimer);
    this.recoveryTimer = this.autosaveTimer = null;
  }

  /** Delete this session's snapshot (called on a clean shutdown). */
  async clear(): Promise<void> {
    if (isTauri()) await deleteSnapshot(this.store.get().sessionId).catch(() => {});
    this.wroteSnapshot = false;
  }

  private tickRecovery(): void {
    const { doc, sessionId } = this.store.get();
    if (doc.isDirty) {
      void writeSnapshot({
        sessionId,
        savedAt: new Date().toISOString(),
        filePath: doc.filePath,
        markdown: doc.markdown,
        isDirty: true,
      }).then(() => {
        this.wroteSnapshot = true;
      }).catch(() => {});
    } else if (this.wroteSnapshot) {
      this.wroteSnapshot = false;
      void deleteSnapshot(sessionId).catch(() => {});
    }
  }

  private async tickAutosave(): Promise<void> {
    const { doc, settings } = this.store.get();
    if (settings.autosaveEnabled && doc.filePath && doc.isDirty) {
      await this.files.save().catch(() => {});
    }
  }
}
