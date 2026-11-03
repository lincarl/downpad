// Upload and Get latest for documents in a Git repository (Git, spec). This
// service checks the active document's repository for remote changes, gets
// them without asking when nothing that is not uploaded would change, and
// otherwise tells the user: a notice when the changes combine with theirs, or
// the conflict dialog when they touch the same parts. The Git work itself
// runs in the main process (electron/git.ts).

import type { Store } from "../state/store";
import type { FileService } from "../files/FileService";
import type { BannerState, GitState, Tab } from "../state/types";
import { hasUnsavedChanges } from "../state/types";
import type { GitFileStatus, GitOpenFile, GitSyncResult } from "../ipc/contracts";
import { gitDiscard, gitGetLatest, gitPreviewCombine, gitStatus, gitUpload, keepDiscardedCopy } from "../ipc/commands";
import { isElectron } from "../ipc/env";
import { sameFilePath } from "../files/pathIdentity";
import { openConflictDialog, type ConflictDialogOptions, type ConflictChoice } from "./ConflictDialog";
import { fileName, listFiles, myVersionPath, timeAgo } from "./gitText";

/** Notice bar actions. */
export const GIT_GET_LATEST = "git-get-latest";
export const GIT_RESOLVE = "git-resolve";
export const GIT_OPEN_COPY = "git-open-copy";

/** How often Downpad looks for remote changes while a document is open. */
const CHECK_INTERVAL_MS = 2 * 60_000;
/** A check from a tab switch or window focus asks the remote at most this often. */
const MIN_FETCH_INTERVAL_MS = 60_000;

export interface GitSyncDependencies {
  store: Store;
  files: Pick<FileService, "save" | "saveAs" | "openPath" | "openBeside" | "refreshFromDisk" | "replaceFromDisk">;
  /** Collect typing that the editors have not reported yet. */
  flush(): void;
  /** Drop a background tab's editors, so they are built from its new text. */
  discardEditors(tabId: string): Promise<void>;
  /** Run a reload of the active document, keeping the reader's place. */
  keepingPlace(reload: () => Promise<void>): Promise<void>;
  /** Ask what to do about overlapping changes. Tests replace the dialog. */
  askConflict?: (options: ConflictDialogOptions) => Promise<ConflictChoice>;
}

type Action = "upload" | "get-latest";

export class GitSync {
  private started = false;
  private disposed = false;
  private readonly cleanups: Array<() => void> = [];
  /** The Upload, Get latest or conflict choice that is running. One at a time. */
  private running: Promise<void> | null = null;
  /** Work that waits for the running action to end, such as the conflict
   *  dialog that an Upload ran into. */
  private followUp: (() => Promise<void>) | null = null;
  /** Saved documents whose Upload waits for a running Git action. */
  private readonly pendingUploads = new Set<string>();
  private activity: GitState["activity"] = null;
  /** The document that `activity` is for. */
  private activityPath: string | null = null;
  private fetching = false;
  private dialogOpen = false;
  /** When each repository last asked its remote for changes. */
  private readonly lastFetch = new Map<string, number>();
  /** Remote commits whose conflict dialog a background check showed already. */
  private readonly conflictsShown = new Set<string>();
  /** The overlapping change that the notice's Resolve opens. */
  private conflict: { path: string; author: string; timeMs: number } | null = null;
  /** The copy of discarded changes that the notice's Open copy opens. */
  private discardedCopy: string | null = null;
  /** The notice this service shows, which it may replace or clear. */
  private notice: BannerState | null = null;

  constructor(private readonly deps: GitSyncDependencies) {}

  /** Check the active document now and whenever it changes, the window gets
   *  focus, or CHECK_INTERVAL_MS passes. Desktop only. */
  start(): void {
    if (this.started || this.disposed || !isElectron()) return;
    this.started = true;
    const { store } = this.deps;
    // The Recent view shows no document, so returning from it checks again.
    this.cleanups.push(store.select(
      (state) => (state.view === "recent" || !state.activeTabId ? null : state.doc.filePath),
      () => void this.check(),
    ));
    // A save changes what is not uploaded.
    this.cleanups.push(store.select((state) => state.doc.modifiedMs, () => void this.refresh()));
    const onFocus = (): void => void this.check();
    window.addEventListener("focus", onFocus);
    this.cleanups.push(() => window.removeEventListener("focus", onFocus));
    const timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.cleanups.push(() => clearInterval(timer));
    void this.check();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  /** Upload the active document: save it, then commit and push it. */
  upload(): Promise<void> {
    const path = this.activePath();
    return this.exclusive(() => this.runUpload(path, false), { wait: true });
  }

  /** Upload the document at `path`, which the user just saved, when Upload
   *  when saving is on and it is in a repository. The Upload waits for a
   *  running Git action, and still uploads that document if another tab is
   *  active by then. */
  afterUserSave(path: string | null): void {
    if (!path || !this.deps.store.get().settings.gitUploadOnSave || this.disposed) return;
    if (this.pendingUploads.has(path)) return;
    this.pendingUploads.add(path);
    void this.exclusive(async () => {
      // A save during this Upload asks for another.
      this.pendingUploads.delete(path);
      await this.runUpload(path, true);
    }, { wait: true });
  }

  /** Get latest for the active document's repository. */
  getLatest(): Promise<void> {
    const path = this.activePath();
    return this.exclusive(() => this.runGetLatest(path), { wait: true });
  }

  /** Handle a notice bar action. Returns false for actions of other notices. */
  handleBannerAction(id: string): boolean {
    if (id === GIT_GET_LATEST) {
      this.clearNotice();
      void this.getLatest();
    } else if (id === GIT_RESOLVE) {
      const conflict = this.conflict;
      this.clearNotice();
      if (conflict) void this.resolveConflict(conflict.path, conflict);
    } else if (id === GIT_OPEN_COPY) {
      const copy = this.discardedCopy;
      this.clearNotice();
      if (copy) void this.deps.files.openPath(copy).catch((error: unknown) => this.showError(errorText(error)));
    } else return false;
    return true;
  }

  // ── Checks ───────────────────────────────────────────────────────────────

  /** Show the active document's Git state at once, then ask the remote for
   *  changes when it is due, and act on them. */
  async check({ force = false }: { force?: boolean } = {}): Promise<void> {
    const path = this.activePath();
    if (!path) {
      if (this.deps.store.get().git) this.deps.store.set({ git: null });
      return;
    }
    const local = await this.refresh();
    if (!local || this.activePath() !== path || this.fetching || this.running || this.dialogOpen) return;
    const last = this.lastFetch.get(local.repositoryRoot) ?? 0;
    if (!force && Date.now() - last < MIN_FETCH_INTERVAL_MS) return;
    this.lastFetch.set(local.repositoryRoot, Date.now());
    this.fetching = true;
    let status: GitFileStatus | null;
    try {
      status = await gitStatus(path, true);
    } catch (error) {
      this.publish(path, local, errorText(error));
      return;
    } finally {
      this.fetching = false;
    }
    if (this.disposed || this.activePath() !== path) return;
    this.publish(path, status, status?.fetchError ?? null);
    if (status && !status.fetchError) await this.react(path, status);
  }

  /** Read the active document's local Git state, without asking the remote.
   *  Returns it, or null when the document is not in a usable repository. */
  private async refresh(): Promise<GitFileStatus | null> {
    const path = this.activePath();
    if (!path || this.disposed) return null;
    let status: GitFileStatus | null;
    try {
      status = await gitStatus(path, false);
    } catch (error) {
      console.error("Downpad: Git status failed", error);
      return null;
    }
    if (this.disposed || this.activePath() !== path) return null;
    const previous = this.deps.store.get().git;
    this.publish(path, status, previous && sameFilePath(previous.path, path) ? previous.problem : null);
    return status;
  }

  /** Act on remote changes that a check found. */
  private async react(path: string, status: GitFileStatus): Promise<void> {
    if (status.behind === 0) {
      this.clearNotice(GIT_GET_LATEST);
      return;
    }
    const tab = this.activeTab();
    if (!tab || tab.doc.filePath !== path) return;
    const change = status.remoteChange;
    const local = hasUnsavedChanges(tab) || status.changed || status.unuploadedCommits > 0;
    if (change && local) {
      this.deps.flush();
      const markdown = this.activeTab()?.doc.markdown ?? tab.doc.markdown;
      const preview = await gitPreviewCombine(path, markdown).catch(() => ({ clean: false }));
      if (this.disposed || this.activePath() !== path || this.running || this.dialogOpen) return;
      if (!preview.clean && status.unuploadedCommits > 0) {
        // Discarding or saving the user's version cannot take back commits
        // that another Git program made, so leave the overlap to it.
        if (!this.conflictsShown.has(change.commit)) {
          this.conflictsShown.add(change.commit);
          this.showError(
            `${change.author} changed the same parts of “${fileName(path)}” as commits that another Git program made here and did not upload. Combine them with that Git program.`,
          );
        }
      } else if (preview.clean) {
        this.showNotice({
          kind: "remote-changed",
          message: `${change.author} changed this document ${timeAgo(change.timeMs)}. Get latest to combine their changes with yours.`,
          actions: [{ id: GIT_GET_LATEST, label: "Get latest" }],
        });
      } else if (!this.conflictsShown.has(change.commit)) {
        this.conflictsShown.add(change.commit);
        await this.resolveConflict(path, change);
      } else {
        this.showConflictNotice(path, change);
      }
      return;
    }
    if (!this.deps.store.get().settings.gitAutoGetLatest) {
      if (change) {
        this.showNotice({
          kind: "remote-changed",
          message: `${change.author} changed this document ${timeAgo(change.timeMs)}.`,
          actions: [{ id: GIT_GET_LATEST, label: "Get latest" }],
        });
      }
      return;
    }
    // Nothing that is not uploaded changes, so get the latest version quietly.
    await this.exclusive(async () => {
      const result = await gitGetLatest(path, this.openFiles(), false).catch((error: unknown) => failed(error));
      await this.reloadChanged(result.changedOpenFiles);
      if (result.kind === "done") {
        this.clearNotice(GIT_GET_LATEST);
      } else if (result.kind === "failed") {
        const git = this.deps.store.get().git;
        if (git && sameFilePath(git.path, path)) this.deps.store.set({ git: { ...git, problem: result.message } });
      }
      await this.refresh();
    });
  }

  // ── Upload and Get latest ────────────────────────────────────────────────

  /** Upload the document at `path`. The toolbar's Upload saves the active
   *  document first. An Upload after a save uploads what was saved, also
   *  for a document that is no longer active. */
  private async runUpload(path: string | null, fromSave: boolean): Promise<void> {
    if (!path || !(await this.ready(path))) return;
    if (!fromSave && (!(await this.saveIfUnsaved(path)) || this.activePath() !== path)) return;
    const result = await this.during(path, "uploading", () => gitUpload(path, this.openFiles()));
    await this.finish(path, result, "upload", fromSave);
  }

  private async runGetLatest(path: string | null): Promise<void> {
    if (!path || !(await this.ready(path))) return;
    // The latest version may change the document, so its changes are saved first.
    if (!(await this.saveIfUnsaved(path))) return;
    if (this.activePath() !== path) return;
    const result = await this.during(path, "getting-latest", () => gitGetLatest(path, this.openFiles(), true));
    await this.finish(path, result, "get-latest", false);
  }

  /** Whether the document at `path` is in a usable repository. */
  private async ready(path: string): Promise<boolean> {
    const git = this.deps.store.get().git;
    if (git && sameFilePath(git.path, path)) return true;
    if (path === this.activePath()) return (await this.refresh()) !== null;
    return (await gitStatus(path, false).catch(() => null)) !== null;
  }

  /** Save the active document if it has unsaved changes. Returns false when
   *  that save was cancelled or failed. */
  private async saveIfUnsaved(path: string): Promise<boolean> {
    this.deps.flush();
    const tab = this.activeTab();
    if (!tab || tab.doc.filePath !== path) return false;
    if (!hasUnsavedChanges(tab)) return true;
    return this.deps.files.save().catch((error: unknown) => {
      this.showError(`Downpad could not save the document. ${errorText(error)}`);
      return false;
    });
  }

  /** Report the outcome of an Upload or Get latest, after reloading the open
   *  documents it changed, however it ended. */
  private async finish(path: string, result: GitSyncResult, action: Action, fromSave: boolean): Promise<void> {
    const name = fileName(path);
    await this.reloadChanged(result.changedOpenFiles);
    const active = path === this.activePath();
    switch (result.kind) {
      case "done":
        this.clearNotice();
        if (result.combinedWith) {
          this.showNotice({
            kind: "info",
            message: result.uploaded
              ? `Downpad combined ${result.combinedWith}'s changes with yours and uploaded “${name}”.`
              : `Downpad combined ${result.combinedWith}'s changes with yours. Upload to share the result.`,
          });
        }
        break;
      case "up-to-date":
        if (!fromSave) {
          this.showNotice({
            kind: "info",
            message: action === "upload" ? `“${name}” has no changes to upload.` : `“${name}” is the latest version.`,
          });
        }
        break;
      case "conflict":
        if (active) this.followUp = () => this.resolveConflict(path, result);
        else this.showError(`“${name}” is not uploaded, because ${result.author} changed the same parts of it. Show it to choose what to keep.`);
        break;
      case "blocked":
        if (result.files.some((file) => sameFilePath(file, path))) {
          // The user typed while the upload ran, and the remote changed the
          // document meanwhile. A check tells them what to do when it shows.
          if (active) this.followUp = () => this.check({ force: true });
          break;
        }
        this.showError(
          `${action === "upload" ? "Downpad cannot upload yet" : "Downpad cannot get the latest version"}, because the latest version would replace changes in ${listFiles(result.files)} that are not uploaded. Upload those changes or discard them first.`,
        );
        break;
      case "failed":
        this.showError(`${action === "upload" ? "Upload failed" : "Get latest failed"}. ${result.message}`);
        break;
    }
    await this.refresh();
  }

  // ── Conflicts ────────────────────────────────────────────────────────────

  /** Ask what to do about changes that overlap someone else's, then do it. */
  private async resolveConflict(path: string, change: { author: string; timeMs: number }): Promise<void> {
    if (this.dialogOpen || this.disposed) return;
    this.conflict = { path, author: change.author, timeMs: change.timeMs };
    this.dialogOpen = true;
    let choice: ConflictChoice;
    try {
      choice = await (this.deps.askConflict ?? openConflictDialog)({ fileName: fileName(path), author: change.author, timeMs: change.timeMs });
    } finally {
      this.dialogOpen = false;
    }
    if (this.disposed) return;
    if (choice === "later" || this.activePath() !== path) {
      this.showConflictNotice(path, change);
      return;
    }
    await this.exclusive(() => (choice === "discard" ? this.discardMine(path) : this.saveMineAs(path)));
  }

  private showConflictNotice(path: string, change: { author: string; timeMs: number }): void {
    this.conflict = { path, author: change.author, timeMs: change.timeMs };
    this.showNotice({
      kind: "remote-changed",
      message: `${change.author} changed the same parts of this document as you did.`,
      actions: [{ id: GIT_RESOLVE, label: "Resolve…" }],
    });
  }

  /** Keep a copy of the user's changes, then replace the document with the
   *  latest version. */
  private async discardMine(path: string): Promise<void> {
    this.deps.flush();
    const tab = this.activeTab();
    if (!tab || tab.doc.filePath !== path) return;
    let copy: string;
    try {
      copy = await keepDiscardedCopy(path, tab.doc.markdown);
    } catch (error) {
      this.showError(`Downpad could not keep a copy of your changes, so it did not discard them. ${errorText(error)}`);
      return;
    }
    const others = this.openFiles().filter((file) => !sameFilePath(file.path, path));
    const result = await this.during(path, "getting-latest", () => gitDiscard(path, others));
    if (result.changedOpenFiles.some((file) => sameFilePath(file, path))) {
      // The file is put back, so the tab gets it too. Text typed since the
      // last copy was kept gets a newer copy first, so no typing is lost.
      let kept = tab.doc.markdown;
      for (let attempt = 1; ; attempt++) {
        const replace = () => this.deps.files.replaceFromDisk(tab.id, path, (markdown) => markdown === kept);
        let outcome: Awaited<ReturnType<typeof replace>> = "gone";
        if (this.deps.store.get().activeTabId === tab.id) await this.deps.keepingPlace(async () => { outcome = await replace(); });
        else outcome = await replace();
        if (outcome === "stored") await this.deps.discardEditors(tab.id);
        if (outcome !== "changed") break;
        if (attempt === 5) {
          this.showError(`“${fileName(path)}” is still changing, so Downpad left your changes in it. A copy of them is kept.`);
          return;
        }
        this.deps.flush();
        const latest = this.deps.store.get().tabs.find((entry) => entry.id === tab.id)?.doc.markdown ?? kept;
        try {
          copy = await keepDiscardedCopy(path, latest);
        } catch (error) {
          this.showError(`Downpad could not keep a copy of your latest changes, so the document still shows them. ${errorText(error)}`);
          return;
        }
        kept = latest;
      }
    }
    const rest = { ...result, changedOpenFiles: result.changedOpenFiles.filter((file) => !sameFilePath(file, path)) };
    if (rest.kind !== "done") {
      await this.finish(path, rest, "get-latest", false);
      return;
    }
    await this.reloadChanged(rest.changedOpenFiles);
    this.conflict = null;
    this.discardedCopy = copy;
    this.showNotice({
      kind: "info",
      message: `Your changes to “${fileName(path)}” are discarded, and the latest version is shown. Downpad kept a copy of them.`,
      actions: [{ id: GIT_OPEN_COPY, label: "Open copy" }],
    });
    await this.refresh();
  }

  /** Save the user's version as a new file in this tab, then put the latest
   *  version of the original in the next tab. */
  private async saveMineAs(path: string): Promise<void> {
    const tab = this.activeTab();
    if (!tab || tab.doc.filePath !== path) return;
    let refused = false;
    const saved = await this.deps.files.saveAs({
      defaultPath: myVersionPath(path),
      refuse: (chosen) => (refused = sameFilePath(chosen, path)),
    }).catch((error: unknown) => {
      this.showError(`Downpad could not save your version. ${errorText(error)}`);
      return null;
    });
    if (saved === null) return;
    if (!saved) {
      if (refused) this.showError(`Choose another name than “${fileName(path)}” for your version.`);
      else this.showConflictNotice(path, this.conflict ?? { author: "Someone", timeMs: Date.now() });
      return;
    }
    const newPath = this.deps.store.get().tabs.find((entry) => entry.id === tab.id)?.doc.filePath ?? path;
    const result = await this.during(path, "getting-latest", () => gitDiscard(path, this.openFiles()));
    if (result.kind !== "done") {
      await this.finish(path, result, "get-latest", false);
      return;
    }
    await this.deps.files.openBeside(path, tab.id).catch((error: unknown) => this.showError(errorText(error)));
    await this.reloadChanged(result.changedOpenFiles);
    this.conflict = null;
    this.showNotice({
      kind: "info",
      message: `Your version is saved as “${fileName(newPath)}”. The latest “${fileName(path)}” is open in the next tab.`,
    });
    await this.refresh();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Run one Git action at a time. An action asked for while another runs
   *  waits for it with `wait`, as the user's own actions do, and is dropped
   *  otherwise, as background work is. */
  private async exclusive(action: () => Promise<void>, { wait = false }: { wait?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    if (this.running && !wait) return;
    while (this.running) await this.running;
    if (this.disposed) return;
    const run = action().catch((error: unknown) => {
      console.error("Downpad: Git action failed", error);
      this.showError(errorText(error));
    });
    this.running = run;
    try {
      await run;
    } finally {
      this.running = null;
    }
    const followUp = this.followUp;
    this.followUp = null;
    if (followUp) await followUp();
  }

  /** Show `activity` for the document at `path` while `operation` runs. */
  private async during(path: string, activity: NonNullable<GitState["activity"]>, operation: () => Promise<GitSyncResult>): Promise<GitSyncResult> {
    this.setActivity(path, activity);
    try {
      return await operation().catch((error: unknown) => failed(error));
    } finally {
      this.setActivity(path, null);
    }
  }

  private setActivity(path: string, activity: GitState["activity"]): void {
    this.activity = activity;
    this.activityPath = activity ? path : null;
    const git = this.deps.store.get().git;
    if (git && sameFilePath(git.path, path)) this.deps.store.set({ git: { ...git, activity } });
  }

  private publish(path: string, status: GitFileStatus | null, problem: string | null): void {
    const activity = this.activityPath && sameFilePath(this.activityPath, path) ? this.activity : null;
    this.deps.store.set({ git: status ? { path, status, activity, problem } : null });
  }

  /** Reload the open documents whose files a Git action changed. Documents
   *  with unsaved changes keep them; Downpad never gets changes for those. */
  private async reloadChanged(paths: readonly string[]): Promise<void> {
    const { store, files } = this.deps;
    for (const path of paths) {
      const tab = store.get().tabs.find((entry) => entry.doc.filePath === path);
      if (!tab || hasUnsavedChanges(tab)) continue;
      try {
        if (tab.id === store.get().activeTabId) {
          await this.deps.keepingPlace(() => files.openPath(path, { reload: true }));
        } else if (await files.refreshFromDisk(tab.id)) {
          await this.deps.discardEditors(tab.id);
        }
      } catch (error) {
        console.error("Downpad: could not reload a document after Get latest", error);
      }
    }
  }

  /** The open documents with a file, for the main process to reload or protect. */
  private openFiles(): GitOpenFile[] {
    this.deps.flush();
    return this.deps.store.get().tabs.flatMap((tab) =>
      tab.doc.filePath ? [{ path: tab.doc.filePath, unsaved: hasUnsavedChanges(tab) }] : [],
    );
  }

  private activeTab(): Tab | undefined {
    const { tabs, activeTabId } = this.deps.store.get();
    return tabs.find((tab) => tab.id === activeTabId);
  }

  /** The active document's file, or null on the Recent view or for an untitled document. */
  private activePath(): string | null {
    const { view, activeTabId, doc } = this.deps.store.get();
    if (this.disposed || view === "recent" || !activeTabId) return null;
    return doc.filePath;
  }

  /** Show a notice, unless another part of the app shows one of its own. */
  private showNotice(banner: BannerState): void {
    const current = this.deps.store.get().banner;
    if (current && current !== this.notice && current.kind !== "info") return;
    this.notice = banner;
    this.deps.store.set({ banner });
  }

  private showError(message: string): void {
    this.notice = { kind: "error", message };
    this.deps.store.set({ banner: this.notice });
  }

  /** Remove this service's notice, or only one that offers `action`. */
  private clearNotice(action?: string): void {
    const current = this.deps.store.get().banner;
    if (!current || current !== this.notice) return;
    if (action && !current.actions?.some((entry) => entry.id === action)) return;
    this.notice = null;
    this.deps.store.set({ banner: null });
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failed(error: unknown): GitSyncResult {
  return { kind: "failed", message: errorText(error), changedOpenFiles: [] };
}
