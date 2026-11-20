// Upload and Get latest for documents in a Git repository (Git, spec). This
// service checks the active document's repository for remote changes, gets
// them without asking when nothing that is not uploaded would change, and
// otherwise tells the user: a notice when the changes combine with theirs, or
// the conflict dialog when they touch the same parts. It also lists the kept
// copies of the active document's discarded changes for Upload's menu. The
// Git work itself runs in the main process (electron/git.ts).

import type { Store } from "../state/store";
import type { FileService } from "../files/FileService";
import type { BannerState, GitState, Tab } from "../state/types";
import { hasUnsavedChanges } from "../state/types";
import type { DiscardedCopy, GitFileStatus, GitOpenFile, GitSyncResult } from "../ipc/contracts";
import {
  gitDiscard,
  gitGetLatest,
  gitPreviewCombine,
  gitStatus,
  gitUpload,
  keepDiscardedCopy,
  listDiscardedCopies,
  pathExists,
} from "../ipc/commands";
import { isElectron } from "../ipc/env";
import { failureReason } from "../ipc/failureReason";
import { sameFilePath } from "../files/pathIdentity";
import { openConflictDialog, type ConflictDialogOptions, type ConflictChoice } from "./ConflictDialog";
import { fileName, listFiles, myVersionPath, timeAgo } from "./gitText";
import { formatGitError } from "./gitErrors";

/** Notice bar actions. */
export const GIT_GET_LATEST = "git-get-latest";
export const GIT_RESOLVE = "git-resolve";
export const GIT_OPEN_COPY = "git-open-copy";

/** The notice action that opens the kept copy of discarded changes. */
const OPEN_COPY = { id: GIT_OPEN_COPY, label: "Open copy" };

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
  /** Read the file of the document in front now, and show the notice for a
   *  change on disk if it differs from the document. */
  compareWithDisk(): Promise<void>;
  fileGone(tabId: string): void;
  /** Ask what to do about overlapping changes. Tests replace the dialog. */
  askConflict?: (options: ConflictDialogOptions) => Promise<ConflictChoice>;
}

type Action = "upload" | "get-latest";

export class GitSync {
  private started = false;
  private disposed = false;
  private readonly cleanups: Array<() => void> = [];
  /** Disable invalidates unfinished checks, actions and queued requests. */
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
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
  /** The copy of discarded changes that the notice's Open copy opens, and
   *  the document whose changes it holds. */
  private discardedCopy: { document: string; copy: string } | null = null;
  /** The notice this service shows, which it may replace or clear. */
  private notice: BannerState | null = null;

  constructor(private readonly deps: GitSyncDependencies) {}

  /** Check the active document now and whenever it changes, the window gets
   *  focus, or CHECK_INTERVAL_MS passes. Desktop only. */
  start(): void {
    if (this.started || this.disposed || !isElectron()) return;
    this.started = true;
    const { store } = this.deps;
    this.cleanups.push(store.select((state) => state.settings.gitEnabled, () => this.configure()));
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
    this.configure();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    if (this.timer !== null) clearInterval(this.timer);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  /** Restart checks when Git is enabled and discard work from the old setting. */
  private configure(): void {
    this.generation++;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.fetching = false;
    this.followUp = null;
    this.pendingUploads.clear();
    this.lastFetch.clear();
    this.conflictsShown.clear();
    this.conflict = null;
    this.discardedCopy = null;
    this.activity = null;
    this.activityPath = null;
    this.clearNotice();
    if (this.deps.store.get().git) this.deps.store.set({ git: null });
    if (!this.enabled()) return;
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    void this.check();
  }

  /** Upload the active document: save it, then commit and push it. */
  upload(): Promise<void> {
    const path = this.activePath();
    return this.exclusive((generation) => this.runUpload(path, false, generation), { wait: true });
  }

  /** Upload the document at `path`, which the user just saved, when Upload
   *  when saving is on and it is in a repository. The Upload waits for a
   *  running Git action, and still uploads that document if another tab is
   *  active by then. */
  afterUserSave(path: string | null): void {
    if (!path || !this.deps.store.get().settings.gitUploadOnSave || !this.enabled()) return;
    if (this.pendingUploads.has(path)) return;
    this.pendingUploads.add(path);
    void this.exclusive(async (generation) => {
      // A save during this Upload asks for another.
      this.pendingUploads.delete(path);
      await this.runUpload(path, true, generation);
    }, { wait: true });
  }

  /** Get latest for the active document's repository. */
  getLatest(): Promise<void> {
    const path = this.activePath();
    return this.exclusive((generation) => this.runGetLatest(path, generation), { wait: true });
  }

  /** Handle a notice bar action. Returns false for actions of other notices. */
  handleBannerAction(id: string): boolean {
    if (!this.enabled()) return [GIT_GET_LATEST, GIT_RESOLVE, GIT_OPEN_COPY].includes(id);
    if (id === GIT_GET_LATEST) {
      this.clearNotice();
      void this.getLatest();
    } else if (id === GIT_RESOLVE) {
      const conflict = this.conflict;
      this.clearNotice();
      if (conflict) void this.resolveConflict(conflict.path, conflict);
    } else if (id === GIT_OPEN_COPY) {
      const kept = this.discardedCopy;
      this.clearNotice();
      if (kept) void this.openDiscardedCopy(kept.document, kept.copy);
    } else return false;
    return true;
  }

  /** Open `copy`, a kept copy of the discarded changes of the document at
   *  `document`, in a tab. Downpad first lists the document's copies again,
   *  so it never opens one it no longer keeps, such as one older than 30
   *  days, and says so instead. */
  async openDiscardedCopy(document: string, copy: string): Promise<void> {
    const generation = this.generation;
    if (!this.enabled()) return;
    const copies = await listDiscardedCopies(document).catch(() => null);
    if (!this.isCurrent(generation)) return;
    if (copies) {
      this.publishCopies(document, copies);
      if (!copies.some((entry) => sameFilePath(entry.path, copy))) {
        this.showError("This copy of your discarded changes is gone. Downpad keeps such copies for 30 days.");
        return;
      }
    }
    await this.deps.files.openPath(copy).catch((error: unknown) => {
      if (this.isCurrent(generation)) this.showError(errorText(error));
    });
  }

  // ── Checks ───────────────────────────────────────────────────────────────

  /** Show the active document's Git state at once, then ask the remote for
   *  changes when it is due, and act on them. */
  async check({ force = false }: { force?: boolean } = {}): Promise<void> {
    const generation = this.generation;
    const path = this.activePath();
    if (!path) {
      if (this.deps.store.get().git) this.deps.store.set({ git: null });
      return;
    }
    const local = await this.refresh(generation);
    if (!local || !this.isCurrent(generation) || this.activePath() !== path || this.fetching || this.running || this.dialogOpen) return;
    const last = this.lastFetch.get(local.repositoryRoot) ?? 0;
    if (!force && Date.now() - last < MIN_FETCH_INTERVAL_MS) return;
    this.lastFetch.set(local.repositoryRoot, Date.now());
    this.fetching = true;
    let status: GitFileStatus | null;
    try {
      status = await gitStatus(path, true);
    } catch (error) {
      if (this.isCurrent(generation) && this.activePath() === path) this.publish(path, local, formatGitError(error));
      return;
    } finally {
      if (this.isCurrent(generation)) this.fetching = false;
    }
    if (!this.isCurrent(generation) || this.activePath() !== path) return;
    this.publish(path, status, status?.fetchError ?? null);
    if (status && !status.fetchError) await this.react(path, status, generation);
  }

  /** Read the active document's local Git state, without asking the remote,
   *  and the kept copies of its discarded changes. Returns the state, or null
   *  when the document is not in a usable repository. */
  private async refresh(generation = this.generation): Promise<GitFileStatus | null> {
    const path = this.activePath();
    if (!path || !this.isCurrent(generation)) return null;
    let status: GitFileStatus | null;
    let copies: DiscardedCopy[] | undefined;
    try {
      // A list that cannot be read keeps the copies listed before.
      [status, copies] = await Promise.all([gitStatus(path, false), listDiscardedCopies(path).catch(() => undefined)]);
    } catch (error) {
      console.error("Downpad: Git status failed", error);
      return null;
    }
    if (!this.isCurrent(generation) || this.activePath() !== path) return null;
    const previous = this.deps.store.get().git;
    this.publish(path, status, previous && sameFilePath(previous.path, path) ? previous.problem : null, copies);
    return status;
  }

  /** Act on remote changes that a check found. */
  private async react(path: string, status: GitFileStatus, generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
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
      if (!this.isCurrent(generation) || this.activePath() !== path || this.running || this.dialogOpen) return;
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
      if (!this.isCurrent(generation)) return;
      if (result.kind === "done") {
        this.clearNotice(GIT_GET_LATEST);
      } else if (result.kind === "failed") {
        const git = this.deps.store.get().git;
        if (git && sameFilePath(git.path, path)) this.deps.store.set({ git: { ...git, problem: result.message } });
      }
      await this.refresh(generation);
    });
  }

  // ── Upload and Get latest ────────────────────────────────────────────────

  /** Upload the document at `path`. The toolbar's Upload saves the active
   *  document first. An Upload after a save uploads what was saved, also
   *  for a document that is no longer active. */
  private async runUpload(path: string | null, fromSave: boolean, generation: number): Promise<void> {
    if (!path || !(await this.ready(path, generation))) return;
    if (!fromSave && (!(await this.saveIfUnsaved(path, generation)) || this.activePath() !== path)) return;
    const result = await this.during(path, "uploading", () => gitUpload(path, this.openFiles()), generation);
    if (result) await this.finish(path, result, "upload", fromSave, generation);
  }

  private async runGetLatest(path: string | null, generation: number): Promise<void> {
    if (!path || !(await this.ready(path, generation))) return;
    // The latest version may change the document, so its changes are saved first.
    if (!(await this.saveIfUnsaved(path, generation))) return;
    if (this.activePath() !== path) return;
    const result = await this.during(path, "getting-latest", () => gitGetLatest(path, this.openFiles(), true), generation);
    if (result) await this.finish(path, result, "get-latest", false, generation);
  }

  /** Whether the document at `path` is in a usable repository. */
  private async ready(path: string, generation: number): Promise<boolean> {
    if (!this.isCurrent(generation)) return false;
    const git = this.deps.store.get().git;
    if (git && sameFilePath(git.path, path)) return true;
    if (path === this.activePath()) return (await this.refresh(generation)) !== null;
    const status = await gitStatus(path, false).catch(() => null);
    return this.isCurrent(generation) && status !== null;
  }

  /** Save the active document if it has unsaved changes. Returns false when
   *  that save was cancelled or failed. */
  private async saveIfUnsaved(path: string, generation: number): Promise<boolean> {
    if (!this.isCurrent(generation)) return false;
    this.deps.flush();
    const tab = this.activeTab();
    if (!tab || tab.doc.filePath !== path) return false;
    if (!hasUnsavedChanges(tab)) return true;
    return this.deps.files.save().catch((error: unknown) => {
      if (this.isCurrent(generation)) this.showError(`Downpad could not save the document. ${errorText(error)}`);
      return false;
    });
  }

  /** Report the outcome of an Upload or Get latest, after reloading the open
   *  documents it changed, however it ended. `lead` goes before a failure,
   *  to say what happened before it, and `actions` go with it. */
  private async finish(
    path: string,
    result: GitSyncResult,
    action: Action,
    fromSave: boolean,
    generation: number,
    { lead = "", actions }: { lead?: string; actions?: BannerState["actions"] } = {},
  ): Promise<void> {
    const name = fileName(path);
    await this.reloadChanged(result.changedOpenFiles);
    if (!this.isCurrent(generation)) return;
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
        else this.showError(`“${name}” is not uploaded, because ${result.author} changed the same parts of it. Show it to choose what to keep.`, actions);
        break;
      case "blocked":
        if (result.files.some((file) => sameFilePath(file, path))) {
          // The user typed while the upload ran, and the remote changed the
          // document meanwhile. A check tells them what to do when it shows.
          if (active) this.followUp = () => this.check({ force: true });
          break;
        }
        this.showError(
          `${lead}${action === "upload" ? "Downpad cannot upload yet" : "Downpad cannot get the latest version"}, because the latest version would replace changes in ${listFiles(result.files)} that are not uploaded. Upload those changes or discard them first.`,
          actions,
        );
        break;
      case "failed":
        this.showError(`${lead}${action === "upload" ? "Upload failed" : "Get latest failed"}. ${result.message}`, actions);
        break;
    }
    await this.refresh(generation);
  }

  // ── Conflicts ────────────────────────────────────────────────────────────

  /** Ask what to do about changes that overlap someone else's, then do it. */
  private async resolveConflict(path: string, change: { author: string; timeMs: number }): Promise<void> {
    const generation = this.generation;
    if (this.dialogOpen || !this.isCurrent(generation)) return;
    this.conflict = { path, author: change.author, timeMs: change.timeMs };
    this.dialogOpen = true;
    let choice: ConflictChoice;
    try {
      choice = await (this.deps.askConflict ?? openConflictDialog)({ fileName: fileName(path), author: change.author, timeMs: change.timeMs });
    } finally {
      this.dialogOpen = false;
    }
    if (!this.isCurrent(generation)) {
      if (this.enabled()) void this.check();
      return;
    }
    if (choice === "later" || this.activePath() !== path) {
      this.showConflictNotice(path, change);
      return;
    }
    await this.exclusive((generation) => (choice === "discard" ? this.discardMine(path, generation) : this.saveMineAs(path, generation)));
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
   *  latest version. The notice then says where the latest version is as it
   *  shows, since another tab can be in front by then, and that Upload's menu
   *  offers the copy. A latest version without the document's file, as after
   *  a collaborator deleted or renamed it, leaves the user's text in the tab,
   *  and the notice says so, and how to keep it: with Save, or with Save as
   *  when the file's folder is gone too. */
  private async discardMine(path: string, generation: number): Promise<void> {
    this.deps.flush();
    const tab = this.activeTab();
    if (!tab || tab.doc.filePath !== path) return;
    let copy: string;
    try {
      copy = await keepDiscardedCopy(path, tab.doc.markdown);
    } catch (error) {
      if (this.isCurrent(generation)) this.showError(`Downpad could not keep a copy of your changes, so it did not discard them. ${errorText(error)}`);
      return;
    }
    const others = this.openFiles().filter((file) => !sameFilePath(file.path, path));
    const result = await this.during(path, "getting-latest", () => gitDiscard(path, others), generation);
    if (!result) return;
    const name = fileName(path);
    const discarded = result.changedOpenFiles.some((file) => sameFilePath(file, path));
    // When a collaborator deleted or renamed the file, the latest version has
    // no such file, so nothing can take the place of the user's text, and the
    // tab keeps it. A look that fails counts as a file, whose read then says
    // what is wrong.
    const missing = discarded && !(await pathExists(path).catch(() => true));
    // The text of the copy that `copy` names.
    let kept = tab.doc.markdown;
    if (missing) {
      // No file holds the tab's text any more, so the document counts as
      // unsaved with no saved text known. Closing it then asks first, and
      // autosave, which only writes over a version it knows, does not put the
      // file back by itself. Only a save the user asks for does.
      this.deps.flush();
      const holder = this.deps.store.get().tabs.find((entry) => entry.id === tab.id && entry.doc.filePath !== null && sameFilePath(entry.doc.filePath, path));
      if (holder) {
        this.deps.store.patchDocById(tab.id, { isDirty: true, savedMarkdown: null });
        // Git put the committed file back before it took the file away, and
        // the watcher can have told of that version. Its bar would ask about
        // a file that is gone, and would keep the notice below from showing.
        this.deps.fileGone(tab.id);
        // Text typed while Git worked gets a newer copy, which Open copy
        // then opens. When it cannot be kept, Open copy opens the copy kept
        // before, and the tab, which still has all the text, as unsaved,
        // keeps what the copy lacks, so the rest goes on as it would.
        if (holder.doc.markdown !== kept) {
          try {
            copy = await keepDiscardedCopy(path, holder.doc.markdown);
            kept = holder.doc.markdown;
          } catch (error) {
            console.error("Downpad: could not keep a newer copy of the discarded changes", error);
          }
        }
      }
    }
    // Whether the document's tab took the file that Git put back. It did not
    // when the tab was closed or got another file meanwhile.
    let tookFile = false;
    if (discarded && !missing) {
      // The file is put back, so the tab gets it too. Text typed since the
      // last copy was kept gets a newer copy first, so no typing is lost.
      for (let attempt = 1; ; attempt++) {
        const outcome = await this.deps.files.replaceFromDisk(tab.id, path, (markdown) => markdown === kept);
        if (outcome === "stored") await this.deps.discardEditors(tab.id);
        if (outcome !== "changed") {
          tookFile = outcome !== "gone";
          break;
        }
        if (attempt === 5) {
          if (this.isCurrent(generation)) this.showError(`“${name}” is still changing, so Downpad left your changes in it. Upload's menu also offers a copy of them for 30 days.`);
          return;
        }
        this.deps.flush();
        const latest = this.deps.store.get().tabs.find((entry) => entry.id === tab.id)?.doc.markdown ?? kept;
        try {
          copy = await keepDiscardedCopy(path, latest);
        } catch (error) {
          if (this.isCurrent(generation)) this.showError(`Downpad could not keep a copy of your latest changes, so the document still shows them. ${errorText(error)}`);
          return;
        }
        kept = latest;
      }
    }
    const rest = { ...result, changedOpenFiles: result.changedOpenFiles.filter((file) => !sameFilePath(file, path)) };
    if (rest.kind !== "done") {
      // Git put the file back to its last commit but could not get the
      // latest version, so the failure says that the changes are gone too.
      // Git takes a file away here only when the last commit lacks it, to
      // make room for the latest version.
      let lead = discarded ? `Your changes to “${name}” are discarded, and Upload's menu offers a copy of them for 30 days. ` : "";
      if (missing) {
        // Upload's menu needs the file, so the notice offers the copy.
        lead = `“${name}” is no longer on disk, and Downpad kept a copy of your changes. `;
        this.discardedCopy = { document: path, copy };
      }
      await this.finish(path, rest, "get-latest", false, generation, { lead, actions: missing ? [OPEN_COPY] : undefined });
      return;
    }
    await this.reloadChanged(rest.changedOpenFiles);
    if (!this.isCurrent(generation)) return;
    // Save cannot put the file back in a folder that is gone too, as after a
    // collaborator renamed the folder. A look that fails counts as a folder
    // that exists.
    const folderGone = missing && !(await pathExists(path.slice(0, path.length - name.length)).catch(() => true));
    if (!this.isCurrent(generation)) return;
    this.conflict = null;
    this.discardedCopy = { document: path, copy };
    // Where the latest version is now, since the user can have shown another
    // tab, or the document's tab again, while the other documents reloaded.
    const { tabs, activeTabId, view } = this.deps.store.get();
    const holder = tabs.find((entry) => entry.id === tab.id && entry.doc.filePath !== null && sameFilePath(entry.doc.filePath, path));
    let message = `Your changes to “${name}” are discarded. Upload's menu offers a copy of them for 30 days while “${name}” is in front.`;
    if (missing) {
      // Upload's menu needs the file, so the notice offers the copy alone.
      message = `“${name}” is not in the latest version, because someone deleted or renamed it. Open copy shows the copy of your changes that Downpad kept.`;
      if (holder && folderGone) {
        message = `“${name}” and its folder are not in the latest version, because someone deleted or renamed them. Its tab still has your changes, which no file holds now. Use Save as to keep them in a file, or close the tab to leave them out. Open copy shows the copy that Downpad kept.`;
      } else if (holder) {
        message = `“${name}” is not in the latest version, because someone deleted or renamed it. Its tab still has your changes, which no file holds now. Save to put the file back with them, or close the tab to leave it out. Open copy shows the copy that Downpad kept.`;
      }
    } else if (tookFile && holder && activeTabId === holder.id && view !== "recent") {
      message = `Your changes to “${name}” are discarded, and the latest version is shown. Upload's menu offers a copy of them for 30 days.`;
    } else if (tookFile && holder) {
      message = `Your changes to “${name}” are discarded, and its tab has the latest version. Upload's menu offers a copy of them for 30 days while “${name}” is in front.`;
    }
    this.showNotice({ kind: "info", message, actions: [OPEN_COPY] });
    await this.refresh(generation);
  }

  /** Save the user's version as a new file in this tab, then put the latest
   *  version of the original in the next tab. The notice says that the
   *  version is saved, and whether the latest version is open, has no such
   *  file or could not be opened. */
  private async saveMineAs(path: string, generation: number): Promise<void> {
    const tab = this.activeTab();
    if (!tab || tab.doc.filePath !== path) return;
    let refused = false;
    const saved = await this.deps.files.saveAs({
      defaultPath: myVersionPath(path),
      refuse: (chosen) => (refused = sameFilePath(chosen, path)),
    }).catch((error: unknown) => {
      if (this.isCurrent(generation)) this.showError(`Downpad could not save your version. ${errorText(error)}`);
      return null;
    });
    if (saved === null || !this.isCurrent(generation)) return;
    if (!saved) {
      if (refused) this.showError(`Choose another name than “${fileName(path)}” for your version.`);
      else this.showConflictNotice(path, this.conflict ?? { author: "Someone", timeMs: Date.now() });
      return;
    }
    const newPath = this.deps.store.get().tabs.find((entry) => entry.id === tab.id)?.doc.filePath ?? path;
    const result = await this.during(path, "getting-latest", () => gitDiscard(path, this.openFiles()), generation);
    if (!result) return;
    if (result.kind !== "done") {
      await this.finish(path, result, "get-latest", false, generation);
      return;
    }
    // When a collaborator deleted or renamed the file, the latest version has
    // none to open. A look that fails counts as a file, whose read then says
    // what is wrong.
    const missing = !(await pathExists(path).catch(() => true));
    let openFailure: string | null = null;
    if (!missing) {
      try {
        await this.deps.files.openBeside(path, tab.id);
      } catch (error) {
        // A plain reason for the read, without Electron's text about IPC.
        openFailure = failureReason(error);
      }
    }
    await this.reloadChanged(result.changedOpenFiles);
    if (!this.isCurrent(generation)) return;
    this.conflict = null;
    const savedAs = `Your version is saved as “${fileName(newPath)}”`;
    if (openFailure !== null) {
      this.showError(`${savedAs}, but Downpad could not open the latest “${fileName(path)}”. ${openFailure}`);
    } else {
      this.showNotice({
        kind: "info",
        message: missing
          ? `${savedAs}. “${fileName(path)}” is not in the latest version, because someone deleted or renamed it.`
          : `${savedAs}. The latest “${fileName(path)}” is open in the next tab.`,
      });
    }
    await this.refresh(generation);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Run one Git action at a time. An action asked for while another runs
   *  waits for it with `wait`, as the user's own actions do, and is dropped
   *  otherwise, as background work is. */
  private async exclusive(action: (generation: number) => Promise<void>, { wait = false }: { wait?: boolean } = {}): Promise<void> {
    const generation = this.generation;
    if (!this.isCurrent(generation)) return;
    if (this.running && !wait) return;
    while (this.running) {
      await this.running;
      if (!this.isCurrent(generation)) return;
    }
    if (!this.isCurrent(generation)) return;
    const run = action(generation).catch((error: unknown) => {
      console.error("Downpad: Git action failed", error);
      if (this.isCurrent(generation)) this.showError(formatGitError(error));
    });
    this.running = run;
    try {
      await run;
    } finally {
      this.running = null;
    }
    if (!this.isCurrent(generation)) {
      // A reenabled service can fetch once the old file operation finishes.
      if (this.enabled()) void this.check();
      return;
    }
    const followUp = this.followUp;
    this.followUp = null;
    if (followUp) await followUp();
  }

  /** Show `activity` for the document at `path` while `operation` runs. */
  private async during(path: string, activity: NonNullable<GitState["activity"]>, operation: () => Promise<GitSyncResult>, generation: number): Promise<GitSyncResult | null> {
    if (!this.isCurrent(generation)) return null;
    this.setActivity(path, activity);
    try {
      if (!this.isCurrent(generation)) return null;
      return await operation().catch((error: unknown) => failed(error));
    } finally {
      if (this.isCurrent(generation)) this.setActivity(path, null);
    }
  }

  private setActivity(path: string, activity: GitState["activity"]): void {
    this.activity = activity;
    this.activityPath = activity ? path : null;
    const git = this.deps.store.get().git;
    if (git && sameFilePath(git.path, path)) this.deps.store.set({ git: { ...git, activity } });
  }

  /** Publish the Git state of the document at `path`. Without `copies`, it
   *  keeps the copies of discarded changes listed for that document. */
  private publish(path: string, status: GitFileStatus | null, problem: string | null, copies?: DiscardedCopy[]): void {
    const activity = this.activityPath && sameFilePath(this.activityPath, path) ? this.activity : null;
    const previous = this.deps.store.get().git;
    const discardedCopies = copies ?? (previous && sameFilePath(previous.path, path) ? previous.discardedCopies : []);
    this.deps.store.set({ git: status ? { path, status, activity, problem, discardedCopies } : null });
  }

  /** Show `copies` in Upload's menu while it is the menu of `document`. */
  private publishCopies(document: string, copies: DiscardedCopy[]): void {
    const git = this.deps.store.get().git;
    if (git && sameFilePath(git.path, document)) this.deps.store.set({ git: { ...git, discardedCopies: copies } });
  }

  /** Reload the open documents whose files a Git action changed. Documents
   *  with unsaved changes keep them; Downpad never gets changes for those.
   *  That holds also for text typed in the document in front while its file
   *  is read, which the notice for a change on disk then asks about. */
  private async reloadChanged(paths: readonly string[]): Promise<void> {
    const { store, files } = this.deps;
    for (const path of paths) {
      const tab = store.get().tabs.find((entry) => entry.doc.filePath !== null && sameFilePath(entry.doc.filePath, path));
      if (!tab) continue;
      if (hasUnsavedChanges(tab)) {
        // Text typed after Git checked the documents keeps the document, and
        // the notice for a change on disk asks about the file at once.
        if (tab.id === store.get().activeTabId) await this.deps.compareWithDisk().catch(() => {});
        continue;
      }
      try {
        if (tab.id === store.get().activeTabId) {
          const text = tab.doc.markdown;
          const outcome = await files.replaceFromDisk(tab.id, path, (markdown) => markdown === text, { quiet: true });
          // A tab that went behind another one during the read took the file
          // without its editors, which still show the old text.
          if (outcome === "stored") await this.deps.discardEditors(tab.id);
          // A document that kept text typed meanwhile differs from its file
          // now. The notice asks about it at once, without waiting for the
          // watcher, which does not see every file, such as a link's target.
          if (outcome === "changed" && store.get().activeTabId === tab.id) await this.deps.compareWithDisk();
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
    if (!this.enabled() || view === "recent" || !activeTabId) return null;
    return doc.filePath;
  }

  /** Show a notice, unless another part of the app shows one of its own. */
  private showNotice(banner: BannerState): void {
    if (!this.enabled()) return;
    const current = this.deps.store.get().banner;
    if (current && current !== this.notice && current.kind !== "info") return;
    this.notice = banner;
    this.deps.store.set({ banner });
  }

  private showError(message: string, actions?: BannerState["actions"]): void {
    if (!this.enabled()) return;
    this.notice = actions ? { kind: "error", message, actions } : { kind: "error", message };
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

  /** Whether new Git work is allowed by the current setting and lifecycle. */
  private enabled(): boolean {
    return !this.disposed && this.deps.store.get().settings.gitEnabled;
  }

  /** Whether async work still belongs to the current enabled session. */
  private isCurrent(generation: number): boolean {
    return generation === this.generation && this.enabled();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failed(error: unknown): GitSyncResult {
  return { kind: "failed", message: formatGitError(error), changedOpenFiles: [] };
}
