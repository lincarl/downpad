// File lifecycle: new / open / save / save-as (spec §5.1) with multi-document
// tabs (§5.19). Reads and writes go through Electron IPC (UTF-8, no BOM,
// EOL preserved, atomic); dialogs use Electron native dialogs. Opening reuses an
// empty untitled tab that no dropped file is on its way into, or focuses an
// already-open file; otherwise a new tab is added. The active tab's document is the canonical markdown string; after it
// changes the EditorPresenter re-shows it in the editor.

import { openDialog, saveDialog, ask, confirmSaveChanges } from "../ipc/dialogs";
import { readFile, writeFile, recordFileOpened, watchFile, unwatchFile } from "../ipc/commands";
import { isElectron } from "../ipc/env";
import { sameFilePath } from "./pathIdentity";
import { blankDoc, hasUnsavedChanges, type DocumentState } from "../state/types";
import type { Store } from "../state/store";

const MD_FILTERS = [
  { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] },
  { name: "Text", extensions: ["txt"] },
  { name: "All files", extensions: ["*"] },
];

/**
 * Presents the active document in the editor. Implemented by AppRuntime, which
 * owns the editor mount and view state (it must flush the outgoing editor before
 * the active tab changes, then re-mount from the new active document, §5.19).
 */
export interface EditorPresenter {
  /** Bring the active doc up to date with its editors, keeping them in place.
   *  Use before reading the active doc, for example to save it, or leaving it.
   *  The document editor decides a typed closing `$` or `~` that waits for the
   *  next character first, unless `keepTypedMark` asks it to keep the mark
   *  waiting. Either way the active doc gets the mark as Save writes it. */
  flush(options?: { keepTypedMark?: boolean }): void;
  /** Show the active tab's document, revealing its cached editor when possible
   *  (preserves undo). Use after a pure tab switch / focusing an open file. */
  showActiveDoc(): Promise<void>;
  /** Show the active tab's document after its content was *replaced* (open / new
   *  / reload): force a fresh editor (undo resets). */
  reloadActiveDoc(): Promise<void>;
}

interface SaveRequest {
  tabId: string;
  snapshot: DocumentState;
  expectedPath: string | null;
  saveAs: boolean;
}

/** A clean close must still pass canCloseTabs immediately before removing tabs. */
export type CloseDecision = "close" | "discard" | "cancel";

export class FileService {
  private saveQueue: Promise<void> = Promise.resolve();
  private pendingSaves = new Set<SaveRequest>();

  constructor(
    private readonly store: Store,
    private readonly present: EditorPresenter,
  ) {}

  /** Open a new untitled buffer in its own tab (§5.19). */
  async newDocument(): Promise<void> {
    this.present.flush();
    this.store.addTab(blankDoc());
    await this.present.reloadActiveDoc();
  }

  /**
   * Open a known path (drag-drop, the Recent view, launch args). If the file is
   * already open, focuses that tab; if the active tab is an empty untitled
   * buffer, replaces it; otherwise opens a new tab. Reload rereads an existing
   * tab from disk after confirming any unsaved changes. If that tab closes
   * during the read, its result is discarded.
   */
  async openPath(path: string, options: { reload?: boolean } = {}): Promise<void> {
    this.present.flush();

    const existing = this.store.get().tabs.find((t) => samePath(t.doc.filePath, path));
    if (existing && !options.reload) {
      this.store.activateTab(existing.id);
      await this.present.showActiveDoc(); // focus the open tab — keep its undo
      this.recordOpened(path);
      return;
    }

    if (existing?.doc.isDirty) {
      const label = path.split(/[\\/]/).pop() ?? path;
      const discard = await this.confirmDiscard(`"${label}" has unsaved changes. Discard them and reload?`);
      if (!discard) return;
    }

    const payload = await readFile(path);
    // A closed reload owner must not redirect the read into the active tab,
    // even if that tab has since opened the same path.
    if (existing && !this.store.get().tabs.some((tab) => tab.id === existing.id)) return;
    const doc: DocumentState = {
      markdown: payload.content,
      filePath: path,
      eol: payload.eol,
      hadBom: payload.hadBom,
      modifiedMs: payload.modifiedMs,
      isDirty: false,
      savedMarkdown: payload.content,
      frontmatterCollapsed: existing?.doc.frontmatterCollapsed ?? false,
    };
    if (existing) {
      this.store.activateTab(existing.id);
      this.store.replaceActiveDoc(doc);
    } else if (this.activeIsReusable()) this.store.replaceActiveDoc(doc);
    else this.store.addTab(doc);

    await this.present.reloadActiveDoc(); // fresh content → fresh editor
    this.recordOpened(path);
  }

  /** True if the active tab is a pristine untitled buffer that open can reuse.
   *  One that a dropped file is on its way into keeps its document, so the
   *  file never goes into the one opened (§5.4). */
  private activeIsReusable(): boolean {
    const { tabs, activeTabId } = this.store.get();
    const active = tabs.find((t) => t.id === activeTabId);
    return !!active && !hasUnsavedChanges(active) && !active.doc.filePath && active.doc.markdown.trim() === "";
  }

  /** Point the single backend watcher at the active document's file, or clear
   *  it for an untitled buffer. Call after the active tab changes (§5.1, §5.19). */
  watchActive(): void {
    if (!isElectron()) return;
    const path = this.store.get().doc.filePath;
    if (path) void watchFile(path).catch((err) => console.error("Downpad: watch failed", err));
    else void unwatchFile().catch(() => {});
  }

  /** Watch a specific path (used by the recovery flow before the editor mounts). */
  watch(path: string): void {
    if (!isElectron()) return;
    void watchFile(path).catch((err) => console.error("Downpad: watch failed", err));
  }

  /** Add/refresh the recent-files entry for a just-opened path (§5.8.1). */
  private recordOpened(path: string): void {
    if (!isElectron()) return;
    void recordFileOpened(path, Date.now()).catch((err) =>
      console.error("Downpad: failed to record recent file", err),
    );
  }

  async openViaDialog(): Promise<void> {
    const selected = await openDialog({ multiple: false, filters: MD_FILTERS });
    if (typeof selected === "string") {
      await this.openPath(selected);
    }
  }

  /** Save to the current path, or fall back to Save As for an untitled buffer.
   *  `keepTypedMark` is for a save nobody asked for, such as autosave. It
   *  writes a typed closing `$` or `~` that still waits for the next character
   *  as Save would, but leaves it waiting in the editor, so the save never
   *  changes the document while the user types, and a digit typed next still
   *  keeps it text. */
  save(options: { keepTypedMark?: boolean } = {}): Promise<boolean> {
    return this.queueSave(this.store.get().activeTabId, false, options);
  }

  saveAs(): Promise<boolean> {
    return this.queueSave(this.store.get().activeTabId, true);
  }

  /** Resolve once no save that can give a tab's document a new path is under
   *  way, with its dialog open or its file being written. That is a Save As,
   *  or a save that asks where to save an untitled document. A file pasted
   *  or dropped into the document waits for this before it is written beside
   *  it (§5.4, §5.5, `storeBesideDocument`). */
  async untilPathSettled(tabId: string): Promise<void> {
    const moves = (request: SaveRequest): boolean =>
      request.tabId === tabId && (request.saveAs || request.expectedPath === null);
    while ([...this.pendingSaves].some(moves)) await this.saveQueue;
  }

  /** Capture the requested buffer now, then order saves and Save As dialogs. */
  private queueSave(tabId: string | null, saveAs: boolean, options: { keepTypedMark?: boolean } = {}): Promise<boolean> {
    // The document view reports typing after a short delay. Collect it first so
    // a save right after typing writes the latest text.
    this.present.flush(options);
    const doc = this.store.get().tabs.find((tab) => tab.id === tabId)?.doc;
    if (!tabId || !doc) return Promise.resolve(false);
    const request = { tabId, snapshot: doc, expectedPath: doc.filePath, saveAs };
    this.pendingSaves.add(request);
    const operation = this.saveQueue.then(() => this.saveSnapshot(request))
      .finally(() => this.pendingSaves.delete(request));
    // A failed or cancelled operation must not prevent a subsequent save.
    this.saveQueue = operation.then(() => {}, () => {});
    return operation;
  }

  private async saveSnapshot({ tabId, snapshot, expectedPath, saveAs }: SaveRequest): Promise<boolean> {
    const current = this.store.get().tabs.find((tab) => tab.id === tabId)?.doc;
    if (!current || current.filePath !== expectedPath) return false;
    const originalPath = current.filePath;
    let path = originalPath;
    const choosePath = saveAs || !path;
    if (choosePath) {
      path = await saveDialog({ filters: MD_FILTERS, defaultPath: originalPath ?? "Untitled.md" });
      const afterDialog = this.store.get().tabs.find((tab) => tab.id === tabId)?.doc;
      if (!path || !afterDialog || afterDialog.filePath !== originalPath) return false;
    }
    if (!path) return false;
    // Until the write settles, the file may hold the old saved text or the new
    // one, so an edit back to either still counts as unsaved.
    const previous = this.store.get().tabs.find((tab) => tab.id === tabId)?.doc.savedMarkdown ?? null;
    this.store.patchDocById(tabId, { savedMarkdown: null });
    const meta = await writeFile(path, snapshot.markdown, snapshot.eol).catch((error: unknown) => {
      this.restoreSavedMarkdown(tabId, originalPath, previous);
      throw error;
    });
    this.markSaved(tabId, snapshot, originalPath, path, meta.modifiedMs);
    if (choosePath) this.recordOpened(path);
    return true;
  }

  /** Apply saved metadata to its owner, keeping later edits dirty. A change on
   *  disk that was recorded while the write was pending, with a later mtime,
   *  stays the file's text. */
  private markSaved(tabId: string, snapshot: DocumentState, originalPath: string | null, path: string, modifiedMs: number): void {
    const current = this.store.get().tabs.find((tab) => tab.id === tabId)?.doc;
    if (!current || current.filePath !== originalPath) return;
    const newerOnDisk = path === originalPath && current.savedMarkdown !== null && current.modifiedMs > modifiedMs;
    this.store.patchDocById(
      tabId,
      newerOnDisk
        ? { isDirty: current.markdown !== current.savedMarkdown }
        : {
            filePath: path,
            isDirty: current.markdown !== snapshot.markdown || current.eol !== snapshot.eol,
            savedMarkdown: snapshot.markdown,
            modifiedMs,
          },
    );
    // Requests queued during Save As follow the owner's new path, retaining
    // the content each caller asked to save.
    for (const pending of this.pendingSaves) {
      if (pending.tabId === tabId && pending.expectedPath === originalPath) pending.expectedPath = path;
    }
    if (this.store.get().activeTabId === tabId) {
      this.store.set({ saveStatus: { lastSavedAt: Date.now(), autosaving: false } });
      if (path !== originalPath) this.watch(path);
    }
  }

  /** After a failed write, give the tab back the saved text it had before,
   *  unless something else has recorded the file's text since. */
  private restoreSavedMarkdown(tabId: string, originalPath: string | null, previous: string | null): void {
    const current = this.store.get().tabs.find((tab) => tab.id === tabId)?.doc;
    if (!current || current.filePath !== originalPath || current.savedMarkdown !== null) return;
    this.store.patchDocById(tabId, { savedMarkdown: previous, isDirty: current.markdown !== previous });
  }

  /** Whether any open tab has unsaved changes (window-close guard, §5.19),
   *  counting files dropped on a document that are not in yet. */
  anyDirty(): boolean {
    return this.store.get().tabs.some(hasUnsavedChanges);
  }

  /** Save or discard one tab without activating it or redirecting its save. */
  confirmCloseTab(tabId: string, label: string): Promise<CloseDecision> {
    return this.prepareClose([tabId], `"${label}" has unsaved changes. Save before closing?`);
  }

  /** Prompt once and save each unsaved tab before closing all tabs or the window. */
  confirmCloseAll(): Promise<CloseDecision> {
    this.present.flush();
    const n = this.store.get().tabs.filter(hasUnsavedChanges).length;
    const what = n === 1 ? "1 document has" : `${n} documents have`;
    return this.prepareClose(this.store.get().tabs.map((tab) => tab.id), `${what} unsaved changes. Save before closing?`);
  }

  /** Recheck after asynchronous work, including unreported typing, dropped
   *  files and queued writes that could change what is safely saved. */
  canCloseTabs(tabIds = this.store.get().tabs.map((tab) => tab.id)): boolean {
    this.present.flush();
    const owners = new Set(tabIds);
    return !this.store.get().tabs.some((tab) => owners.has(tab.id) && hasUnsavedChanges(tab))
      && ![...this.pendingSaves].some((request) => owners.has(request.tabId));
  }

  /** Keep close saves in the ordinary queue, then verify every requested tab.
   *  Cancellation or failure leaves all tabs open, including those saved first. */
  private async prepareClose(tabIds: string[], message: string): Promise<CloseDecision> {
    this.present.flush();
    const owners = new Set(tabIds);
    const unsaved = () => this.store.get().tabs.filter((tab) => owners.has(tab.id) && hasUnsavedChanges(tab));
    if (unsaved().length > 0) {
      const choice = await confirmSaveChanges(message);
      if (choice === "cancel" || choice === "discard") return choice;
      // The native prompt can remain open while editor updates are pending.
      this.present.flush();
      for (const tab of unsaved()) {
        if (!(await this.queueSave(tab.id, false))) return "cancel";
      }
    }
    // Another queued save may still overwrite the file after our write. Wait
    // for it as well, and reject any newer edits or pending dropped assets.
    while ([...this.pendingSaves].some((request) => owners.has(request.tabId))) await this.saveQueue;
    return this.canCloseTabs(tabIds) ? "close" : "cancel";
  }

  private async confirmDiscard(message: string): Promise<boolean> {
    return ask(message, {
      title: "Downpad",
      kind: "warning",
      okLabel: "Discard",
      cancelLabel: "Cancel",
    });
  }
}

/** Compare saved paths without merging distinct files on POSIX filesystems. */
function samePath(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return sameFilePath(a, b);
}
