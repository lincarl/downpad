// Records which documents are open whenever that changes, so the next start
// reopens them (StartupCoordinator), also after a crash. Only documents with a
// file count: an untitled buffer has nothing to reopen.

import { saveSession } from "../ipc/commands";
import type { Session } from "../ipc/contracts";
import { isElectron } from "../ipc/env";
import { sameFilePath } from "../files/pathIdentity";
import type { Store } from "../state/store";
import type { AppState } from "../state/types";

/** The session that reopens the documents open in `state`. */
export function sessionOf(state: Pick<AppState, "tabs" | "activeTabId">): Session {
  return {
    files: state.tabs.flatMap((tab) => (tab.doc.filePath ? [tab.doc.filePath] : [])),
    active: state.tabs.find((tab) => tab.id === state.activeTabId)?.doc.filePath ?? null,
  };
}

export class SessionKeeper {
  /** The session last handed to the main process, as JSON. */
  private recorded = "";
  private writes: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private unavailable: string[] = [];
  private fileOrder: string[] = [];
  private unavailableActive: string | null = null;

  constructor(private readonly store: Store) {}

  /** Record open documents and remember files startup could not read. Start
   *  after startup has resolved recovery, restored tabs and launch arguments. */
  start(previous: Session | null = null): void {
    if (!isElectron() || this.unsubscribe) return;
    const open = sessionOf(this.store.get()).files;
    this.fileOrder = previous?.files.filter((path, index, paths) =>
      paths.findIndex((file) => sameFilePath(file, path)) === index) ?? [];
    this.unavailable = this.fileOrder.filter((path) => !open.some((file) => sameFilePath(file, path)));
    const active = previous?.active;
    this.unavailableActive = active && this.unavailable.some((path) => sameFilePath(path, active)) ? active : null;
    this.unsubscribe = this.store.subscribe((state, before) => {
      // Closing the last visible tab deliberately clears the whole session.
      // Starting with no readable files must keep the saved reopening intent.
      if (before.tabs.length > 0 && state.tabs.length === 0) this.unavailable = [];
      if (state.activeTabId !== before.activeTabId || state.doc.filePath !== before.doc.filePath) this.unavailableActive = null;
      this.record();
    });
    this.record();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Resolve once the documents open now are recorded, as before the window
   *  closes, also a change made while the last write was under way. A failed
   *  write is logged, since it must not keep the window open. */
  async flush(): Promise<void> {
    this.record();
    let writes: Promise<void>;
    do {
      writes = this.writes;
      await writes;
    } while (writes !== this.writes);
  }

  private record(): void {
    if (!this.unsubscribe) return;
    const session = this.nextSession();
    const text = JSON.stringify(session);
    if (text === this.recorded) return;
    this.recorded = text;
    this.writes = this.writes.then(() => saveSession(session)).catch((error: unknown) => {
      // Write it again with the next change or flush.
      if (this.recorded === text) this.recorded = "";
      console.error("Downpad could not record the open documents", error);
    });
  }

  /** Keep unavailable files in their saved positions until opened or cleared. */
  private nextSession(): Session {
    const current = sessionOf(this.store.get());
    const isOpen = (path: string) => current.files.some((file) => sameFilePath(file, path));
    // Once a file opens normally, its tab owns its place in the session. A
    // later close or Save As must not bring the old unavailable path back.
    this.unavailable = this.unavailable.filter((path) => !isOpen(path));
    if (this.unavailable.length === 0) {
      this.fileOrder = current.files;
      return current;
    }
    const isUnavailable = (path: string) => this.unavailable.some((file) => sameFilePath(file, path));
    const retained = this.fileOrder.filter((path) => isOpen(path) || isUnavailable(path));
    let openIndex = 0;
    const files = retained.flatMap((path) => {
      if (isUnavailable(path)) return [path];
      const open = current.files[openIndex++];
      return open ? [open] : [];
    });
    files.push(...current.files.slice(openIndex));
    this.fileOrder = files;
    const active = this.unavailableActive && isUnavailable(this.unavailableActive)
      ? this.unavailableActive : current.active;
    return { files, active };
  }
}
