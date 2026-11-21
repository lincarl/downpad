// Long-lived application services and orchestration. React owns all chrome and
// view composition; this runtime owns filesystem/editor lifecycles and exposes
// actions consumed by React components.

import type { Store } from "../state/store";
import type { EditorHost } from "../editor/EditorHost";
import { FileService, type EditorPresenter } from "../files/FileService";
import { SettingsModel } from "../settings/SettingsModel";
import { SettingsDialog } from "../settings/SettingsDialog";
import { documentLanguage, fileFilters, LANGUAGE_NAMES } from "../files/documentLanguage";
import { isElectron } from "../ipc/env";
import type { ImageStoreContext } from "../images/imageStore";
import { FindBar } from "../editor/wysiwyg/findBar";
import { RecentView } from "../home/RecentView";
import { createIpcRecentDataSource } from "../home/recentData";
import { openDialog } from "../ipc/dialogs";
import { desktopBridge } from "../ipc/bridge";
import { failureReason } from "../ipc/failureReason";
import { SnapshotScheduler } from "../recovery/snapshotScheduler";
import type { BannerState, Tab, EditorLayout } from "../state/types";
import { layoutFromDefaultView, shownLayout } from "../state/types";
import { installDocumentContextMenu } from "../shell/documentContextMenu";
import { pagePressesKeepFocus, shiftPressesAsClicks } from "../shell/pagePresses";
import { preparePrintJob } from "../print/printDocument";
import { PrintWorkspace } from "../print/PrintWorkspace";
import { installAppShortcuts } from "./installAppShortcuts";
import { StartupCoordinator } from "./StartupCoordinator";
import { DesktopEventBindings } from "./DesktopEventBindings";
import { FileDropCoordinator } from "./FileDropCoordinator";
import { SessionKeeper } from "./SessionKeeper";
import { saveDialogSettings } from "./saveDialogSettings";
import { copyActiveFile } from "./copyFile";
import { keepingPlace, PlacesBehindRecent } from "./keepingPlace";
import { clearNoticesOfOtherDocuments } from "./noticeScope";
import { SaveFailureNotice } from "./saveFailureNotice";
import { SlowSaveNotice } from "./slowSaveNotice";
import { CloseRequests } from "./closeRequests";
import { copyFormattedDocument } from "../clipboard/formattedDocument";
import { GitSync } from "../git/GitSync";

export interface AppRuntimeHosts {
  editorArea: HTMLElement;
  recentHost: HTMLElement;
  findHost: HTMLElement;
}

export interface AppRuntimeCallbacks {
  setRecentSummary(text: string): void;
}

/** The notice bar action that tries a tab's failed Document view again. */
export const RETRY_DOCUMENT_VIEW = "retry-document-view";

export class AppRuntime {
  private readonly files: FileService;
  private readonly settingsModel: SettingsModel;
  private readonly settingsDialog: SettingsDialog;
  private readonly findBar: FindBar;
  private readonly recentView: RecentView;
  private readonly scheduler: SnapshotScheduler;
  private readonly session: SessionKeeper;
  private readonly printWorkspace: PrintWorkspace;
  private readonly startup: StartupCoordinator;
  private readonly desktopEvents: DesktopEventBindings;
  private readonly fileDrops: FileDropCoordinator;
  private readonly git: GitSync;
  /** Set while a layout switch, Try again or a tab switch of this runtime
   *  runs, also while the switch waits for EditorHost to finish another change
   *  of panes, such as a reload. A layout or a tab chosen meanwhile is ignored. */
  private switchingView = false;
  /** Closes of tabs, one at a time (`CloseRequests`). */
  private readonly closeRequests = new CloseRequests();
  /** The element the document's editors show in, which the Recent view hides. */
  private readonly editorArea: HTMLElement;
  /** Where the documents were scrolled that the Recent view came over. */
  private readonly placesBehindRecent = new PlacesBehindRecent();
  /** The error notice of a failed save that the user asked for, with Save,
   *  Save as or the Save of a close prompt. */
  private readonly saveFailure: SaveFailureNotice;
  /** The notice of a write that has not answered for a while. */
  private readonly slowSave: SlowSaveNotice;
  private disposed = false;
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly store: Store,
    private readonly editorHost: EditorHost,
    hosts: AppRuntimeHosts,
    private readonly callbacks: AppRuntimeCallbacks,
  ) {
    this.editorArea = hosts.editorArea;
    this.settingsModel = new SettingsModel(store, () => this.onWysiwygConfigChanged());
    this.settingsDialog = new SettingsDialog(
      store,
      (changes) => saveDialogSettings(changes, { store, settings: this.settingsModel, git: this.git }),
    );

    // The editor presenter lets FileService flush + re-show the active document
    // after the active tab changes, without owning the editor or view state.
    const presenter: EditorPresenter = {
      flush: (options) => this.editorHost.flush(options),
      showActiveDoc: () => this.showActiveDoc(),
      reloadActiveDoc: (options) => this.reloadActiveDoc(options),
    };
    this.saveFailure = new SaveFailureNotice(store);
    this.slowSave = new SlowSaveNotice(store);
    this.cleanups.push(clearNoticesOfOtherDocuments(store));
    this.files = new FileService(store, presenter, {
      saved: (tabId) => this.saveFailure.saved(tabId),
      slowWrite: (tabId) => {
        const tab = this.store.get().tabs.find((candidate) => candidate.id === tabId);
        if (tab && !this.disposed) this.slowSave.show(tabId, tabLabel(tab));
      },
      slowWriteEnded: (tabId) => this.slowSave.takeDown(tabId),
      // A failed save of a close shows as a failed Save does, and only here,
      // since the close then keeps its tabs without failing. The notice
      // names the document by the name it has then, or, once its tab is
      // closed, as after a newer close with Discard, by the file it had when
      // the save was asked for, as `saveByUser` does.
      closeSaveFailed: (tabId, path, error) => {
        console.error("Downpad: file action failed", error);
        if (this.disposed) return;
        const tab = this.store.get().tabs.find((candidate) => candidate.id === tabId);
        this.saveFailure.show(tabId, tab ? tabLabel(tab) : fileLabel(path), error);
      },
    });
    // Image storage in the WYSIWYG view may need to save an untitled buffer
    // first (to know the attachments folder) — let it drive a save (§5.5).
    this.editorHost.setSaveHandler(() => this.files.save());
    // Double-clicking a `.md` link opens that file in a tab (§5.6); openPath
    // focuses it if already open, else opens a new tab (consistent with §5.19).
    this.editorHost.setOpenLinkHandler((path) => this.run(() => this.files.openPath(path), OPEN_FAILED));
    this.scheduler = new SnapshotScheduler(store, this.files, (tabId) => this.desktopEvents.holdSave(tabId));
    this.session = new SessionKeeper(store);
    // The find card floats over the document and searches the formatted
    // document or raw Markdown according to the active layout. Its open state
    // lives in the store so the toolbar's Find button can show as pressed.
    this.findBar = new FindBar(hosts.findHost, this.editorHost, (open) => this.store.patchFind({ open }));
    // Typing, undo or a split mirror sync can add or remove matches while the
    // card is open. The card then shows the new count.
    this.editorHost.setFindChangeHandler(() => this.findBar.syncCounts());

    // Replace the native WebView right-click menu with Downpad's own (§6.1). It
    // offers the editing commands over editable text and the document actions
    // (Copy as Markdown, Copy file, Print) everywhere, instead of the
    // browser-level entries the native menu carries. Electron supplies spelling choices for the
    // ordinary menu; Shift+right-click keeps the native editing menu (§5.14).
    this.cleanups.push(installDocumentContextMenu({
      hasDocument: () => this.documentShows(),
      print: () => void this.printActiveDocument(),
      copyMarkdown: () => void this.copyMarkdown(),
      sourceName: () => LANGUAGE_NAMES[documentLanguage(this.store.get().doc.filePath)],
      canCopyFile: () => this.canCopyFile(),
      copyFile: () => void this.copyFile(),
      canCheckSpelling: () => this.editorHost.canCheckSpelling(),
      checkSpelling: () => this.checkDocumentSpelling(),
      insertLink: (href) => this.editorHost.insertLink(href),
      reportError: (message) => this.store.set({ banner: { kind: "error", message } }),
    }));

    // A Shift+press outside the element that has focus is a plain click, so
    // it never extends the selection of an editor elsewhere, and a press on
    // the page around the editors leaves focus where it was (§5.6).
    this.cleanups.push(shiftPressesAsClicks(document.documentElement));
    this.cleanups.push(pagePressesKeepFocus(hosts.editorArea));

    this.printWorkspace = new PrintWorkspace({
      getSettings: () => this.store.get().settings,
      saveSettings: (changes) => void this.settingsModel.save(changes),
    });

    this.startup = new StartupCoordinator({
      store,
      files: this.files,
      editorHost: this.editorHost,
      settings: this.settingsModel,
      isDisposed: () => this.disposed,
    });
    this.fileDrops = new FileDropCoordinator({
      store,
      files: this.files,
      editorHost: this.editorHost,
      showActiveDoc: () => this.showActiveDoc(),
      reportFailure: (message) => {
        const banner: BannerState = { kind: "error", message };
        if (!this.disposed) this.store.set({ banner });
        return () => this.store.get().banner === banner;
      },
    });
    // Images pasted into the document view go in as the files of a drop at
    // the caret, so one that waits for a Save As never goes into a hidden or
    // rebuilt editor (§5.5).
    this.editorHost.setPasteHandler((tabId, files) => this.run(() => this.fileDrops.pasteImages(tabId, files), "Downpad could not add the pasted file."));
    this.desktopEvents = new DesktopEventBindings({
      store,
      files: this.files,
      editorHost: this.editorHost,
      scheduler: this.scheduler,
      session: this.session,
      run: (action, failure) => this.run(action, failure),
      handleDrop: (paths, drop) => this.fileDrops.handle(paths, drop),
    });

    this.git = new GitSync({
      store,
      files: this.files,
      flush: () => this.editorHost.flush(),
      discardEditors: (tabId) => this.editorHost.discardTab(tabId),
      compareWithDisk: () => this.desktopEvents.recheck(),
      fileGone: (tabId) => this.desktopEvents.fileGone(tabId),
    });

    // Recent view (§5.8). Opening a file from it shows the editor first, then
    // loads the document into it.
    this.recentView = new RecentView(
      createIpcRecentDataSource(),
      () => this.store.get().settings,
      {
        // Opening from the Recent view lands the file in its own tab (§5.19);
        // openPath flushes the current editor and re-shows the active document.
        onOpenFile: (p) => this.run(() => this.files.openPath(p), OPEN_FAILED),
        onSummaryChange: (text) => this.callbacks.setRecentSummary(text),
        pickFile: () => this.pickMarkdownFile(),
        reveal: (p) => this.reveal(p),
        copy: (text) => void navigator.clipboard.writeText(text).catch(() => {}),
      },
    );
    hosts.recentHost.append(this.recentView.element);

    void this.bootstrap();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.desktopEvents.dispose();
    this.git.dispose();
    this.startup.dispose();
    this.scheduler.stop();
    this.session.dispose();
    this.printWorkspace.close();
    this.settingsDialog.close();
    this.findBar.destroy();
    this.recentView.destroy();
    this.settingsModel.destroy();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  newDocument(): void {
    this.run(() => this.files.newDocument());
  }

  /** Report a full spelling check without changing the document or its selection. */
  private async checkDocumentSpelling(): Promise<void> {
    const tabId = this.store.get().activeTabId;
    if (!tabId) return;
    try {
      const count = await this.editorHost.checkSpelling();
      if (this.disposed || this.store.get().activeTabId !== tabId) return;
      const message = count === 0 ? "Spelling check complete. No misspellings found."
        : `Spelling check complete. ${count} possible ${count === 1 ? "misspelling" : "misspellings"} marked.`;
      this.store.set({ banner: { kind: "info", message } });
    } catch (error) {
      if (this.disposed || this.store.get().activeTabId !== tabId) return;
      this.store.set({ banner: { kind: "error", message: error instanceof Error ? error.message : "Could not check document spelling." } });
    }
  }

  openDocument(): void {
    this.run(() => this.files.openViaDialog(), OPEN_FAILED);
  }

  saveDocument(): void {
    this.run(() => this.saveByUser(false));
  }

  saveDocumentAs(): void {
    this.run(() => this.saveByUser(true));
  }

  /** Upload the active document (the toolbar's Upload). */
  uploadDocument(): void {
    void this.git.upload();
  }

  /** Get the latest version of the active document's repository. */
  getLatestDocument(): void {
    void this.git.getLatest();
  }

  /** Open a kept copy of the discarded changes of the document at
   *  `document` (Upload's menu). */
  openDiscardedCopy(document: string, copy: string): void {
    void this.git.openDiscardedCopy(document, copy);
  }

  /** Open the find card, or close it when it is open (the toolbar's Find button). */
  toggleFind(): void {
    if (this.store.get().view === "recent" || !this.store.get().activeTabId) return;
    this.findBar.toggle();
  }

  selectLayout(layout: EditorLayout): void {
    void this.setLayout(layout);
  }

  printDocument(): void {
    void this.printActiveDocument();
  }

  copyDocumentMarkdown(): void {
    void this.copyMarkdown();
  }

  /** Copy the complete document as HTML and readable plain text. */
  copyDocumentFormatted(): void {
    if (this.disposed || !this.store.get().activeTabId) return;
    void this.copyFormatted();
  }

  openSettings(): void {
    this.settingsDialog.open();
  }

  /** Toggle only the document surface. UI chrome remains controlled in Settings. */
  toggleDocumentTheme(): void {
    const current = document.documentElement.dataset.editorTheme;
    const editorTheme = current === "dark" ? "light" : "dark";
    void this.settingsModel.save({ editorTheme });
  }

  zoomDocument(delta: number): void {
    void this.adjustFontScale(delta);
  }

  showRecentView(): void {
    void this.showRecent();
  }

  activateDocumentTab(id: string): void {
    void this.activateTab(id);
  }

  closeDocumentTab(id: string): void {
    this.run(() => this.closeTab(id), CLOSE_FAILED);
  }

  closeEveryTab(): void {
    this.run(() => this.closeAllTabs(), CLOSE_FAILED);
  }

  /** Whether Copy file in the menu of the tab `tabId` can run. It needs the
   *  desktop app, and for the active tab it waits while the bar for a change
   *  on disk asks for Reload or Keep mine, as in the document's menu. Another
   *  tab comes to the front first (`copyTabFile`), and Copy file then checks
   *  it as the document that shows. */
  canCopyTabFile(tabId: string): boolean {
    const { activeTabId, banner } = this.store.get();
    return isElectron() && (tabId !== activeTabId || banner?.kind !== "file-changed") && !this.desktopEvents.isFileGone(tabId);
  }

  /** Copy file in the tab's menu (see copyFileOfTab). */
  copyTabFile(tabId: string): void {
    this.run(() => this.copyFileOfTab(tabId));
  }

  handleBannerAction(id: string): void {
    if (id === RETRY_DOCUMENT_VIEW) void this.retryDocumentView();
    else if (!this.git.handleBannerAction(id)) this.desktopEvents.handleBannerAction(id);
  }

  dismissBanner(): void {
    // The notice bar shows the app's banner, or else the active tab's Document
    // view failure (App.tsx), so dismiss whichever it shows.
    const { banner, tabs, activeTabId } = this.store.get();
    if (banner) {
      this.store.set({ banner: null });
      return;
    }
    const failure = tabs.find((tab) => tab.id === activeTabId)?.documentViewFailure;
    if (!activeTabId || !failure) return;
    this.store.setDocumentViewFailure(activeTabId, { ...failure, dismissed: true });
    // The bar remembers where focus was when it appeared, which for this notice
    // can be the clicked tab, the page body or another tab's editor. The user
    // was working in this tab's Markdown view, so continue there.
    this.editorHost.focusEditor();
  }

  revealPath(path: string): void {
    void this.reveal(path);
  }

  copyText(text: string): void {
    void navigator.clipboard.writeText(text).catch(() => {});
  }

  private async bootstrap(): Promise<void> {
    // A runtime that replaces another, as after a hot reload in development,
    // keeps the store, so startup is not finished until this one's ends.
    this.store.set({ started: false });
    // Load settings before the first mount so the editor picks up the saved
    // serializer style and default view.
    await this.settingsModel.init();
    if (this.disposed) return;

    // Open documents in the layout chosen by `defaultView` — document, the split,
    // or Markdown only (§6.1). `layoutFromDefaultView` also maps legacy values from
    // older settings files ("wysiwyg" → document, "raw" → split).
    const startLayout = layoutFromDefaultView(this.store.get().settings);
    this.store.set({ editorLayout: startLayout });
    this.editorHost.initLayout(startLayout);

    // Startup resolution (§5.15): recovery → the documents open at the last
    // close → launch arg → first-run welcome → Recent view (returning user). In
    // a plain browser (dev/e2e) keep the seed doc.
    const landOnEditor = await this.startup.resolve();
    if (this.disposed) return;
    if (landOnEditor && this.store.get().activeTabId) {
      this.store.set({ view: "wysiwyg" });
      // A launch argument or a recovered file's original was already shown by
      // openPath. A recovered snapshot, a reopened document, the welcome
      // document and the browser seed only filled the tab, so this builds it.
      await this.editorHost.showActiveDoc();
      this.files.watchActive();
    } else {
      // Returning user (or nothing to open) → Recent view, no tabs, no editor.
      await this.editorHost.unmount();
      await this.showRecent();
    }
    if (this.disposed) return;
    this.scheduler.start();
    this.session.start(this.startup.sessionToRestore);

    this.cleanups.push(this.store.subscribe((state, previous) => {
      const next = state.settings;
      const before = previous.settings;
      const scopeChanged = next.recentFilesDefaultSearch !== before.recentFilesDefaultSearch;
      if (scopeChanged || next.recentFilesKeepRemoved !== before.recentFilesKeepRemoved ||
          next.recentFilesVisibleCount !== before.recentFilesVisibleCount) {
        this.recentView.applyPreferences(scopeChanged);
      }
    }));

    // Re-apply spell check when the setting changes (no re-mount needed, §5.14).
    this.cleanups.push(this.store.select(
      (s) => s.settings.spellCheckEnabled,
      () => this.editorHost.applySpellcheck(),
    ));

    // A Save As can give the active document a file of another kind, such as
    // a Markdown document saved as JSON. Its editors then show it as that
    // kind: a file that is not Markdown as its text alone, a JSON or YAML file
    // with its own colours.
    this.cleanups.push(this.store.subscribe((state, previous) => {
      if (state.activeTabId === null || state.activeTabId !== previous.activeTabId) return;
      if (documentLanguage(state.doc.filePath) === documentLanguage(previous.doc.filePath)) return;
      void this.showAsItsKind();
    }));

    // Lowering the retained-editors limit (§5.19) evicts the now-excess panes.
    this.cleanups.push(this.store.select(
      (s) => s.settings.maxRetainedTabEditors,
      () => void this.editorHost.applyRetentionLimit(),
    ));

    this.cleanups.push(installAppShortcuts({
      store: this.store,
      isPrintOpen: () => this.printWorkspace.isOpen(),
      isFindOpen: () => this.findBar.isOpen(),
      findNext: () => this.findBar.next(),
      findPrevious: () => this.findBar.prev(),
      showFind: (mode) => this.findBar.show(mode),
      focusRecentSearch: () => this.recentView.focusSearch(),
      save: (saveAs) => this.run(() => this.saveByUser(saveAs)),
      open: () => this.run(() => this.files.openViaDialog(), OPEN_FAILED),
      create: () => this.run(() => this.files.newDocument()),
      print: () => void this.printActiveDocument(),
    }));
    this.desktopEvents.start();
    this.git.start();
    // Startup has finished. The app shell shows this as `data-started`, which
    // the Electron tests wait for before they act.
    this.store.set({ started: true });
    // First desktop launch only: offer to make Downpad the default .md app.
    void this.startup.maybePromptDefaultHandler();
  }

  /** Save the active document as the user asked, then upload it when Upload
   *  when saving is on. Autosave and the saves of a close prompt do not
   *  upload. */
  private async saveByUser(saveAs: boolean): Promise<void> {
    const { tabs, activeTabId } = this.store.get();
    const tab = tabs.find((candidate) => candidate.id === activeTabId);
    if (!tab) return;
    let saved: boolean;
    try {
      saved = await (saveAs ? this.files.saveAs() : this.files.save());
    } catch (error) {
      console.error("Downpad: file action failed", error);
      if (this.disposed) return;
      // The notice names the document by the name it has now, as a Save As
      // ahead of this save can have given it another file.
      const now = this.store.get().tabs.find((candidate) => candidate.id === tab.id) ?? tab;
      this.saveFailure.show(tab.id, tabLabel(now), error);
      return;
    }
    if (!saved) return;
    // Upload the saved document, also if another tab became active meanwhile.
    this.git.afterUserSave(this.store.get().tabs.find((candidate) => candidate.id === tab.id)?.doc.filePath ?? null);
  }

  /** Re-mount the WYSIWYG editor so changed serializer style (§5.16) or link
   *  display (§5.6) takes effect. */
  private onWysiwygConfigChanged(): void {
    // Bumps the WYSIWYG config epoch so every WYSIWYG pane (active and the hidden
    // background/other-view ones) rebuilds with the new style; a no-op for raw.
    void this.editorHost.reload();
  }

  /** Switch which editor panes are shown — document only, the split, or the
   *  text only (§6.1). A no-op with no document open or on the Recent view (the
   *  toolbar disables the control there) and when the tab already shows that
   *  layout. A tab shown in the Text view because its Document view failed
   *  tries that view again when the document or the split is chosen. A
   *  document that is not Markdown has the Text view alone, so there the
   *  choice does nothing. */
  private async setLayout(layout: EditorLayout): Promise<void> {
    if (this.switchingView) return;
    if (!this.store.get().activeTabId) return; // nothing to show
    if (this.store.get().view === "recent") return; // handled in the editor only
    if (documentLanguage(this.store.get().doc.filePath) !== "markdown") return;
    if (shownLayout(this.store.get()) === layout) return;
    await this.changePanes(async () => {
      this.store.set({ editorLayout: layout });
      await this.editorHost.setLayout(layout);
    });
  }

  /** Show the active tab again after its document became a file of another
   *  kind. An open find card then searches the editor shown afterwards. */
  private async showAsItsKind(): Promise<void> {
    const searching = this.findBar.isOpen();
    if (searching) this.editorHost.clear();
    await this.editorHost.showActiveDoc();
    if (searching && !this.disposed && this.findBar.isOpen()) this.findBar.refresh();
  }

  /** Try the active tab's Document view again (the notice's Try again). */
  private async retryDocumentView(): Promise<void> {
    if (this.switchingView) return;
    await this.changePanes(() => this.editorHost.retryDocumentView());
  }

  /** Change which of the active tab's editors are shown. An open find card
   *  then searches the editor shown afterwards. */
  private async changePanes(change: () => Promise<void>): Promise<void> {
    this.switchingView = true;
    try {
      // Clear the outgoing editor's highlights (clear acts on the current
      // layout's editor); an open find card then searches the newly shown one.
      const searching = this.findBar.isOpen();
      if (searching) this.editorHost.clear();
      await change();
      if (searching) this.findBar.refresh();
    } finally {
      this.switchingView = false;
    }
  }

  /** Open the print workspace for the active document (§5.21): Downpad's own
   *  full-window print mode, with a preview of the very sheets that will be
   *  printed and a Document / Text version choice. Replaces both the browser
   *  print dialog and the old direct window.print(). */
  private async printActiveDocument(): Promise<void> {
    if (!this.documentShows()) return; // nothing open to print, or Recent hides it
    if (this.printWorkspace.isOpen()) return;
    // Capture in-progress edits so the printed sheets are current.
    this.editorHost.flush();
    // Clone the live WYSIWYG render when one is mounted (best fidelity, mermaid
    // included); otherwise the print module renders the markdown off-screen.
    // Scoped to the active pane so a hidden tab's editor is never picked up.
    const liveNode = this.editorHost.activeWysiwygNode();
    const job = await preparePrintJob({
      markdown: this.store.get().doc.markdown,
      liveNode,
      settings: this.store.get().settings,
      context: this.imageStoreContext(),
      docTitle: fileLabel(this.store.get().doc.filePath),
      language: documentLanguage(this.store.get().doc.filePath),
    });
    if (job) this.printWorkspace.open(job);
  }

  /** Activate a tab and show its document in the editor (§5.19). */
  private async activateTab(id: string): Promise<void> {
    if (this.switchingView) return;
    const s = this.store.get();
    if (id === s.activeTabId && s.view !== "recent") return; // already showing it
    this.switchingView = true;
    try {
      this.editorHost.flush(); // preserve the outgoing tab's in-progress edits
      this.store.activateTab(id);
      await this.showActiveDoc();
    } finally {
      this.switchingView = false;
    }
  }

  /** Close a tab (§5.19), prompting if it has unsaved changes. When the last tab
   *  closes the editor is torn down and the Recent view is shown. A close of
   *  tabs asked for meanwhile takes over from this one while it waits for a
   *  save, and the tab then stays open (`CloseRequests`). */
  private closeTab(id: string): Promise<void> {
    return this.closeRequests.run(async (signal) => {
      // Collect typing the document view has not reported yet, so the unsaved
      // check below sees it.
      this.editorHost.flush();
      const tab = this.store.get().tabs.find((t) => t.id === id);
      if (!tab) return;
      const decision = await this.files.confirmCloseTab(id, tabLabel(tab), signal);
      if (this.disposed || decision === "cancel" || (decision !== "discard" && !this.files.canCloseTabs([id]))) return;
      const wasActive = this.store.get().activeTabId === id;
      const nextActive = this.store.closeTab(id);
      // A notice that the closed document's save has not finished, which can
      // show while another tab is in front, no longer helps.
      this.slowSave.takeDown(id);
      // Free the closed tab's editor pane(s) — including a background tab's, which
      // would otherwise leak since it never becomes active again to be evicted.
      await this.editorHost.discardTab(id);
      if (nextActive === null) {
        if (this.findBar.isOpen()) this.findBar.close();
        await this.editorHost.unmount();
        await this.showRecent();
      } else if (wasActive) {
        await this.showActiveDoc();
      }
    });
  }

  /** Close every open tab (tab context menu, §5.19). Prompts once if any tab has
   *  unsaved changes, then tears the editor down and shows the Recent view.
   *  Like closeTab, a close asked for meanwhile takes over while it waits for
   *  a save. */
  private closeAllTabs(): Promise<void> {
    return this.closeRequests.run(async (signal) => {
      if (this.store.get().tabs.length === 0) return;
      // Capture in-progress edits so the dirty check reflects the latest typing.
      this.editorHost.flush();
      const decision = await this.files.confirmCloseAll(signal);
      if (this.disposed || decision === "cancel" || (decision !== "discard" && !this.files.canCloseTabs())) return;
      const tabs = [...this.store.get().tabs];
      // Remove the approved documents together before asynchronous editor cleanup
      // can let another document gain unsaved edits between individual closes.
      for (const tab of tabs) {
        this.store.closeTab(tab.id);
        this.slowSave.takeDown(tab.id);
      }
      for (const tab of tabs) await this.editorHost.discardTab(tab.id);
      if (this.findBar.isOpen()) this.findBar.close();
      await this.editorHost.unmount();
      await this.showRecent();
    });
  }

  /** Show the Recent view (§5.8), refreshing its history list. */
  private async showRecent(): Promise<void> {
    if (this.store.get().view === "recent") return;
    if (this.findBar.isOpen()) this.findBar.close();
    // The hidden editor area measures as not scrolled, so its place is taken
    // now, for the tab whose editors show, which can lag behind the active one.
    this.placesBehindRecent.take(this.editorArea, this.editorHost, this.store);
    this.store.set({ view: "recent" });
    await this.recentView.refresh();
  }

  /** Show the active tab's document, revealing its cached editor when possible so
   *  undo survives (tab switch / close→neighbour / return from Recent). */
  private async showActiveDoc(): Promise<void> {
    await this.presentActiveDoc(false);
  }

  /** Show the active tab's document after its content was replaced (open / new /
   *  reload), forcing a fresh editor (undo resets). With `keepPlace`, the new
   *  editors are scrolled to where the old ones were, as for a file Git
   *  changed. With `quiet` as well, the user did not ask for the replacement
   *  at that moment, so the Recent view stays in front if it shows. Behind
   *  the Recent view nothing can be measured or scrolled, so the document
   *  gets the place it had when that view came, once it shows again
   *  (`presentActiveDoc`). */
  private async reloadActiveDoc({ keepPlace = false, quiet = false }: { keepPlace?: boolean; quiet?: boolean } = {}): Promise<void> {
    if (!keepPlace || this.store.get().view === "recent") return this.presentActiveDoc(true, quiet);
    await keepingPlace(this.editorArea, () => this.store.get().activeTabId, () => this.presentActiveDoc(true));
  }

  private async presentActiveDoc(reload: boolean, background = false): Promise<void> {
    // The find bar is bound to the editor we're about to (re)show; close it so it
    // doesn't linger with stale search state from the previous document.
    if (this.findBar.isOpen()) this.findBar.close();
    if (!background || this.store.get().view !== "recent") {
      if (this.store.get().view === "recent") this.recentView.onLeave();
      // Leaving Recent re-enters the editor; the editor host honours the persisted
      // `editorLayout` (document / split / Markdown only) when it presents.
      this.store.set({ view: "wysiwyg" });
    }
    // A document that was replaced, as by a reload, leaves the notices about
    // what it was behind. They go before its editor is built, so a notice
    // that shows meanwhile stays (`noticeScope`).
    if (reload && this.store.get().banner) this.store.set({ banner: null });
    if (reload) await this.editorHost.reloadActiveDoc();
    else await this.editorHost.showActiveDoc();
    // A document that was behind the Recent view shows again, where it was
    // scrolled when that view came.
    const inFront = (): string | null => this.store.get().activeTabId;
    if (this.store.get().view !== "recent") this.placesBehindRecent.giveBack(this.editorArea, inFront(), inFront);
    this.afterActiveDocChanged();
  }

  /** Re-point the file watcher at the active document (§5.1, §5.19). The
   *  notice for an unresolved change on disk to this document shows again,
   *  and a change made while another tab was in front shows it too. */
  private afterActiveDocChanged(): void {
    this.files.watchActive();
    this.desktopEvents.activeDocChanged();
  }

  /** Adjust the document text size (spec §5.20), persisting via settings. */
  private async adjustFontScale(delta: number): Promise<void> {
    const s = this.store.get().settings;
    const next = clampFontScale(round2(s.editorFontScale + delta));
    if (next === s.editorFontScale) return;
    await this.settingsModel.save({ editorFontScale: next });
  }

  /** Copy the active document's Markdown, including its latest edits. */
  private async copyMarkdown(): Promise<void> {
    if (!this.documentShows()) return;
    this.editorHost.flush(); // include the latest typing
    try {
      await navigator.clipboard.writeText(this.store.get().doc.markdown);
    } catch {
      // Clipboard may be unavailable outside the app shell; ignore.
    }
  }

  /** Whether a document shows, which the Recent view hides while it keeps
   *  the active tab. Print, the copies and the spelling check act on it. */
  private documentShows(): boolean {
    const { activeTabId, view } = this.store.get();
    return activeTabId !== null && view !== "recent";
  }

  /** Whether Copy file can run. It needs the desktop app and a document that
   *  shows. It also waits while the bar for a change on disk asks for Reload
   *  or Keep mine, since its save would replace the other version without
   *  asking. It waits too while the document's file is known to be gone,
   *  since its error would take the place of the notice that offers the kept
   *  copy. */
  private canCopyFile(): boolean {
    const { activeTabId, banner } = this.store.get();
    return isElectron() && this.documentShows() && banner?.kind !== "file-changed"
      && !(activeTabId !== null && this.desktopEvents.isFileGone(activeTabId));
  }

  /** Run Copy file on the active document (see copyActiveFile). */
  private copyFile(): Promise<void> {
    return copyActiveFile({
      store: this.store,
      files: this.files,
      editorHost: this.editorHost,
      desktopEvents: this.desktopEvents,
      canCopyFile: () => this.canCopyFile(),
      isDisposed: () => this.disposed,
      reportSaveFailure: (tabId, error) => {
        const tab = this.store.get().tabs.find((candidate) => candidate.id === tabId);
        if (tab) this.saveFailure.show(tabId, tabLabel(tab), error);
      },
    });
  }

  /** Run Copy file on the document of the tab `tabId`. Copy file acts on the
   *  document in front: its save, its Save As dialog, the comparison with the
   *  file that it waits for and its notices are all about that document, and
   *  a tab in back is not watched. So the tab comes to the front first, as a
   *  click on it brings it, also from the Recent view, and is compared with
   *  its file then. A tab chosen while another switch runs does not come to
   *  the front (`activateTab`), and nothing is copied then, since Copy file
   *  checks that the document shows. */
  private async copyFileOfTab(tabId: string): Promise<void> {
    await this.activateTab(tabId);
    if (this.store.get().activeTabId === tabId) await this.copyFile();
  }

  /** Flush the source pane too, so every layout copies the latest document.
   *  Only Markdown has a formatted form, so nothing else is copied. */
  private async copyFormatted(): Promise<void> {
    if (documentLanguage(this.store.get().doc.filePath) !== "markdown") return;
    try {
      this.editorHost.flush();
      const { markdown, filePath } = this.store.get().doc;
      await copyFormattedDocument(markdown, filePath);
    } catch (error) {
      console.error("Downpad: formatted copy failed", error);
      if (!this.disposed) {
        this.store.set({ banner: { kind: "error", message: "Could not copy formatted text. Please try again." } });
      }
    }
  }

  /** File picker for the Recent view's Locate action (§5.8). */
  private async pickMarkdownFile(): Promise<string | null> {
    if (!isElectron()) return null;
    const selected = await openDialog({
      multiple: false,
      filters: fileFilters(),
    }).catch(() => null);
    return typeof selected === "string" ? selected : null;
  }

  /** Reveal a file (selected) in Explorer (§5.8 row context menu). */
  private async reveal(path: string): Promise<void> {
    if (!isElectron()) return;
    try {
      await desktopBridge().revealItemInFolder(path);
    } catch {
      // ignore
    }
  }

  /** Context for image storage: settings, current path, and prompt-to-save. */
  private imageStoreContext(): ImageStoreContext {
    return {
      getSettings: () => this.store.get().settings,
      getFilePath: () => this.store.get().doc.filePath,
      requestSave: () => this.files.save(),
    };
  }

  /** Run a file action. A failure does not crash the shell, and shows as an
   *  error notice that says `failure` and then the reason the error gives. */
  private run(action: () => Promise<unknown>, failure = "Downpad could not finish that action."): void {
    if (this.disposed) return;
    action().catch((error: unknown) => {
      console.error("Downpad: file action failed", error);
      if (this.disposed) return;
      this.store.set({ banner: { kind: "error", message: `${failure} ${failureReason(error)}`.trimEnd() } });
    });
  }
}

/** What the error notice of a failed file action says before the reason. */
const OPEN_FAILED = "Downpad could not open the file.";
const CLOSE_FAILED = "Downpad could not close the document.";

/** Display label for a document: its file name, or "Untitled" when unsaved. */
function fileLabel(filePath: string | null): string {
  if (!filePath) return "Untitled";
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

/** Display label for a tab (filename, or "Untitled"). */
function tabLabel(tab: Tab): string {
  return fileLabel(tab.doc.filePath);
}

/** Document text-size bounds (spec §5.20): 60%–250% of base. */
const FONT_SCALE_MIN = 0.6;
const FONT_SCALE_MAX = 2.5;

function clampFontScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(Math.max(scale, FONT_SCALE_MIN), FONT_SCALE_MAX);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
