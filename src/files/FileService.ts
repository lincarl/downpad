// File lifecycle: new / open / save / save-as (spec §5.1) with multi-document
// tabs (§5.19). Reads and writes go through Electron IPC (UTF-8, no BOM,
// EOL preserved, atomic); dialogs use Electron native dialogs. Opening reuses an
// empty untitled tab that no dropped file is on its way into, or focuses an
// already-open file; otherwise a new tab is added. The active tab's document is the canonical markdown string; after it
// changes the EditorPresenter re-shows it in the editor.

import { openDialog, saveDialog, ask, confirmSaveChanges } from "../ipc/dialogs";
import { pathExists, readFile, writeFile, recordFileOpened, watchFile, unwatchFile } from "../ipc/commands";
import { FILE_CHANGED_ON_DISK, type FileMeta, type FilePayload } from "../ipc/contracts";
import { isElectron } from "../ipc/env";
import { sameFilePath } from "./pathIdentity";
import { documentLanguage, extensionOf, fileFilters } from "./documentLanguage";
import { blankDoc, hasUnsavedChanges, type DocumentState, type Tab } from "../state/types";
import type { Store } from "../state/store";

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
   *  / reload): force a fresh editor (undo resets). With `keepPlace`, the
   *  document stays where it is scrolled, as for a file Git changed. With
   *  `quiet` as well, the user did not ask for the replacement at that
   *  moment, so the Recent view stays in front if it shows. */
  reloadActiveDoc(options?: { keepPlace?: boolean; quiet?: boolean }): Promise<void>;
}

interface SaveRequest {
  tabId: string;
  snapshot: DocumentState;
  expectedPath: string | null;
  saveAs: boolean;
  choice: SaveAsChoice;
  /** Marks a save nobody asked for as such, with the check that holds it. */
  automatic?: (tabId: string) => boolean | Promise<boolean>;
  /** For a save that a close asked for: the tab's `failedMoves` count when
   *  the close began. A higher count by the save's turn means that a Save As
   *  of the tab failed or was cancelled meanwhile, so the document still has
   *  the file the user was leaving, and the save writes nothing. */
  failedMovesBefore?: number;
  /** Once its dialog closed: the file that the save chose, which no other tab
   *  may choose until the save ends. */
  chosen?: string;
  /** Once the write starts: the file it writes, and the saved text it replaces. */
  write?: { path: string; replaced: string | null };
  /** Set once the write has run for SLOW_WRITE_MS without an answer. */
  slow?: boolean;
  /** Whether the save wrote the document, once it ends. A save that threw did not. */
  outcome?: Promise<boolean>;
}

/** How long a write runs without an answer before the app says so (`SaveEvents.slowWrite`). */
export const SLOW_WRITE_MS = 10_000;

/** What FileService tells about saves, apart from the answer of each save. */
export interface SaveEvents {
  /** A write of the tab's document worked, whoever asked for the save. */
  saved?(tabId: string): void;
  /** A write of the tab's document has run for SLOW_WRITE_MS without an
   *  answer, or a save of the tab was asked for while such a write runs. */
  slowWrite?(tabId: string): void;
  /** A write that `slowWrite` told about has ended, written or not. */
  slowWriteEnded?(tabId: string): void;
  /** A save of the tab that a close asked for failed with `error`. `path` is
   *  the document's file when the save was asked for, null for an untitled
   *  document, which names the document once its tab is closed. A failure
   *  while the close is under way is told once the close ends, so that its
   *  notice shows after the close's last dialog, and a later one at once.
   *  The close keeps its tabs open and leaves telling the user to this
   *  event, as a failed Save does. */
  closeSaveFailed?(tabId: string, path: string | null, error: unknown): void;
}

/** The suggested path of a Save As, and paths it must not write. */
interface SaveAsChoice {
  defaultPath?: string;
  refuse?: (path: string) => boolean;
}

/** A clean close must still pass canCloseTabs immediately before removing tabs. */
export type CloseDecision = "close" | "discard" | "cancel";

export class FileService {
  /** By tab, the end of the last save asked for. A tab's saves run one at a
   *  time in the order asked for, and never wait for another tab's, so a write
   *  that does not return, as to a network drive that went away, holds up
   *  only the saves of its own document. */
  private saveQueues = new Map<string, Promise<void>>();
  /** The end of the last turn for a Save As dialog. One shows at a time. */
  private dialogTurn: Promise<void> = Promise.resolve();
  private pendingSaves = new Set<SaveRequest>();
  /** By tab, how many saves that were to give its document another file ended
   *  without doing so (`failedMoves`). */
  private unmoved = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly present: EditorPresenter,
    private readonly events: SaveEvents = {},
  ) {}

  /** Open a new untitled buffer in its own tab (§5.19). */
  async newDocument(): Promise<void> {
    this.present.flush();
    this.store.addTab(blankDoc());
    await this.present.reloadActiveDoc();
  }

  /**
   * Open a known path (drag-drop, the Recent view, launch args). If the file is
   * already open, focuses that tab, also when it got its tab while this open
   * read it, or from a Save As that was writing it, which the open waits
   * for; if the active tab is an empty untitled buffer, replaces it;
   * otherwise opens a new tab. Reload rereads an existing
   * tab from disk after confirming any unsaved changes. If that tab closes
   * during the read, or gets another file, as through Save As, the read is
   * discarded and the tab keeps its document. Text typed in the tab during
   * the read goes with the reload the user asked for.
   */
  async openPath(path: string, options: { reload?: boolean } = {}): Promise<void> {
    this.present.flush();

    const showing = (): Tab | undefined => this.store.get().tabs.find((t) => samePath(t.doc.filePath, path));
    // A Save As that is writing the file gives it to its tab once it ends,
    // or to none when it fails, so the open waits to see which.
    if (!options.reload) await this.untilWritten(path);
    const existing = showing();
    const focus = async (tab: Tab): Promise<void> => {
      // The open may have waited meanwhile, and the tab in front can have
      // typing that its editor has not reported yet.
      this.present.flush();
      this.store.activateTab(tab.id);
      await this.present.showActiveDoc(); // focus the open tab — keep its undo
      this.recordOpened(path);
    };
    if (existing && !options.reload) return focus(existing);

    if (existing?.doc.isDirty) {
      const label = path.split(/[\\/]/).pop() ?? path;
      const discard = await this.confirmDiscard(`"${label}" has unsaved changes. Discard them and reload?`);
      if (!discard) return;
    }

    // A closed reload owner must not redirect the read into the active tab,
    // even if that tab has since opened the same path. A tab that shows
    // another file by now, as after a Save As during the read, keeps its
    // document, with the text typed into it since, and a read that failed
    // is none of its business then.
    const moved = (): boolean => !!existing && !samePath(this.store.get().tabs.find((tab) => tab.id === existing.id)?.doc.filePath ?? null, path);
    let payload: FilePayload;
    try {
      payload = await readFile(path);
    } catch (error) {
      if (moved()) return;
      throw error;
    }
    if (moved()) return;
    // Another open of the file, or a Save As onto it, can have given it a tab
    // while it was read, and one file never gets two tabs.
    if (!existing) {
      await this.untilWritten(path);
      const opened = showing();
      if (opened) return focus(opened);
    }
    const doc = fileDocument(path, payload, existing?.doc.frontmatterCollapsed ?? false);
    if (existing) {
      // Another tab can be in front by now, with typing that its editor has
      // not reported yet.
      this.present.flush();
      this.store.activateTab(existing.id);
      this.store.replaceActiveDoc(doc);
    } else {
      // Text typed into an empty untitled tab while the file was read is
      // still with the editor, which reports typing after a short delay.
      this.present.flush();
      if (this.activeIsReusable()) this.store.replaceActiveDoc(doc);
      else this.store.addTab(doc);
    }

    await this.present.reloadActiveDoc(); // fresh content → fresh editor
    this.recordOpened(path);
  }

  /** Resolve once no save under way is writing the file at `path`, as a Save
   *  As that gives the file to its tab when it ends. */
  private async untilWritten(path: string): Promise<void> {
    for (;;) {
      const writer = [...this.pendingSaves].find((request) => request.write !== undefined && samePath(request.write.path, path));
      if (!writer) return;
      await writer.outcome;
    }
  }

  /** Reopen the files of an earlier session in new tabs, in their order,
   *  without showing them, and make `active` the active tab. A file that is
   *  open already is left alone. Unreadable files get no editor tab, and
   *  SessionKeeper remembers them for later starts. Unlike openPath, this
   *  does not count as opening the files for Recent. Returns whether any file
   *  reopened. */
  async restoreTabs(paths: readonly string[], active: string | null): Promise<boolean> {
    const isOpen = (path: string) => this.store.get().tabs.some((tab) => samePath(tab.doc.filePath, path));
    const closed = paths.filter((path) => !isOpen(path));
    const payloads = await Promise.all(closed.map((path) => readFile(path).catch(() => null)));
    this.present.flush();
    let reopened = false;
    closed.forEach((path, index) => {
      const payload = payloads[index];
      if (!payload || isOpen(path)) return;
      this.store.addTab(fileDocument(path, payload));
      reopened = true;
    });
    const shown = this.store.get().tabs.find((tab) => samePath(tab.doc.filePath, active));
    if (shown) this.store.activateTab(shown.id);
    return reopened;
  }

  /** Open `path` in a new tab right after the tab `afterTabId`, without
   *  showing it. A file that is open already is left alone. */
  async openBeside(path: string, afterTabId: string): Promise<void> {
    if (this.store.get().tabs.some((tab) => samePath(tab.doc.filePath, path))) return;
    const payload = await readFile(path);
    if (this.store.get().tabs.some((tab) => samePath(tab.doc.filePath, path))) return;
    this.store.insertTab(fileDocument(path, payload), afterTabId);
    this.recordOpened(path);
  }

  /** Read a tab's file again into the tab, which is not the active one, so
   *  its editors are built from the new text when it is shown. A tab with
   *  unsaved changes keeps them. Returns whether the tab took the new text. */
  async refreshFromDisk(tabId: string): Promise<boolean> {
    const before = this.store.get().tabs.find((tab) => tab.id === tabId);
    if (!before?.doc.filePath || hasUnsavedChanges(before) || this.store.get().activeTabId === tabId) return false;
    const payload = await readFile(before.doc.filePath);
    const tab = this.store.get().tabs.find((entry) => entry.id === tabId);
    if (!tab || tab.doc.filePath !== before.doc.filePath || hasUnsavedChanges(tab) || this.store.get().activeTabId === tabId) return false;
    this.store.patchDocById(tabId, fileDocument(before.doc.filePath, payload, tab.doc.frontmatterCollapsed));
    return true;
  }

  /**
   * Replace a tab's document, unsaved changes and all, with its file `path`
   * as it is on disk, after the user chose to discard those changes. `kept`
   * says whether the tab's latest text is the text that the caller kept a
   * copy of. It is asked after the read, in the same step as the
   * replacement, so text typed since the copy is never replaced. Returns
   * "shown" when it replaced the active tab's document and showed it,
   * "stored" when it replaced another tab's, whose editors the caller drops,
   * "changed" when the text was not the kept one, and "gone" when the tab
   * no longer holds `path`. The document keeps the place it is scrolled to.
   * With `quiet`, nobody asked for the replacement at that moment, as for
   * Git's automatic Get latest, and the Recent view stays in front if it
   * shows. Otherwise the document shows, so a notice about it is seen with it.
   */
  async replaceFromDisk(
    tabId: string,
    path: string,
    kept: (markdown: string) => boolean,
    { quiet = false }: { quiet?: boolean } = {},
  ): Promise<"shown" | "stored" | "changed" | "gone"> {
    const owner = (): Tab | undefined =>
      this.store.get().tabs.find((tab) => tab.id === tabId && samePath(tab.doc.filePath, path));
    if (!owner()) return "gone";
    const payload = await readFile(path);
    this.present.flush();
    const tab = owner();
    if (!tab) return "gone";
    if (tab.filesPending || !kept(tab.doc.markdown)) return "changed";
    const doc = fileDocument(path, payload, tab.doc.frontmatterCollapsed);
    if (this.store.get().activeTabId !== tabId) {
      this.store.patchDocById(tabId, doc);
      return "stored";
    }
    this.store.replaceActiveDoc(doc);
    await this.present.reloadActiveDoc({ keepPlace: true, quiet });
    return "shown";
  }

  /** True if the active tab is a pristine untitled buffer that open can reuse.
   *  One that a dropped file is on its way into keeps its document, so the
   *  file never goes into the one opened (§5.4). So does one whose save is
   *  under way, as a draft the user emptied again while its Save As writes,
   *  so that the save ends in the tab it started in. */
  private activeIsReusable(): boolean {
    const { tabs, activeTabId } = this.store.get();
    const active = tabs.find((t) => t.id === activeTabId);
    return !!active && !hasUnsavedChanges(active) && !active.doc.filePath && active.doc.markdown.trim() === "" && !this.isSaving(active.id);
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
    const selected = await openDialog({ multiple: false, filters: fileFilters() });
    if (typeof selected === "string") {
      await this.openPath(selected);
    }
  }

  /** Save to the current path, or fall back to Save As for an untitled buffer.
   *  The save runs after the saves of the same tab asked for before it, and
   *  never waits for another tab's saves. A save that asks where to save
   *  waits until no other tab's Save As dialog shows.
   *
   *  `keepTypedMark` is for a save nobody asked for, such as autosave. It
   *  writes a typed closing `$` or `~` that still waits for the next character
   *  as Save would, but leaves it waiting in the editor, so the save never
   *  changes the document while the user types, and a digit typed next still
   *  keeps it text.
   *
   *  `automatic` marks a save nobody asked for as such, such as autosave or
   *  the save before Copy file, with a check that holds it, given the tab. It
   *  runs first when the save's turn comes, after the tab's saves queued
   *  before it, and the save waits for its answer. A held save writes
   *  nothing. Otherwise the save writes the document as it is then, and does
   *  nothing when nothing is unsaved any more, as after a reload. It writes
   *  only while the file still holds the text the document last saved, so a
   *  change on disk the app has not seen yet stays, and the save reports
   *  failure then, as for a held one. A document whose saved text is
   *  unknown, such as a recovered one, is left to a save the user asks for. */
  save(options: { keepTypedMark?: boolean; automatic?: (tabId: string) => boolean | Promise<boolean> } = {}): Promise<boolean> {
    return this.queueSave(this.store.get().activeTabId, false, options);
  }

  /** Whether a save of the tab is writing the document's file now, with
   *  `markdown` or over it, so a file that holds it is the app's own doing,
   *  not a change on disk. A save that still waits for its turn or its dialog
   *  writes nothing yet, and a Save As writes another file. */
  isOwnWrite(tabId: string, markdown: string): boolean {
    const path = this.store.get().tabs.find((tab) => tab.id === tabId)?.doc.filePath ?? null;
    return [...this.pendingSaves].some(
      ({ tabId: owner, snapshot, write }) => owner === tabId && write !== undefined && samePath(write.path, path)
        && (snapshot.markdown === markdown || write.replaced === markdown),
    );
  }

  /** Save the active document under a path the user chooses, in the order
   *  `save` describes. `defaultPath` is the dialog's suggestion. A path for
   *  which `refuse` returns true is not written, and the save reports
   *  failure. */
  saveAs(options: { defaultPath?: string; refuse?: (path: string) => boolean } = {}): Promise<boolean> {
    return this.queueSave(this.store.get().activeTabId, true, {}, options);
  }

  /** Resolve once no save that can give a tab's document a new path is under
   *  way, with its dialog open or its file being written. That is a Save As,
   *  or a save that asks where to save an untitled document. A file pasted
   *  or dropped into the document waits for this before it is written beside
   *  it (§5.4, §5.5, `storeBesideDocument`). */
  async untilPathSettled(tabId: string): Promise<void> {
    await this.untilEnded((request) => request.tabId === tabId && (request.saveAs || request.expectedPath === null));
  }

  /** Whether a save of the tab is under way, waiting for its turn or being
   *  written. */
  isSaving(tabId: string): boolean {
    return [...this.pendingSaves].some((request) => request.tabId === tabId);
  }

  /** Resolve once no save of the tab is under way, so the document shows what
   *  its last save recorded. Saves of other tabs are not waited for. */
  async untilSaved(tabId: string): Promise<void> {
    await this.untilEnded((request) => request.tabId === tabId);
  }

  /** Resolve once no save that `matches` is under way, also one asked for
   *  while this waits, or once `signal` aborts. Resolves with whether it
   *  aborted. Saves that do not match are not waited for. */
  private async untilEnded(matches: (request: SaveRequest) => boolean, signal?: AbortSignal): Promise<boolean> {
    for (;;) {
      if (signal?.aborted) return true;
      const requests = [...this.pendingSaves].filter(matches);
      if (requests.length === 0) return false;
      if (await unlessAborted(Promise.all(requests.map((request) => request.outcome)), signal) === ABORTED) return true;
    }
  }

  /** How many saves that were to give the tab's document another file, a
   *  Save As or the save of an untitled document, have failed or been
   *  cancelled so far. A caller that compares two counts learns whether the
   *  document kept a file the user was leaving in between. */
  failedMoves(tabId: string): number {
    return this.unmoved.get(tabId) ?? 0;
  }

  /** Capture the requested buffer now, then run the save after the tab's
   *  saves before it. */
  private queueSave(
    tabId: string | null,
    saveAs: boolean,
    options: { keepTypedMark?: boolean; automatic?: (tabId: string) => boolean | Promise<boolean>; failedMovesBefore?: number } = {},
    choice: SaveAsChoice = {},
  ): Promise<boolean> {
    // The document view reports typing after a short delay. Collect it first so
    // a save right after typing writes the latest text.
    const { automatic, failedMovesBefore, ...flushOptions } = options;
    this.present.flush(flushOptions);
    const doc = this.store.get().tabs.find((tab) => tab.id === tabId)?.doc;
    if (!tabId || !doc) return Promise.resolve(false);
    // This save waits for that write, so the user learns why nothing happens.
    if ([...this.pendingSaves].some((pending) => pending.tabId === tabId && pending.slow)) this.events.slowWrite?.(tabId);
    const request: SaveRequest = { tabId, snapshot: doc, expectedPath: doc.filePath, saveAs, choice, automatic, failedMovesBefore };
    this.pendingSaves.add(request);
    // The save leaves the pending ones and counts as a failed move in one
    // step, so a caller that sees no save under way sees the count too. A
    // save queued behind the first save of an untitled document has its path
    // by now, and does not count.
    const end = (saved: boolean): void => {
      this.pendingSaves.delete(request);
      if (!saved && (request.saveAs || request.expectedPath === null)) this.countFailedMove(tabId);
    };
    const operation = (this.saveQueues.get(tabId) ?? Promise.resolve()).then(() => this.saveSnapshot(request)).then(
      (saved) => {
        end(saved);
        return saved;
      },
      (error: unknown) => {
        end(false);
        throw error;
      },
    );
    request.outcome = operation.catch(() => false);
    // A failed or cancelled operation must not prevent a subsequent save.
    const tail = operation.then(() => {}, () => {});
    this.saveQueues.set(tabId, tail);
    void tail.then(() => {
      if (this.saveQueues.get(tabId) === tail) this.saveQueues.delete(tabId);
    });
    return operation;
  }

  /** Show the Save As dialog for a save once no other one shows, and return
   *  the path chosen, which the save then claims (`chosen`). Null when the
   *  user cancels, the tab is gone or has another file by then, or `refuse`
   *  turns the path down. Throws for a path that another tab has, or that
   *  another tab's save chose and is still saving, since two tabs with one
   *  file would each take the other's reload, notice and saves for its own.
   *  The turn lasts only while a dialog shows, so a look at the disk that
   *  hangs, as on a share that stopped answering, holds up no other tab's
   *  Save As. */
  private async choosePath(request: SaveRequest, originalPath: string | null): Promise<string | null> {
    const { tabId, choice } = request;
    const picked = await this.inDialogTurn(() => saveDialog({ filters: fileFilters(originalPath), defaultPath: choice.defaultPath ?? originalPath ?? "Untitled.md" }));
    // A JSON or YAML file keeps its kind under a name chosen without an
    // extension, which can ask about replacing a file of the full name.
    const path = picked ? await this.withOwnExtension(picked, originalPath) : null;
    // Nothing waits from here to the claim, so two tabs never both claim one
    // path, also when another tab's dialog showed during the look above.
    const { tabs } = this.store.get();
    const afterDialog = tabs.find((tab) => tab.id === tabId)?.doc;
    if (!path || !afterDialog || afterDialog.filePath !== originalPath || choice.refuse?.(path)) return null;
    const name = path.split(/[\\/]/).pop();
    if (tabs.some((tab) => tab.id !== tabId && samePath(tab.doc.filePath, path))) {
      throw new Error(`“${name}” is open in another tab. Close that tab, or choose another name.`);
    }
    const open = new Set(tabs.map((tab) => tab.id));
    if ([...this.pendingSaves].some((other) => other.tabId !== tabId && open.has(other.tabId) && samePath(other.chosen ?? null, path))) {
      throw new Error(`“${name}” is being saved from another tab. Choose another name.`);
    }
    request.chosen = path;
    return path;
  }

  /** Run `show`, which shows a dialog of a Save As, once no other one shows,
   *  and resolve as it does. */
  private inDialogTurn<T>(show: () => Promise<T>): Promise<T> {
    const turn = this.dialogTurn.then(show);
    this.dialogTurn = turn.then(() => {}, () => {});
    return turn;
  }

  /** Count a save of the tab that did not move its document, and forget the
   *  counts of closed tabs. */
  private countFailedMove(tabId: string): void {
    const { tabs } = this.store.get();
    for (const id of this.unmoved.keys()) {
      if (!tabs.some((tab) => tab.id === id)) this.unmoved.delete(id);
    }
    if (tabs.some((tab) => tab.id === tabId)) this.unmoved.set(tabId, this.failedMoves(tabId) + 1);
  }

  private async saveSnapshot(request: SaveRequest): Promise<boolean> {
    const { tabId, expectedPath, saveAs, automatic, failedMovesBefore } = request;
    if (failedMovesBefore !== undefined && this.failedMoves(tabId) !== failedMovesBefore) return false;
    const current = this.store.get().tabs.find((tab) => tab.id === tabId)?.doc;
    if (!current || current.filePath !== expectedPath) return false;
    const originalPath = current.filePath;
    let path = originalPath;
    const choosePath = saveAs || !path;
    if (choosePath) path = await this.choosePath(request, originalPath);
    if (!path) return false;
    let expectedContent: string | undefined;
    if (automatic) {
      // Before the check for unsaved text, so a change on disk found while the
      // save waited stops it also for a document that is saved by now.
      if (await automatic(tabId)) return false;
      const now = this.store.get().tabs.find((tab) => tab.id === tabId)?.doc;
      if (!now || now.filePath !== originalPath) return false;
      if (!choosePath) {
        if (!now.isDirty) return true;
        if (now.savedMarkdown === null) return false;
        expectedContent = now.savedMarkdown;
      }
      request.snapshot = now;
    }
    const { snapshot } = request;
    // Until the write settles, the file may hold the old saved text or the new
    // one, so an edit back to either still counts as unsaved. A Save As to
    // another file leaves the document's own file alone, so its saved text
    // stays known, and a report of that file still compares with it.
    const previous = this.store.get().tabs.find((tab) => tab.id === tabId)?.doc.savedMarkdown ?? null;
    request.write = { path, replaced: previous };
    if (samePath(path, originalPath)) this.store.patchDocById(tabId, { savedMarkdown: null });
    // A write that does not answer, as on a network drive that went away,
    // cannot be cancelled, so the user is told that it is slow instead.
    const slow = setTimeout(() => {
      request.slow = true;
      this.events.slowWrite?.(tabId);
    }, SLOW_WRITE_MS);
    let meta: FileMeta;
    try {
      meta = await (expectedContent === undefined
        ? writeFile(path, snapshot.markdown, snapshot.eol)
        : writeFile(path, snapshot.markdown, snapshot.eol, expectedContent));
    } catch (error) {
      this.restoreSavedMarkdown(tabId, originalPath, previous);
      // Another program changed the file, which the watcher reports.
      if (expectedContent !== undefined && error instanceof Error && error.message.includes(FILE_CHANGED_ON_DISK)) return false;
      throw error;
    } finally {
      clearTimeout(slow);
      if (request.slow) {
        request.slow = false;
        this.events.slowWriteEnded?.(tabId);
      }
    }
    this.markSaved(tabId, snapshot, originalPath, path, meta);
    this.events.saved?.(tabId);
    if (choosePath) this.recordOpened(path);
    return true;
  }

  /** The path to save a document under, from the path `chosen` in a save
   *  dialog. A JSON or YAML file is told by its extension, so a name chosen
   *  without one would make the document Markdown, and its Document view
   *  would rewrite the data. Such a name gets the extension of the file the
   *  document has now, `originalPath`. Windows adds it in the dialog, and
   *  other systems return the name as typed. The dialog asked about replacing
   *  the name as typed, so this asks about a file that has the full name.
   *  Resolves null when the user keeps that file. Only a look that finds no
   *  file lets the save go on without asking. A failure of the look itself,
   *  as on a drive that does not answer, fails the save, since the file may
   *  be there (`pathExists`). The look runs outside the turn for Save As
   *  dialogs, and the question takes a turn of its own. */
  private async withOwnExtension(chosen: string, originalPath: string | null): Promise<string | null> {
    if (!originalPath || documentLanguage(originalPath) === "markdown" || extensionOf(chosen) !== "") return chosen;
    const path = `${chosen.replace(/\.$/, "")}.${extensionOf(originalPath)}`;
    if (!(await pathExists(path))) return path;
    const name = path.split(/[\\/]/).pop() ?? path;
    const replace = await this.inDialogTurn(() => ask(`“${name}” already exists. Replace it?`, { title: "Downpad", kind: "warning", okLabel: "Replace", cancelLabel: "Cancel" }));
    return replace ? path : null;
  }

  /** Apply saved metadata to its owner, keeping later edits dirty. A change on
   *  disk that was recorded while the write was pending, with a later mtime,
   *  stays the file's text. */
  private markSaved(tabId: string, snapshot: DocumentState, originalPath: string | null, path: string, { modifiedMs, sizeBytes }: FileMeta): void {
    const current = this.store.get().tabs.find((tab) => tab.id === tabId)?.doc;
    if (!current || current.filePath !== originalPath) return;
    const newerOnDisk = samePath(path, originalPath) && current.savedMarkdown !== null && current.modifiedMs > modifiedMs;
    this.store.patchDocById(
      tabId,
      newerOnDisk
        ? { isDirty: current.markdown !== current.savedMarkdown }
        : {
            filePath: path,
            isDirty: current.markdown !== snapshot.markdown || current.eol !== snapshot.eol,
            savedMarkdown: snapshot.markdown,
            modifiedMs,
            fileSize: sizeBytes,
          },
    );
    // Requests queued during Save As follow the owner's new path, retaining
    // the content each caller asked to save. A document that kept the newer
    // version on disk kept its path too.
    const kept = newerOnDisk ? originalPath : path;
    for (const pending of this.pendingSaves) {
      if (pending.tabId === tabId && pending.expectedPath === originalPath) pending.expectedPath = kept;
    }
    if (this.store.get().activeTabId === tabId) {
      this.store.set({ saveStatus: { lastSavedAt: Date.now(), autosaving: false } });
      if (!newerOnDisk && path !== originalPath) this.watch(path);
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

  /** Save or discard one tab without activating it or redirecting its save.
   *  `signal` ends the wait for saves (`prepareClose`). */
  confirmCloseTab(tabId: string, label: string, signal?: AbortSignal): Promise<CloseDecision> {
    return this.prepareClose([tabId], `"${label}" has unsaved changes. Save before closing?`, signal);
  }

  /** Prompt once and save each unsaved tab before closing all tabs or the
   *  window. `signal` ends the wait for saves (`prepareClose`). */
  confirmCloseAll(signal?: AbortSignal): Promise<CloseDecision> {
    this.present.flush();
    const n = this.store.get().tabs.filter((tab) => this.unsavedForClose(tab)).length;
    const what = n === 1 ? "1 document has" : `${n} documents have`;
    return this.prepareClose(this.store.get().tabs.map((tab) => tab.id), `${what} unsaved changes. Save before closing?`, signal);
  }

  /** Whether closing the tab asks first: while it has unsaved changes, and
   *  while a save of it is under way, which the file may not hold yet and
   *  which may never end, so the user can choose Discard. */
  private unsavedForClose(tab: Tab): boolean {
    return hasUnsavedChanges(tab) || this.isSaving(tab.id);
  }

  /** Recheck after asynchronous work, including unreported typing, dropped
   *  files and queued writes that could change what is safely saved. */
  canCloseTabs(tabIds = this.store.get().tabs.map((tab) => tab.id)): boolean {
    this.present.flush();
    const owners = new Set(tabIds);
    return !this.store.get().tabs.some((tab) => owners.has(tab.id) && hasUnsavedChanges(tab))
      && ![...this.pendingSaves].some((request) => owners.has(request.tabId));
  }

  /** Keep close saves in each tab's ordinary queue, then verify every
   *  requested tab. The saves of documents with a file are asked for
   *  together, then those of untitled documents one after another, since each
   *  shows a dialog. Cancellation or failure leaves all tabs open, including
   *  those saved first ("cancel"). A save that fails reports its failure
   *  itself through `SaveEvents.closeSaveFailed`, so the close never rejects
   *  for it. A failure while the close is under way is reported once the
   *  close ends, so its notice shows after the close's last dialog, and a
   *  later one at once. A Save As of a tab that fails or is cancelled while the
   *  close is under way leaves them open too ("cancel"), and the close's save
   *  of that tab then writes nothing. The close waits for every save of the
   *  tabs until one is known not to have saved, and then keeps them without
   *  waiting for the others, apart from the save of the untitled document
   *  whose dialog it showed. While all saves work it waits for each, which
   *  never ends for a write that does not return.
   *  Once `signal` aborts, as for a newer close that the user asked for, it
   *  stops waiting and keeps the tabs ("cancel"), and the saves go on. */
  private async prepareClose(tabIds: string[], message: string, signal?: AbortSignal): Promise<CloseDecision> {
    this.present.flush();
    const owners = new Set(tabIds);
    const ownTabs = () => this.store.get().tabs.filter((tab) => owners.has(tab.id));
    // A Save As of a tab that fails or is cancelled while the close is under
    // way leaves the document with the file the user was leaving. The close
    // then writes nothing to that file and closes nothing, as Copy file does.
    // The failed Save As shows its own error notice.
    const failedMoves = new Map(tabIds.map((id) => [id, this.failedMoves(id)]));
    if (ownTabs().some((tab) => this.unsavedForClose(tab))) {
      const choice = await confirmSaveChanges(message);
      if (choice === "cancel" || choice === "discard") return choice;
      // The native prompt can remain open while editor updates are pending.
      this.present.flush();
      const unsaved = ownTabs().filter(hasUnsavedChanges);
      // A save that fails counts as not saved, and tells the user itself
      // (`SaveEvents.closeSaveFailed`). While the close is under way, its
      // failures wait until the close ends, so their notice shows after the
      // close's last dialog. Until then a dialog can cover it, and the save of
      // an untitled document that works gives a tab another file, which
      // clears the notice bar.
      const held: (() => void)[] = [];
      let holding = true;
      let failed = false;
      let notSaved!: () => void;
      const someNotSaved = new Promise<false>((resolve) => { notSaved = () => resolve(false); });
      const closeSave = (tabId: string): Promise<boolean> => {
        const path = this.store.get().tabs.find((tab) => tab.id === tabId)?.doc.filePath ?? null;
        return this.queueSave(tabId, false, { failedMovesBefore: failedMoves.get(tabId) }).catch((error: unknown) => {
          const tell = (): void => this.events.closeSaveFailed?.(tabId, path, error);
          if (holding) held.push(tell);
          else tell();
          return false;
        }).then((saved) => {
          if (!saved) {
            failed = true;
            notSaved();
          }
          return saved;
        });
      };
      try {
        // The saves of documents with a file start together, so one that
        // does not return, as to a network drive that went away, holds up no
        // other.
        const filed = Promise.all(unsaved.filter((tab) => tab.doc.filePath !== null).map((tab) => closeSave(tab.id)));
        // Untitled documents ask where to save them, one dialog after
        // another, until one is cancelled or a save fails. The close waits
        // for each to its end, since one that works gives its tab a file,
        // which would clear a notice that showed before.
        for (const tab of unsaved.filter((tab) => tab.doc.filePath === null)) {
          if (signal?.aborted || failed) break;
          if (await unlessAborted(closeSave(tab.id), signal) !== true) return "cancel";
        }
        // Once a save is known not to have saved, the close keeps the tabs
        // without waiting for the others, such as one that does not return.
        const saved = await unlessAborted(Promise.race([filed.then((all) => !all.includes(false)), someNotSaved]), signal);
        if (saved !== true) return "cancel";
      } finally {
        holding = false;
        for (const tell of held) tell();
      }
    }
    // Another queued save may still overwrite the file after our write. Wait
    // for it as well, and reject any newer edits or pending dropped assets.
    if (await this.untilEnded((request) => owners.has(request.tabId), signal)) return "cancel";
    if (tabIds.some((id) => this.failedMoves(id) !== failedMoves.get(id))) return "cancel";
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

/** The unchanged document of `path`, as read from disk. */
function fileDocument(path: string, payload: FilePayload, frontmatterCollapsed = false): DocumentState {
  return {
    markdown: payload.content,
    filePath: path,
    eol: payload.eol,
    hadBom: payload.hadBom,
    modifiedMs: payload.modifiedMs,
    fileSize: payload.sizeBytes,
    isDirty: false,
    savedMarkdown: payload.content,
    frontmatterCollapsed,
  };
}

const ABORTED = Symbol("aborted");

/** `promise`'s value, or ABORTED once `signal` aborts first. A rejection of
 *  `promise` before that rejects. */
function unlessAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const abort = (): void => resolve(ABORTED);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Compare saved paths without merging distinct files on POSIX filesystems. */
function samePath(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return sameFilePath(a, b);
}
