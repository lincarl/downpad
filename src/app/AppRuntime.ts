// Long-lived application services and orchestration. React owns all chrome and
// view composition; this runtime owns filesystem/editor lifecycles and exposes
// actions consumed by React components.

import type { Store } from "../state/store";
import type { EditorHost } from "../editor/EditorHost";
import { FileService, type EditorPresenter } from "../files/FileService";
import { SettingsModel } from "../settings/SettingsModel";
import { SettingsDialog } from "../settings/SettingsDialog";
import { readImageBytes, writeAttachment } from "../ipc/commands";
import { isElectron } from "../ipc/env";
import { classifyDrop, baseName } from "../paste/dropHandler";
import { mdLink, mdImage } from "../paste/mdLink";
import { resolveImageSrc, type ImageStoreContext } from "../images/imageStore";
import { FindBar } from "../editor/wysiwyg/findBar";
import { RecentView } from "../home/RecentView";
import { createIpcRecentDataSource } from "../home/recentData";
import { openDialog } from "../ipc/dialogs";
import { desktopBridge } from "../ipc/bridge";
import { SnapshotScheduler } from "../recovery/snapshotScheduler";
import type { Tab, EditorLayout } from "../state/types";
import { layoutFromDefaultView } from "../state/types";
import { installDocumentContextMenu } from "../shell/documentContextMenu";
import { preparePrintJob } from "../print/printDocument";
import { PrintWorkspace } from "../print/PrintWorkspace";
import { installAppShortcuts } from "./installAppShortcuts";
import { StartupCoordinator } from "./StartupCoordinator";
import { DesktopEventBindings } from "./DesktopEventBindings";

export interface AppRuntimeHosts {
  editorArea: HTMLElement;
  recentHost: HTMLElement;
  findHost: HTMLElement;
}

export interface AppRuntimeCallbacks {
  setRecentSummary(text: string): void;
}

export class AppRuntime {
  private readonly files: FileService;
  private readonly settingsModel: SettingsModel;
  private readonly settingsDialog: SettingsDialog;
  private readonly findBar: FindBar;
  private readonly recentView: RecentView;
  private readonly scheduler: SnapshotScheduler;
  private readonly printWorkspace: PrintWorkspace;
  private readonly startup: StartupCoordinator;
  private readonly desktopEvents: DesktopEventBindings;
  private switchingView = false;
  private disposed = false;
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly store: Store,
    private readonly editorHost: EditorHost,
    hosts: AppRuntimeHosts,
    private readonly callbacks: AppRuntimeCallbacks,
  ) {
    this.settingsModel = new SettingsModel(store, () => this.onWysiwygConfigChanged());
    this.settingsDialog = new SettingsDialog(store, (next) => void this.settingsModel.save(next));

    // The editor presenter lets FileService flush + re-show the active document
    // after the active tab changes, without owning the editor or view state.
    const presenter: EditorPresenter = {
      flush: () => this.editorHost.flush(),
      commitPendingEdits: () => this.editorHost.commitPendingEdits(),
      showActiveDoc: () => this.showActiveDoc(),
      reloadActiveDoc: () => this.reloadActiveDoc(),
    };
    this.files = new FileService(store, presenter);
    // Image storage in the WYSIWYG view may need to save an untitled buffer
    // first (to know the attachments folder) — let it drive a save (§5.5).
    this.editorHost.setSaveHandler(() => this.files.save());
    // Double-clicking a `.md` link opens that file in a tab (§5.6); openPath
    // focuses it if already open, else opens a new tab (consistent with §5.19).
    this.editorHost.setOpenLinkHandler((path) => this.run(() => this.files.openPath(path)));
    this.scheduler = new SnapshotScheduler(store, this.files);
    // The find card floats over the document and searches the formatted
    // document or raw Markdown according to the active layout. Its open state
    // lives in the store so the toolbar's Find button can show as pressed.
    this.findBar = new FindBar(hosts.findHost, this.editorHost, (open) => this.store.patchFind({ open }));

    // Replace the native WebView right-click menu with md-easy's own (§6.1). It
    // offers the editing commands over editable text and the document actions
    // (Copy as Markdown, Print) everywhere, instead of the browser-level entries
    // the native menu carries. Shift+right-click still opens the native menu so
    // Chromium's spell-check suggestions stay reachable (§5.14).
    this.cleanups.push(installDocumentContextMenu({
      hasDocument: () => this.store.get().activeTabId !== null,
      print: () => void this.printActiveDocument(),
      copyMarkdown: () => void this.copyMarkdown(),
      insertLink: (href) => this.editorHost.insertLink(href),
    }));

    this.printWorkspace = new PrintWorkspace({
      getSettings: () => this.store.get().settings,
      saveSettings: (next) => void this.settingsModel.save(next),
    });

    this.startup = new StartupCoordinator({
      store,
      files: this.files,
      editorHost: this.editorHost,
      settings: this.settingsModel,
      isDisposed: () => this.disposed,
    });
    this.desktopEvents = new DesktopEventBindings({
      store,
      files: this.files,
      editorHost: this.editorHost,
      scheduler: this.scheduler,
      run: (action) => this.run(action),
      handleDrop: (paths) => this.handleDrop(paths),
    });

    // Recent view (§5.8). Opening a file from it shows the editor first, then
    // loads the document into it.
    this.recentView = new RecentView(
      createIpcRecentDataSource(),
      () => this.store.get().settings.recentFilesVisibleCount,
      {
        // Opening from the Recent view lands the file in its own tab (§5.19);
        // openPath flushes the current editor and re-shows the active document.
        onOpenFile: (p) => this.run(() => this.files.openPath(p)),
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
    this.startup.dispose();
    this.scheduler.stop();
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

  openDocument(): void {
    this.run(() => this.files.openViaDialog());
  }

  saveDocument(): void {
    this.run(() => this.files.save());
  }

  saveDocumentAs(): void {
    this.run(() => this.files.saveAs());
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

  openSettings(): void {
    this.settingsDialog.open();
  }

  /** Toggle only the document surface. UI chrome remains controlled in Settings. */
  toggleDocumentTheme(): void {
    const settings = this.store.get().settings;
    const current = document.documentElement.dataset.editorTheme;
    const editorTheme = current === "dark" ? "light" : "dark";
    void this.settingsModel.save({ ...settings, editorTheme });
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
    void this.closeTab(id);
  }

  closeEveryTab(): void {
    void this.closeAllTabs();
  }

  handleBannerAction(id: string): void {
    this.desktopEvents.handleBannerAction(id);
  }

  dismissBanner(): void {
    this.store.set({ banner: null });
  }

  revealPath(path: string): void {
    void this.reveal(path);
  }

  copyText(text: string): void {
    void navigator.clipboard.writeText(text).catch(() => {});
  }

  private async bootstrap(): Promise<void> {
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

    // Startup resolution (§5.15): recovery → launch arg → first-run welcome →
    // Recent view (returning user). In a plain browser (dev/e2e) keep the seed doc.
    const landOnEditor = await this.startup.resolve();
    if (this.disposed) return;
    if (landOnEditor && this.store.get().activeTabId) {
      this.store.set({ view: "wysiwyg" });
      await this.editorHost.reloadActiveDoc();
      this.files.watchActive();
    } else {
      // Returning user (or nothing to open) → Recent view, no tabs, no editor.
      await this.editorHost.unmount();
      await this.showRecent();
    }
    if (this.disposed) return;
    this.scheduler.start();

    // Re-apply spell check when the setting changes (no re-mount needed, §5.14).
    this.cleanups.push(this.store.select(
      (s) => s.settings.spellCheckEnabled,
      () => this.editorHost.applySpellcheck(),
    ));

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
      save: (saveAs) => this.run(() => (saveAs ? this.files.saveAs() : this.files.save())),
      open: () => this.run(() => this.files.openViaDialog()),
      create: () => this.run(() => this.files.newDocument()),
      print: () => void this.printActiveDocument(),
    }));
    this.desktopEvents.start();
    // First desktop launch only: offer to make md-easy the default .md app.
    void this.startup.maybePromptDefaultHandler();
  }

  /** Re-mount the WYSIWYG editor so changed serializer style (§5.16) or link
   *  display (§5.6) takes effect. */
  private onWysiwygConfigChanged(): void {
    // Bumps the WYSIWYG config epoch so every WYSIWYG pane (active and the hidden
    // background/other-view ones) rebuilds with the new style; a no-op for raw.
    void this.editorHost.reload();
  }

  /** Switch which editor panes are shown — document only, the split, or Markdown
   *  only (§6.1). A no-op with no document open or on the Recent view (the toolbar
   *  disables the control there) and when the layout is unchanged. */
  private async setLayout(layout: EditorLayout): Promise<void> {
    if (this.switchingView) return;
    if (!this.store.get().activeTabId) return; // nothing to show
    if (this.store.get().view === "recent") return; // handled in the editor only
    if (this.store.get().editorLayout === layout) return;
    this.switchingView = true;
    try {
      // Clear the outgoing editor's highlights (clear acts on the current
      // layout's editor); an open find card then searches the newly shown one.
      const searching = this.findBar.isOpen();
      if (searching) this.editorHost.clear();
      this.store.set({ editorLayout: layout });
      await this.editorHost.setLayout(layout);
      if (searching) this.findBar.refresh();
    } finally {
      this.switchingView = false;
    }
  }

  /** Open the print workspace for the active document (§5.21): md-easy's own
   *  full-window print mode, with a preview of the very sheets that will be
   *  printed and a Document / Markdown version choice. Replaces both the browser
   *  print dialog and the old direct window.print(). */
  private async printActiveDocument(): Promise<void> {
    const state = this.store.get();
    if (!state.activeTabId) return; // nothing open to print
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
   *  closes the editor is torn down and the Recent view is shown. */
  private async closeTab(id: string): Promise<void> {
    // Collect typing the document view has not reported yet, so the unsaved
    // check below sees it.
    this.editorHost.commitPendingEdits();
    const tab = this.store.get().tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.doc.isDirty && !(await this.files.confirmCloseTab(tabLabel(tab)))) return;
    const wasActive = this.store.get().activeTabId === id;
    const nextActive = this.store.closeTab(id);
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
  }

  /** Close every open tab (tab context menu, §5.19). Prompts once if any tab has
   *  unsaved changes, then tears the editor down and shows the Recent view. */
  private async closeAllTabs(): Promise<void> {
    if (this.store.get().tabs.length === 0) return;
    // Capture in-progress edits so the dirty check reflects the latest typing.
    this.editorHost.flush();
    if (this.files.anyDirty() && !(await this.files.confirmDiscardAll())) return;
    for (const tab of [...this.store.get().tabs]) {
      this.store.closeTab(tab.id);
      await this.editorHost.discardTab(tab.id);
    }
    if (this.findBar.isOpen()) this.findBar.close();
    await this.editorHost.unmount();
    await this.showRecent();
  }

  /** Show the Recent view (§5.8), refreshing its history list. */
  private async showRecent(): Promise<void> {
    if (this.store.get().view === "recent") return;
    if (this.findBar.isOpen()) this.findBar.close();
    this.store.set({ view: "recent" });
    await this.recentView.refresh();
  }

  /** Show the active tab's document, revealing its cached editor when possible so
   *  undo survives (tab switch / close→neighbour / return from Recent). */
  private async showActiveDoc(): Promise<void> {
    await this.presentActiveDoc(false);
  }

  /** Show the active tab's document after its content was replaced (open / new /
   *  reload), forcing a fresh editor (undo resets). */
  private async reloadActiveDoc(): Promise<void> {
    await this.presentActiveDoc(true);
  }

  private async presentActiveDoc(reload: boolean): Promise<void> {
    // The find bar is bound to the editor we're about to (re)show; close it so it
    // doesn't linger with stale search state from the previous document.
    if (this.findBar.isOpen()) this.findBar.close();
    if (this.store.get().view === "recent") this.recentView.onLeave();
    // Leaving Recent re-enters the editor; the editor host honours the persisted
    // `editorLayout` (document / split / Markdown only) when it presents.
    this.store.set({ view: "wysiwyg" });
    if (reload) await this.editorHost.reloadActiveDoc();
    else await this.editorHost.showActiveDoc();
    this.afterActiveDocChanged();
  }

  /** Re-point the file watcher at the active document and clear a stale banner
   *  left over from the previously active file (§5.1, §5.19). */
  private afterActiveDocChanged(): void {
    this.store.set({ banner: null });
    this.desktopEvents.resetPendingChange();
    this.files.watchActive();
  }

  /** Adjust the document text size (spec §5.20), persisting via settings. */
  private async adjustFontScale(delta: number): Promise<void> {
    const s = this.store.get().settings;
    const next = clampFontScale(round2(s.editorFontScale + delta));
    if (next === s.editorFontScale) return;
    await this.settingsModel.save({ ...s, editorFontScale: next });
  }

  private async copyMarkdown(): Promise<void> {
    this.editorHost.commitPendingEdits(); // include the latest typing
    try {
      await navigator.clipboard.writeText(this.store.get().doc.markdown);
    } catch {
      // Clipboard may be unavailable outside the app shell; ignore.
    }
  }

  /** File picker for the Recent view's Locate action (§5.8). */
  private async pickMarkdownFile(): Promise<string | null> {
    if (!isElectron()) return null;
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
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

  /**
   * Explorer drag-drop (spec §5.4): a markdown file opens (honoring the unsaved
   * guard); image files embed at the cursor; other files are copied into the
   * attachments folder and linked.
   */
  private async handleDrop(paths: string[]): Promise<void> {
    // A dropped markdown file opens in its own tab (§5.19).
    const md = paths.find((p) => classifyDrop(p) === "md");
    if (md) {
      await this.files.openPath(md);
      return;
    }
    // Image/attachment drops embed at the cursor; they need an editor to target.
    // With no document open, create one first so the drop has somewhere to go.
    if (!this.store.get().activeTabId) await this.files.newDocument();
    else if (this.store.get().view === "recent") await this.showActiveDoc();
    for (const path of paths) {
      if (classifyDrop(path) === "image") await this.embedDroppedImage(path);
      else await this.attachDroppedFile(path);
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

  private async embedDroppedImage(path: string): Promise<void> {
    const { bytes, mime } = await readImageBytes(path);
    const src = await resolveImageSrc(new Uint8Array(bytes), mime, this.imageStoreContext());
    if (src) this.editorHost.insertMarkdown(mdImage("", src));
  }

  private async attachDroppedFile(path: string): Promise<void> {
    // Non-image files always go to attachments (§5.7), which needs a saved doc.
    if (!this.store.get().doc.filePath && !(await this.files.save())) return;
    const filePath = this.store.get().doc.filePath;
    if (!filePath) return;
    const { bytes } = await readImageBytes(path);
    const name = baseName(path);
    const rel = await writeAttachment(
      filePath,
      this.store.get().settings.attachmentsFolderName,
      name,
      new Uint8Array(bytes),
    );
    this.editorHost.insertMarkdown(mdLink(name, rel));
  }

  /** Run a file action, surfacing failures without crashing the shell. */
  private run(action: () => Promise<unknown>): void {
    if (this.disposed) return;
    action().catch((err) => {
      console.error("md-easy: file action failed", err);
    });
  }
}

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
