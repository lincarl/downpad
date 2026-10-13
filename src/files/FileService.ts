// File lifecycle: new / open / save / save-as (spec §5.1) with multi-document
// tabs (§5.19). Reads and writes go through Electron IPC (UTF-8, no BOM,
// EOL preserved, atomic); dialogs use Electron native dialogs. Opening reuses an
// empty untitled tab or focuses an already-open file; otherwise a new tab is
// added. The active tab's document is the canonical markdown string; after it
// changes the EditorPresenter re-shows it in the editor.

import { openDialog, saveDialog, ask } from "../ipc/dialogs";
import { readFile, writeFile, recordFileOpened, watchFile, unwatchFile } from "../ipc/commands";
import { isElectron } from "../ipc/env";
import { sameFilePath } from "./pathIdentity";
import { blankDoc, type DocumentState } from "../state/types";
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
  /** Write the active editor's current content into the canonical doc. */
  flush(): void;
  /** Show the active tab's document, revealing its cached editor when possible
   *  (preserves undo). Use after a pure tab switch / focusing an open file. */
  showActiveDoc(): Promise<void>;
  /** Show the active tab's document after its content was *replaced* (open / new
   *  / reload): force a fresh editor (undo resets). */
  reloadActiveDoc(): Promise<void>;
}

export class FileService {
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
   * tab from disk after confirming any unsaved changes.
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
    const doc: DocumentState = {
      markdown: payload.content,
      filePath: path,
      eol: payload.eol,
      hadBom: payload.hadBom,
      modifiedMs: payload.modifiedMs,
      isDirty: false,
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

  /** True if the active tab is a pristine untitled buffer that open can reuse. */
  private activeIsReusable(): boolean {
    const { tabs, activeTabId } = this.store.get();
    const active = tabs.find((t) => t.id === activeTabId);
    return !!active && !active.doc.filePath && !active.doc.isDirty && active.doc.markdown.trim() === "";
  }

  /** Point the single backend watcher at the active document's file, or clear
   *  it for an untitled buffer. Call after the active tab changes (§5.1, §5.19). */
  watchActive(): void {
    if (!isElectron()) return;
    const path = this.store.get().doc.filePath;
    if (path) void watchFile(path).catch((err) => console.error("md-easy: watch failed", err));
    else void unwatchFile().catch(() => {});
  }

  /** Watch a specific path (used by the recovery flow before the editor mounts). */
  watch(path: string): void {
    if (!isElectron()) return;
    void watchFile(path).catch((err) => console.error("md-easy: watch failed", err));
  }

  /** Add/refresh the recent-files entry for a just-opened path (§5.8.1). */
  private recordOpened(path: string): void {
    if (!isElectron()) return;
    void recordFileOpened(path, Date.now()).catch((err) =>
      console.error("md-easy: failed to record recent file", err),
    );
  }

  async openViaDialog(): Promise<void> {
    const selected = await openDialog({ multiple: false, filters: MD_FILTERS });
    if (typeof selected === "string") {
      await this.openPath(selected);
    }
  }

  /** Save to the current path, or fall back to Save As for an untitled buffer. */
  async save(): Promise<boolean> {
    const { doc } = this.store.get();
    if (!doc.filePath) return this.saveAs();
    const meta = await writeFile(doc.filePath, doc.markdown, doc.eol);
    this.markSaved(meta.modifiedMs);
    return true;
  }

  async saveAs(): Promise<boolean> {
    const { doc } = this.store.get();
    const path = await saveDialog({
      filters: MD_FILTERS,
      defaultPath: doc.filePath ?? "Untitled.md",
    });
    if (!path) return false;
    const meta = await writeFile(path, doc.markdown, doc.eol);
    this.store.patchDoc({ filePath: path });
    this.markSaved(meta.modifiedMs);
    this.recordOpened(path);
    this.watch(path);
    return true;
  }

  /** Record a save: clear dirty, remember the on-disk mtime (suppresses the
   *  watcher's self-write event, §5.1), and update the status bar. */
  private markSaved(modifiedMs: number): void {
    this.store.patchDoc({ isDirty: false, modifiedMs });
    this.store.set({ saveStatus: { lastSavedAt: Date.now(), autosaving: false } });
  }

  /** Whether any open tab has unsaved changes (window-close guard, §5.19). */
  anyDirty(): boolean {
    return this.store.get().tabs.some((t) => t.doc.isDirty);
  }

  /** Confirm discarding a single named tab before closing it (§5.19). */
  async confirmCloseTab(label: string): Promise<boolean> {
    return this.confirmDiscard(`"${label}" has unsaved changes. Discard them?`);
  }

  /** Confirm discarding all unsaved tabs on window close (§5.19). */
  async confirmDiscardAll(): Promise<boolean> {
    const n = this.store.get().tabs.filter((t) => t.doc.isDirty).length;
    const what = n === 1 ? "1 document has" : `${n} documents have`;
    return this.confirmDiscard(`${what} unsaved changes. Discard them and close?`);
  }

  private async confirmDiscard(message: string): Promise<boolean> {
    return ask(message, {
      title: "md-easy",
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
