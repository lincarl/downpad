// Records which documents are open whenever that changes, so the next start
// reopens them (StartupCoordinator), also after a crash. Only documents with a
// file count: an untitled buffer has nothing to reopen.

import { saveSession } from "../ipc/commands";
import type { Session } from "../ipc/contracts";
import { isElectron } from "../ipc/env";
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

  constructor(private readonly store: Store) {}

  /** Record the documents open now, and from then on every change. Startup
   *  clears the tabs before it reopens the documents, so start once it ends. */
  start(): void {
    if (!isElectron() || this.unsubscribe) return;
    this.unsubscribe = this.store.subscribe(() => this.record());
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
    const session = sessionOf(this.store.get());
    const text = JSON.stringify(session);
    if (text === this.recorded) return;
    this.recorded = text;
    this.writes = this.writes.then(() => saveSession(session)).catch((error: unknown) => {
      // Write it again with the next change or flush.
      if (this.recorded === text) this.recorded = "";
      console.error("Downpad could not record the open documents", error);
    });
  }
}
