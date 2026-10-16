// Owns the editor panes and the single-source-of-truth invariant (spec §8.3,
// docs/design.md §4). `DocumentState.markdown` is canonical; each editor is a
// *view* over that string.
//
// The toolbar's three-segment view control (§6.1) chooses the layout: the
// document (WYSIWYG) view alone, the raw Markdown source alone, or both side by
// side in a split with a draggable divider between them. In the split both panes
// are live editors over the same canonical string; an edit in one is mirrored
// into the other (debounced) so the split stays in sync without ever letting the
// two views diverge.
//
// To preserve undo history across tab switches and while the split opens/closes
// (spec §5.19), a live editor instance is kept per `(tab, view)` and hidden/shown
// rather than destroyed. ProseMirror's undo history is not serializable across a
// markdown re-parse, so keeping the instance alive is the only way to retain it.
//
// Cache invalidation is driven by a per-tab *revision* counter: any real change
// to a tab's canonical string bumps its rev and stamps the authoring pane as
// in-sync; every other pane of that tab is now stale. A stale pane's change
// reports are dropped, since they carry older text. On reveal, a stale pane is
// rebuilt from the canonical string (its undo resets) — so the views can never
// diverge, yet an untouched view keeps its undo. A pane that falls behind while
// it builds is built again before it is shown. At most `maxRetainedTabEditors`
// tabs keep live panes (LRU); older tabs fall back to rebuild-on-revisit.

import type { Store } from "../state/store";
import { serializerStyleFromSettings } from "../state/types";
import type { DocumentViewFailure, EditorLayout } from "../state/types";
import { applyEditorMarkdownForTab } from "../document/DocumentModel";
import { WysiwygEditor } from "./wysiwyg/WysiwygEditor";
import { forgetImageAnswers } from "./wysiwyg/imageView";
import { RawEditor } from "./raw/RawEditor";
import { ScrollSync } from "./scrollSync";
import { applySpellcheck } from "./wysiwyg/spellcheck";
import type { WysiwygContext } from "./wysiwyg/context";
import type { FindController } from "./wysiwyg/findBar";
import type { FindCounts, FindOptions } from "./wysiwyg/findEngine";
import { releaseFindRoom } from "./wysiwyg/findReveal";

type View = "wysiwyg" | "raw";

interface Pane {
  tabId: string;
  view: View;
  /** Tab rev this pane's content is in sync with; stale when it lags the tab. */
  syncedRev: number;
  /** WYSIWYG config epoch this pane was built with (serializer style / link mode). */
  configEpoch: number;
  /** Wrapper element (a child of `root`); hidden via the `hidden` attribute. */
  el: HTMLElement;
  wysiwyg: WysiwygEditor | null;
  raw: RawEditor | null;
}

const NO_MATCHES: FindCounts = { total: 0, current: 0 };
const paneKey = (tabId: string, view: View): string => `${tabId} ${view}`;

/** Debounce for mirroring an edit into the other split pane (§6.1). Coalesces a
 *  burst of keystrokes so the (heavier) WYSIWYG re-parse doesn't run per key. */
const SYNC_DEBOUNCE_MS = 120;
/** How many builds of a document pane in a row may each end behind the tab's
 *  text, because of an edit made while it built, before md-easy gives up
 *  (`ensurePane`). A rebuild usually finishes before the next keystroke, so
 *  typing while the view opens seldom needs a third build. */
const MAX_STALE_BUILDS = 5;
/** How far the divider can travel: the narrower pane keeps at least this share. */
const SPLIT_MIN_RATIO = 0.2;
const SPLIT_MAX_RATIO = 0.8;

export class EditorHost implements FindController {
  /** Live panes keyed by `(tabId, view)`. */
  private panes = new Map<string, Pane>();
  /** Per-tab revision (monotonic; bumped on every canonical change). */
  private rev = new Map<string, number>();
  /** Tab ids in most-recently-active-first order, for LRU eviction. */
  private tabMru: string[] = [];
  /** WYSIWYG serializer/link-display config generation; bumped on settings change. */
  private configEpoch = 0;
  private activeTabId: string | null = null;
  private currentView: View | null = null;
  /** The change of panes in progress (`runPaneChange`), such as a tab shown or
   *  a layout switched, or null. Only one runs at a time. */
  private changing: Promise<void> | null = null;
  /** Set when a tab switch, an open or a reload asked to show the active tab
   *  while a change of panes ran. The active tab or its text may have changed
   *  after that change began, so it shows the active tab again before it ends. */
  private showQueued = false;
  /** The layout chosen last while a change of panes ran, or null. The change
   *  switches to it before it ends (`setLayout`). */
  private queuedLayout: EditorLayout | null = null;
  /** Tabs whose text an open or a reload replaced while another change of
   *  panes ran. Their panes went stale then (`reloadActiveDoc`). Like a reload,
   *  the next showing of each tries a failed Document view again (`present`). */
  private readonly replacedTabs = new Set<string>();
  /** Set when an open or a reload during another change of panes asked to
   *  forget the image answers (`reloadActiveDoc`). The next document pane built
   *  forgets them first, or the change does as it ends. A document pane already
   *  building keeps the answers it waited for, because one that lost them would
   *  render its images with their raw paths, looked up next to md-easy's own
   *  page. */
  private forgetImagesBeforeBuild = false;
  /** Terminal lifecycle state. `unmount` clears editors but leaves this host
   *  reusable; `dispose` permanently rejects future work for React cleanup. */
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  /** Pane teardown can already be awaiting Crepe when terminal disposal starts
   *  (for example, a reload removed a stale pane just before React unmounted).
   *  Track those detached panes so `dispose()` still waits for their cleanup. */
  private readonly pendingTeardowns = new Set<Promise<void>>();
  private readonly paneTeardowns = new WeakMap<Pane, Promise<void>>();
  /** The window's layout — document only, the split, or Markdown only (§6.1).
   *  Mirrors `AppState.editorLayout`. */
  private windowLayout: EditorLayout = "document";
  /** The layout the active tab is shown in: the window's, or Markdown only
   *  while the tab's Document view cannot be built (`shownLayout`). */
  private layout: EditorLayout = "document";
  /** Set while a mirror sync writes into a pane, so a change report made during
   *  the write is ignored (the Markdown pane also suppresses its own). The
   *  document pane reports a sync about 200ms later, after this is reset. That
   *  report carries the exact mirrored text (`WysiwygEditor.getMarkdown`), so it
   *  changes nothing, and `onChange` drops it if a newer Markdown edit landed
   *  first. */
  private applyingSync = false;
  /** Pending debounced mirror sync and the pane whose edit it mirrors. A reload
   *  of that pane's tab drops it (`reloadActiveDoc`). */
  private pendingSync: { timer: ReturnType<typeof setTimeout>; source: Pane } | null = null;
  /** The draggable divider between the two split panes (lazily created). */
  private divider: HTMLElement | null = null;
  /** Best-effort fractional scroll-position sync between the two split panes
   *  (§5.3): scrolling one pane keeps the other at the same %. Connected to the
   *  visible pair while the split is open; disconnected otherwise. */
  private readonly scrollSync = new ScrollSync();
  /** Fraction of the host width given to the document (left) pane in split view. */
  private leftRatio = 0.5;
  private dragCleanup: (() => void) | null = null;
  private dragPointerId: number | null = null;
  /** Set by AppRuntime; lets the WYSIWYG paste/drop path trigger a save when an
   *  untitled buffer needs an attachments folder (§5.5). */
  private saveHandler: (() => Promise<boolean>) | null = null;
  /** Set by AppRuntime; opens a local markdown file in a tab when a `.md` link is
   *  double-clicked in the WYSIWYG view (§5.6). */
  private openLinkHandler: ((absPath: string) => void) | null = null;
  /** Set by AppRuntime; shows the new count on the find card after an edit
   *  changes the matches in the pane it searches (§5.13). */
  private findChangeHandler: (() => void) | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly store: Store,
  ) {}

  /** Wire the prompt-and-save action (FileService.save) used by image storage. */
  setSaveHandler(handler: () => Promise<boolean>): void {
    if (this.disposed) return;
    this.saveHandler = handler;
  }

  /** Wire the open-in-tab action (FileService.openPath) used for `.md` links. */
  setOpenLinkHandler(handler: (absPath: string) => void): void {
    if (this.disposed) return;
    this.openLinkHandler = handler;
  }

  /** Wire the find card's recount (FindBar.syncCounts) used after edits. */
  setFindChangeHandler(handler: () => void): void {
    if (this.disposed) return;
    this.findChangeHandler = handler;
  }

  /** Set the initial layout before the first `present` (bootstrap only). Use
   *  `setLayout` for a runtime change — it flushes and re-presents. */
  initLayout(layout: EditorLayout): void {
    if (this.disposed) return;
    this.windowLayout = layout;
  }

  /** Insert markdown at the caret of the pane being edited (§5.4): the split's
   *  Markdown pane while it holds focus, otherwise the document editor, or the
   *  Markdown source in the Markdown-only view. A file drop lands here with no
   *  click or focus on a pane, so the split catches up first and the target
   *  pane holds the other pane's latest edit. The Markdown pane reports the
   *  insert at once, like typing, and keeps the rest of its text as written. */
  insertMarkdown(markdown: string): void {
    if (this.disposed) return;
    this.flush();
    const pane = this.focusedSplitRaw() ?? this.active();
    if (pane?.wysiwyg) pane.wysiwyg.insertMarkdown(markdown);
    else if (pane?.raw) pane.raw.insertText(markdown);
  }

  /** (Re)apply the spell-check setting to every editor under the host (§5.14). */
  applySpellcheck(): void {
    if (this.disposed) return;
    applySpellcheck(this.root, this.store.get().settings.spellCheckEnabled);
  }

  // ── FindController (§5.13): the find card routes to the visible document
  // editor, using ProseMirror in Document/Split and CM in Markdown. ──

  search(query: string, opts: FindOptions): FindCounts {
    if (this.disposed) return NO_MATCHES;
    this.suppressMirrorScroll();
    return this.layout === "markdown"
      ? this.activeRaw()?.searchText(query, opts) ?? NO_MATCHES
      : this.activeWysiwyg()?.search(query, opts) ?? NO_MATCHES;
  }
  next(): FindCounts {
    if (this.disposed) return NO_MATCHES;
    this.suppressMirrorScroll();
    return this.layout === "markdown"
      ? this.activeRaw()?.findNext() ?? NO_MATCHES
      : this.activeWysiwyg()?.findNext() ?? NO_MATCHES;
  }
  prev(): FindCounts {
    if (this.disposed) return NO_MATCHES;
    this.suppressMirrorScroll();
    return this.layout === "markdown"
      ? this.activeRaw()?.findPrev() ?? NO_MATCHES
      : this.activeWysiwyg()?.findPrev() ?? NO_MATCHES;
  }
  replaceCurrent(replacement: string, query: string, opts: FindOptions): FindCounts {
    if (this.disposed) return NO_MATCHES;
    this.suppressMirrorScroll();
    return this.layout === "markdown"
      ? this.activeRaw()?.replaceCurrent(replacement, query, opts) ?? NO_MATCHES
      : this.activeWysiwyg()?.replaceCurrent(replacement, query, opts) ?? NO_MATCHES;
  }
  replaceAll(replacement: string, query: string, opts: FindOptions): FindCounts {
    if (this.disposed) return NO_MATCHES;
    this.suppressMirrorScroll();
    return this.layout === "markdown"
      ? this.activeRaw()?.replaceAll(replacement, query, opts) ?? NO_MATCHES
      : this.activeWysiwyg()?.replaceAll(replacement, query, opts) ?? NO_MATCHES;
  }
  /** The searched editor's current match and total, read after an edit. */
  counts(): FindCounts {
    if (this.disposed) return NO_MATCHES;
    return this.layout === "markdown"
      ? this.activeRaw()?.currentCounts() ?? NO_MATCHES
      : this.activeWysiwyg()?.currentCounts() ?? NO_MATCHES;
  }

  /** A Find/replace op scrolls the document to the match (per keystroke during
   *  incremental search). In the split, tell the scroll sync that this scroll
   *  is app-originated, so it does not drive the Markdown pane and jerk it on
   *  every keystroke (§5.3). */
  private suppressMirrorScroll(): void {
    if (this.layout === "split") this.scrollSync.suppressNext();
  }
  clear(): void {
    // The search is over, so the room find made below the last line goes too.
    releaseFindRoom();
    if (this.disposed) return;
    if (this.layout === "markdown") this.activeRaw()?.clearSearch();
    else this.activeWysiwyg()?.clearSearch();
  }
  focusEditor(): void {
    if (this.disposed) return;
    const pane = this.active();
    if (pane?.wysiwyg) pane.wysiwyg.focus();
    else pane?.raw?.focus();
  }

  /** The active pane's `.ProseMirror` node (for print fidelity), or null when the
   *  document editor isn't mounted. Scoped to the active pane so hidden panes are
   *  never picked up. */
  activeWysiwygNode(): Element | null {
    if (this.disposed) return null;
    const pane = this.active();
    if (!pane || pane.view !== "wysiwyg") return null;
    return pane.el.querySelector(".ProseMirror");
  }

  /** Wrap the active document selection in a link (§5.6), for the right-click
   *  menu. False when the document editor isn't the active pane or nothing is
   *  selected. */
  insertLink(href: string): boolean {
    if (this.disposed) return false;
    return this.activeWysiwyg()?.insertLink(href) ?? false;
  }

  /** Whether any editor is currently mounted (false after `unmount`). */
  isMounted(): boolean {
    return !this.disposed && this.currentView !== null;
  }

  /**
   * Bring the active tab up to date before something reads it, leaves it, or
   * types into it: Save, Print, Copy as Markdown, a close prompt, a tab or
   * layout switch, a file drop, or a click or focus moving into a split pane.
   * The document editor reports typing after a ~200ms pause, and the split
   * mirrors each edit into its other pane after a further delay. This does both
   * now, so the tab's canonical string holds every edit and both visible panes
   * show it. Markdown pane edits are reported as they happen.
   *
   * Edits only ever arrive through a pane's change report, which the host
   * drops when the pane lags the tab. Never read a pane's text here, which
   * would skip that check and could write older text over a newer edit.
   *
   * The document pane decides a typed closing `$` or `~` that still waits
   * before it reports. `keepTypedMark` leaves it waiting and reports it as
   * text, for a click or focus moving into the document pane itself, where a
   * click may land inside the text the mark closes, and for autosave, which
   * must not change the document while the user types.
   */
  flush({ keepTypedMark = false }: { keepTypedMark?: boolean } = {}): void {
    if (this.disposed || !this.activeTabId) return;
    const pane = this.panes.get(paneKey(this.activeTabId, "wysiwyg"));
    // Only a visible pane can hold unreported typing. A stale one holds text
    // older than the canonical string, and reporting it would overwrite newer
    // edits from the Markdown pane. The mirror below replaces it instead.
    if (pane && !pane.el.hidden && !this.isStale(pane)) pane.wysiwyg?.reportPendingChange({ keepTypedMark });
    this.runPendingSync();
  }

  /**
   * Show the active tab's document (tab switch / close→neighbour / return from
   * Recent). Reveals cached panes when in sync (undo preserved); rebuilds only
   * stale ones. Honours the current split state. While another change of panes
   * runs, that change shows the active tab once it is done, and this waits for
   * it.
   */
  async showActiveDoc(): Promise<void> {
    if (this.disposed) return;
    if (this.changing) return this.queueShow();
    await this.runPaneChange(() => this.present());
  }

  /**
   * Show the active tab's document after its canonical string was replaced from
   * outside the editors (open / new / disk-reload). Forces a fresh
   * rebuild (undo resets) and invalidates the tab's panes. Image lookups are
   * asked again, so an image that has appeared on disk since shows. A Markdown
   * pane on screen keeps the older text until the panes of the active tab are
   * shown, and typing there meanwhile is dropped (`onChange`).
   *
   * While another change of panes runs, the tab's panes go stale at once, so
   * the panes that change builds or shows take no typing that would write the
   * older text back. It then shows the active tab again, and this waits for it.
   * The image answers are forgotten before the next document pane is built.
   *
   * A pending mirror sync of an edit in the tab's split is dropped. It would
   * copy the new text into a pane from before the reload, possibly one still
   * building, and mark that pane current, so it would be shown with its undo
   * history and image answers from before. Only a pane built after the reload
   * can be current, so every pane shown for the tab is built from the new text.
   */
  async reloadActiveDoc(): Promise<void> {
    if (this.disposed) return;
    const id = this.store.get().activeTabId;
    if (id) {
      this.bumpRev(id); // no author → every pane of this tab is now stale
      if (this.pendingSync?.source.tabId === id) this.cancelSync();
    }
    if (!this.changing) {
      forgetImageAnswers();
      return this.runPaneChange(() => this.present({ rebuild: true }));
    }
    if (id) this.replacedTabs.add(id);
    this.forgetImagesBeforeBuild = true;
    return this.queueShow();
  }

  /** Switch the window's layout — document / split / Markdown (§6.1). Flushes
   *  the visible edits first so the (possibly newly built) panes start from the
   *  current canonical. Choosing the document or the split while the active
   *  tab's Document view has failed tries that view again, even when the
   *  window already has that layout. While another change of panes runs, that
   *  change switches to the layout chosen last once it is done, and this waits
   *  for it. */
  async setLayout(layout: EditorLayout): Promise<void> {
    if (this.disposed) return;
    if (this.changing) {
      this.queuedLayout = layout;
      return this.changing;
    }
    if (!this.changesLayout(layout)) return;
    await this.runPaneChange(() => this.switchLayout(layout));
  }

  /** Try again to build the active tab's Document view after it failed (the
   *  notice's Try again), from the tab's current text. In the Markdown layout
   *  the view is built hidden, so a success is ready when the layout changes.
   *  A retry that fails again changes nothing on screen, so focus stays on
   *  Try again instead of moving into the Markdown view. */
  async retryDocumentView(): Promise<void> {
    if (this.disposed || this.changing) return;
    await this.runPaneChange(() => this.present({ retry: true, keepFocusOnFailure: true }));
  }

  /**
   * Re-apply a WYSIWYG serializer/link-display settings change (§5.16, §5.6):
   * bump the config epoch (invalidating every WYSIWYG pane) and rebuild the
   * active one now; hidden WYSIWYG panes rebuild on their next reveal. During
   * another change of panes, which may have built the active one already, that
   * change shows the active tab again before it ends.
   */
  async reload(): Promise<void> {
    if (this.disposed) return;
    this.configEpoch += 1;
    if (!this.currentView) return;
    if (this.changing) return this.queueShow();
    await this.runPaneChange(() => this.present());
  }

  /** Destroy a closed tab's panes and free their DOM (spec §5.19). Call on every
   *  tab close — including background tabs — so their panes don't leak. */
  async discardTab(tabId: string): Promise<void> {
    if (this.disposed) return;
    if (this.activeTabId === tabId) {
      this.cancelSync();
      this.scrollSync.disconnect();
    }
    for (const view of ["wysiwyg", "raw"] as View[]) {
      if (this.disposed) return;
      const pane = this.panes.get(paneKey(tabId, view));
      if (pane) await this.destroyPane(pane);
    }
    this.rev.delete(tabId);
    this.replacedTabs.delete(tabId);
    this.tabMru = this.tabMru.filter((t) => t !== tabId);
    if (this.activeTabId === tabId) this.activeTabId = null;
  }

  /** Tear every editor down — used when the last tab closes (§5.19). */
  async unmount(): Promise<void> {
    if (this.disposed || this.changing) return;
    await this.runPaneChange(async () => {
      this.cancelSync();
      this.scrollSync.disconnect();
      this.endDrag();
      await this.destroyAllPanes();
      // A terminal React cleanup can pre-empt this reusable unmount while Crepe
      // is being destroyed. Never let the old continuation clear a root that a
      // replacement island may now own.
      if (this.disposed) return;
      this.root.replaceChildren();
      this.divider = null; // removed by replaceChildren; re-created on next present
      this.root.classList.remove("split");
      this.root.style.removeProperty("--split-left");
      this.activeTabId = null;
      this.currentView = null;
    });
  }

  /** Evict retained panes beyond the configured limit — used when the user lowers
   *  the `maxRetainedTabEditors` setting at runtime. */
  async applyRetentionLimit(): Promise<void> {
    if (this.disposed || this.changing) return;
    await this.runPaneChange(() => this.enforceLru());
  }

  /**
   * Permanently tear down this host. Unlike `unmount`, this is terminal and is
   * safe to call from a React effect cleanup:
   *
   * - lifecycle guards and callbacks are disabled synchronously;
   * - timers, scroll listeners, pointer capture, panes, and the divider detach
   *   synchronously before the returned promise waits for Crepe destruction;
   * - repeated calls return the same cleanup promise;
   * - an in-flight `buildPane` observes `disposed` after its await and cannot
   *   reattach itself.
   *
   * The host removes only DOM it owns. It deliberately does not call
   * `root.replaceChildren()`, so an old Strict-Mode cleanup cannot erase a newer
   * island that happens to use the same React-owned root.
   */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;

    this.disposed = true;
    this.saveHandler = null;
    this.openLinkHandler = null;
    this.findChangeHandler = null;
    this.cancelSync();
    this.scrollSync.disconnect();
    this.endDrag();
    this.applyingSync = false;
    this.currentView = null;
    this.root.classList.remove("split");
    this.root.style.removeProperty("--split-left");

    const divider = this.divider;
    this.divider = null;
    divider?.remove();

    const currentPanes = this.destroyAllPanes();
    // `destroyAllPanes` starts each teardown synchronously before returning, so
    // this snapshot includes both its panes and any pane already detached by an
    // in-flight reload/eviction.
    const allTeardowns = [...this.pendingTeardowns];
    this.disposePromise = Promise.allSettled([currentPanes, ...allTeardowns]).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("md-easy: editor teardown failed", result.reason);
        }
      }
    });
    return this.disposePromise;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Run a change of panes. Only one runs at a time, so each public entry point
   *  returns or queues while `changing` is set. Before it ends, the change shows
   *  the active tab again for each tab switch, open or reload made while it ran
   *  (`queueShow`), and switches to the layout chosen last meanwhile
   *  (`setLayout`). Its own build or reveal may be for a tab that is no longer
   *  active, or from text that was replaced since. */
  private async runPaneChange(change: () => Promise<void>): Promise<void> {
    let finish!: () => void;
    this.changing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      await change();
    } finally {
      try {
        while ((this.showQueued || this.queuedLayout) && !this.disposed) {
          const show = this.showQueued;
          const layout = this.queuedLayout;
          this.showQueued = false;
          this.queuedLayout = null;
          // A layout switch shows the active tab too.
          if (layout && this.changesLayout(layout)) await this.switchLayout(layout);
          else if (show) await this.present();
        }
      } finally {
        this.showQueued = false;
        this.queuedLayout = null;
        this.changing = null;
        this.forgetPendingImageAnswers();
        finish();
      }
    }
  }

  /** Ask the change of panes in progress to show the active tab before it
   *  ends, and wait for that. */
  private queueShow(): Promise<void> {
    this.showQueued = true;
    return this.changing ?? Promise.resolve();
  }

  /** Whether choosing `layout` changes the panes: it is another layout, or the
   *  document or the split for a tab whose Document view failed, which tries
   *  that view again. */
  private changesLayout(layout: EditorLayout): boolean {
    if (this.windowLayout !== layout) return true;
    return layout !== "markdown" && this.hasFailed(this.store.get().activeTabId);
  }

  /** Show the active tab in `layout`, from the current text of its visible
   *  panes (`flush`). */
  private async switchLayout(layout: EditorLayout): Promise<void> {
    this.flush();
    this.windowLayout = layout;
    await this.present({ retry: layout !== "markdown" });
  }

  /** Forget the image answers if a reload during a change of panes asked to. */
  private forgetPendingImageAnswers(): void {
    if (!this.forgetImagesBeforeBuild) return;
    this.forgetImagesBeforeBuild = false;
    forgetImageAnswers();
  }

  private active(): Pane | null {
    if (this.disposed || this.activeTabId === null || this.currentView === null) return null;
    return this.panes.get(paneKey(this.activeTabId, this.currentView)) ?? null;
  }

  private activeWysiwyg(): WysiwygEditor | null {
    return this.active()?.wysiwyg ?? null;
  }

  private activeRaw(): RawEditor | null {
    return this.active()?.raw ?? null;
  }

  /** The split's Markdown pane when it holds focus, else null. */
  private focusedSplitRaw(): Pane | null {
    if (this.layout !== "split" || this.activeTabId === null) return null;
    const pane = this.panes.get(paneKey(this.activeTabId, "raw"));
    return pane?.el.contains(document.activeElement) ? pane : null;
  }

  private revOf(tabId: string): number {
    return this.rev.get(tabId) ?? 0;
  }

  private bumpRev(tabId: string, author?: Pane): void {
    const next = this.revOf(tabId) + 1;
    this.rev.set(tabId, next);
    if (author) author.syncedRev = next; // the authoring pane stays in sync
  }

  private touchTab(tabId: string): void {
    this.tabMru = [tabId, ...this.tabMru.filter((t) => t !== tabId)];
  }

  /** Reveal the active tab's panes for the window's layout: the document, the
   *  Markdown source, or both side by side (§6.1). Rebuilds stale panes, hides
   *  every other tab's pane, and lays out the divider.
   *
   *  When the document pane cannot be built, the tab shows its Markdown alone
   *  and the failure is recorded on the tab for the notice bar. Later reveals
   *  leave the document pane unbuilt until `retry`, or a `rebuild` after the
   *  tab's text was replaced, tries again. A tab whose text was replaced while
   *  another change of panes ran (`replacedTabs`) tries again too. With
   *  `keepFocusOnFailure`, a build that fails leaves focus where it is. */
  private async present(
    opts: { rebuild?: boolean; retry?: boolean; keepFocusOnFailure?: boolean } = {},
  ): Promise<void> {
    if (this.disposed) return;
    const id = this.store.get().activeTabId;
    if (!id) return;
    const rebuild = opts.rebuild ?? false;
    const failed = this.hasFailed(id);
    const replaced = this.replacedTabs.delete(id);

    // Building a pane never changes the tab's text, because the document pane
    // reports its exact source until the user edits it. In the Markdown-only
    // view the document pane isn't built at all, except to try a failed one again.
    const attempt = failed ? rebuild || replaced || (opts.retry ?? false) : this.windowLayout !== "markdown";
    let wysiwygPane: Pane | null = null;
    let failure: DocumentViewFailure | null = null;
    if (attempt) {
      try {
        wysiwygPane = await this.ensurePane(id, "wysiwyg", rebuild);
      } catch (error) {
        console.error("md-easy: the Document view could not be built", error);
        failure = { message: error instanceof Error ? error.message : String(error), dismissed: false };
      }
      if (this.disposed || (!failure && !wysiwygPane)) return;
    }
    const fallback = attempt ? failure !== null : failed;
    const layout = fallback ? "markdown" : this.windowLayout;
    // A document pane built only to try it again stays hidden in the Markdown view.
    if (layout === "markdown") wysiwygPane = null;
    // Record the build's outcome once the panes are shown and focused. A notice
    // it brings up then returns focus to the editor when dismissed.
    const record = (): void => {
      if (attempt && !this.disposed) this.store.setDocumentViewFailure(id, failure);
    };
    if (this.store.get().activeTabId !== id) return record();
    const showRaw = layout !== "document";
    const rawPane = showRaw ? await this.ensurePane(id, "raw", rebuild) : null;
    if (this.disposed || this.store.get().activeTabId !== id || (showRaw && !rawPane)) return record();

    for (const pane of this.panes.values()) {
      pane.el.hidden = pane !== wysiwygPane && pane !== rawPane;
    }

    this.activeTabId = id;
    this.layout = layout;
    // The "active" pane (find / print / focus target) is the document when it's
    // shown, otherwise the Markdown source (Markdown-only view).
    this.currentView = wysiwygPane ? "wysiwyg" : "raw";
    this.touchTab(id);
    this.layoutSplit();
    this.applySpellcheck();
    // Focus the document when shown; in the split the Markdown mirror only
    // re-measures (focus=false) so it doesn't steal focus or fight the document.
    // In the Markdown-only view the raw source is the sole pane, so it takes focus.
    wysiwygPane?.wysiwyg?.onShow();
    rawPane?.raw?.onShow(layout === "markdown" && !(failure && opts.keepFocusOnFailure));
    // Keep the two visible panes' scroll positions in sync (§5.3); rewires to the
    // current pair on every reveal, and disconnects whenever it isn't the split.
    this.syncScroll(wysiwygPane, rawPane);
    record();

    await this.enforceLru();
  }

  /** Connect the fractional scroll-position sync to the visible split pair, or
   *  tear it down for the single-pane layouts (document / Markdown only). Called
   *  on every reveal so it always tracks the current pane elements (a pane rebuild
   *  or tab switch swaps the DOM nodes). */
  private syncScroll(wysiwygPane: Pane | null, rawPane: Pane | null): void {
    if (this.layout === "split" && wysiwygPane && rawPane) {
      this.scrollSync.connect(wysiwygPane.el, rawPane.el);
    } else {
      this.scrollSync.disconnect();
    }
  }

  /** Return the live `(tab, view)` pane, rebuilding it when forced or stale.
   *
   *  A document pane takes a while to build, and the Markdown pane on screen
   *  stays editable meanwhile, so the tab's text can change before the new pane
   *  is ready. A settings change made then also leaves it stale. Such a pane
   *  would show older text and drop its own edits (`onChange`), so it is built
   *  again from the tab's current text. After `MAX_STALE_BUILDS` builds in a row
   *  that each fell behind, the last is destroyed and this throws, so the tab
   *  shows its Markdown with the notice like any failed build. */
  private async ensurePane(tabId: string, view: View, rebuild: boolean): Promise<Pane | null> {
    if (this.disposed || !this.hasTab(tabId)) return null;
    let pane = this.panes.get(paneKey(tabId, view));
    if (pane && !rebuild && !this.isStale(pane)) return pane;
    for (let builds = 1; ; builds += 1) {
      if (pane) {
        await this.destroyPane(pane);
        if (this.disposed || !this.hasTab(tabId)) return null;
      }
      const built = await this.buildPane(tabId, view);
      if (!built || !this.isStale(built)) return built;
      if (builds === MAX_STALE_BUILDS) {
        await this.destroyPane(built);
        throw new Error("the text kept changing while the view opened");
      }
      pane = built;
    }
  }

  /** A pane is stale when the tab moved on without it, or (WYSIWYG only) the
   *  serializer/link config changed since it was built. */
  private isStale(pane: Pane): boolean {
    if (pane.syncedRev !== this.revOf(pane.tabId)) return true;
    return pane.view === "wysiwyg" && pane.configEpoch !== this.configEpoch;
  }

  private async buildPane(tabId: string, view: View): Promise<Pane | null> {
    if (this.disposed) return null;
    const tab = this.store.get().tabs.find((t) => t.id === tabId);
    // A tab can be closed while a stale pane is being destroyed. Never create a
    // replacement under its old id from whichever document happens to be active.
    if (!tab) return null;
    const markdown = tab.doc.markdown;

    const el = document.createElement("div");
    el.className = `editor-pane editor-pane-${view}`;
    el.hidden = true; // present() reveals the panes it wants
    this.root.appendChild(el);

    const pane: Pane = {
      tabId,
      view,
      syncedRev: this.revOf(tabId),
      configEpoch: this.configEpoch,
      el,
      wysiwyg: null,
      raw: null,
    };
    this.panes.set(paneKey(tabId, view), pane);

    /** Bring a split pane up to date before it takes input. A pane's edit
     *  replaces the tab's whole text, so it must already hold the other pane's
     *  latest edit. Runs on pointerdown in the capture phase, so it also runs
     *  before Crepe controls in the pane that act on pointerdown or stop it,
     *  such as task checkboxes and table buttons, and before the editors place
     *  the caret on mousedown. Also runs when the keyboard moves focus in. */
    const catchUp = (): void => {
      if (this.layout === "split" && tabId === this.activeTabId) this.flush({ keepTypedMark: view === "wysiwyg" });
    };
    el.addEventListener("pointerdown", catchUp, true);
    el.addEventListener("focusin", catchUp);

    // Bound to this tab id so a background pane writes to its own tab, never the
    // active doc. A real change advances the tab's rev (staling its other view)
    // and, in the split, mirrors into the other visible pane. A report made
    // during our own mirror sync is ignored (applyingSync). The document pane's
    // later report of a sync carries the mirrored text, so it changes nothing.
    const onChange = (m: string): void => {
      if (this.disposed || this.applyingSync || this.panes.get(paneKey(tabId, view)) !== pane) {
        return;
      }
      // A pane that lags the tab holds older text, and its report would write
      // that text over the tab's newer text. The document pane reports after
      // typing pauses, so it lags a newer Markdown edit until the pending mirror
      // sync brings it up to date. The Markdown pane lags a reload from disk or
      // a file opened into its tab. It stays on screen and editable while the
      // panes for the new text build, until they replace it, or until another
      // tab's panes do when the user switched tabs meanwhile.
      if (pane.syncedRev !== this.revOf(tabId)) return;
      if (applyEditorMarkdownForTab(this.store, tabId, m)) {
        this.bumpRev(tabId, pane);
        if (this.layout === "split" && tabId === this.activeTabId) this.scheduleSync(pane);
      }
    };
    // Only the pane the find card searches can change its count. In the split
    // that is the document pane, which a Markdown edit reaches by mirror sync.
    const onFindChange = (): void => {
      if (pane === this.active()) this.findChangeHandler?.();
    };

    if (view === "wysiwyg") {
      this.forgetPendingImageAnswers();
      const editor = new WysiwygEditor();
      pane.wysiwyg = editor;
      try {
        await editor.mount(
          el,
          markdown,
          // Find can scroll the document again once a code block is drawn,
          // after the step's own suppression has run out.
          { onChange, onFindChange, onFindScroll: () => this.suppressMirrorScroll() },
          serializerStyleFromSettings(this.store.get().settings),
          this.wysiwygContext(tabId),
        );
      } catch (err) {
        // A failed partial Crepe create must not poison the pane cache. Detach it
        // now so a later presentation can make a clean attempt.
        await this.destroyPane(pane).catch(() => {});
        if (this.disposed) return null;
        throw err;
      }
      // Disposal or another rebuild may have removed this pane while Crepe was
      // creating. Its teardown has already been initiated; never show it.
      if (this.disposed || this.panes.get(paneKey(tabId, view)) !== pane) return null;
      if (!this.hasTab(tabId)) {
        await this.destroyPane(pane).catch(() => {});
        return null;
      }
    } else {
      const editor = new RawEditor();
      pane.raw = editor;
      try {
        editor.mount(
          el,
          markdown,
          { onChange, onFindChange },
          { collapseBase64: this.store.get().settings.collapseBase64InRawView },
        );
      } catch (err) {
        await this.destroyPane(pane).catch(() => {});
        if (this.disposed) return null;
        throw err;
      }
    }
    return pane;
  }

  // ── split-view mirror sync (§6.1) ────────────────────────────────────────────

  /** Schedule mirroring the source pane's edit into the other visible pane. */
  private scheduleSync(source: Pane): void {
    if (this.disposed) return;
    this.cancelSync();
    const timer = setTimeout(() => {
      this.pendingSync = null;
      this.runSync(source);
    }, SYNC_DEBOUNCE_MS);
    this.pendingSync = { timer, source };
  }

  /** Run a scheduled mirror sync now rather than after the debounce. */
  private runPendingSync(): void {
    const pending = this.pendingSync;
    if (!pending) return;
    this.cancelSync();
    this.runSync(pending.source);
  }

  /** Drop a scheduled mirror sync without running it. */
  private cancelSync(): void {
    if (this.pendingSync) {
      clearTimeout(this.pendingSync.timer);
      this.pendingSync = null;
    }
  }

  /** Push the current canonical into the sibling (non-authoring) pane so the split
   *  stays in sync. `applyingSync` ignores any report made while the panes are
   *  written. The document pane reports about 200ms later with the exact
   *  canonical text, which changes nothing, and `onChange` drops that report if
   *  a newer Markdown edit landed first. So a sync never loops or clobbers the
   *  author. */
  private runSync(source: Pane): void {
    if (this.disposed || this.layout !== "split" || source.tabId !== this.activeTabId) return;
    const otherView: View = source.view === "wysiwyg" ? "raw" : "wysiwyg";
    const sibling = this.panes.get(paneKey(source.tabId, otherView));
    if (!sibling) return;
    const tab = this.store.get().tabs.find((t) => t.id === source.tabId);
    if (!tab) return;
    const canonical = tab.doc.markdown;
    this.applyingSync = true;
    try {
      sibling.raw?.setText(canonical);
      sibling.wysiwyg?.setMarkdown(canonical);
      sibling.syncedRev = this.revOf(source.tabId); // sibling now mirrors canonical
    } finally {
      this.applyingSync = false;
    }
  }

  // ── split-view layout / divider (§6.1) ───────────────────────────────────────

  /** Apply the split class + the document/Markdown width ratio, and show or hide
   *  the draggable divider. */
  private layoutSplit(): void {
    if (this.disposed) return;
    const split = this.layout === "split";
    this.root.classList.toggle("split", split);
    if (split) {
      const divider = this.ensureDivider();
      divider.hidden = false;
      this.applySplitRatio(this.leftRatio);
    } else if (this.divider) {
      this.divider.hidden = true;
    }
  }

  /** The divider element, created (and re-attached after an `unmount`) on demand. */
  private ensureDivider(): HTMLElement {
    if (!this.divider) {
      const d = document.createElement("div");
      d.className = "split-divider";
      d.setAttribute("role", "separator");
      d.setAttribute("aria-orientation", "vertical");
      d.setAttribute("aria-label", "Resize Markdown split");
      d.setAttribute("aria-valuemin", String(SPLIT_MIN_RATIO * 100));
      d.setAttribute("aria-valuemax", String(SPLIT_MAX_RATIO * 100));
      d.tabIndex = 0;
      d.addEventListener("pointerdown", (e) => this.beginDrag(e));
      d.addEventListener("keydown", (e) => this.resizeWithKeyboard(e));
      this.divider = d;
    }
    if (this.divider.parentElement !== this.root) this.root.appendChild(this.divider);
    return this.divider;
  }

  private applySplitRatio(ratio: number): void {
    this.leftRatio = Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, ratio));
    const percent = this.leftRatio * 100;
    this.root.style.setProperty("--split-left", `${percent.toFixed(3)}%`);
    this.divider?.setAttribute("aria-valuenow", String(Math.round(percent)));
    this.divider?.setAttribute("aria-valuetext", `${Math.round(percent)}% document`);
  }

  private resizeWithKeyboard(event: KeyboardEvent): void {
    if (this.disposed || this.layout !== "split") return;
    let next = this.leftRatio;
    if (event.key === "ArrowLeft") next -= 0.02;
    else if (event.key === "ArrowRight") next += 0.02;
    else if (event.key === "Home") next = SPLIT_MIN_RATIO;
    else if (event.key === "End") next = SPLIT_MAX_RATIO;
    else return;
    event.preventDefault();
    this.applySplitRatio(next);
    if (this.activeTabId) this.panes.get(paneKey(this.activeTabId, "raw"))?.raw?.onShow(false);
  }

  private beginDrag(e: PointerEvent): void {
    if (this.disposed || !this.divider) return;
    this.endDrag();
    e.preventDefault();
    const startX = e.clientX;
    const startRatio = this.leftRatio;
    const width = this.root.clientWidth || 1;
    const pointerId = e.pointerId;
    this.dragPointerId = pointerId;
    this.divider.classList.add("dragging");
    this.divider.setPointerCapture(pointerId);

    const onMove = (ev: PointerEvent): void => {
      if (this.disposed) return;
      const ratio = startRatio + (ev.clientX - startX) / width;
      this.applySplitRatio(ratio);
    };
    const onUp = (): void => {
      this.endDrag();
      // CodeMirror caches viewport metrics; re-measure after the resize settles.
      if (!this.disposed && this.activeTabId) {
        this.panes.get(paneKey(this.activeTabId, "raw"))?.raw?.onShow(false);
      }
    };
    this.dragCleanup = () => {
      this.divider?.removeEventListener("pointermove", onMove);
      this.divider?.removeEventListener("pointerup", onUp);
      this.divider?.removeEventListener("pointercancel", onUp);
    };
    this.divider.addEventListener("pointermove", onMove);
    this.divider.addEventListener("pointerup", onUp);
    this.divider.addEventListener("pointercancel", onUp);
  }

  private endDrag(): void {
    const divider = this.divider;
    const pointerId = this.dragPointerId;
    if (
      divider &&
      pointerId !== null &&
      typeof divider.hasPointerCapture === "function" &&
      divider.hasPointerCapture(pointerId)
    ) {
      try {
        divider.releasePointerCapture(pointerId);
      } catch {
        // Capture may have been released by the browser between the check and
        // this call (e.g. as the WebView loses focus during teardown).
      }
    }
    divider?.classList.remove("dragging");
    this.dragCleanup?.();
    this.dragCleanup = null;
    this.dragPointerId = null;
  }

  private async destroyPane(pane: Pane): Promise<void> {
    const key = paneKey(pane.tabId, pane.view);
    if (this.panes.get(key) === pane) this.panes.delete(key);
    await this.beginPaneTeardown(pane);
  }

  /** Start a pane teardown once and publish it to terminal disposal. */
  private beginPaneTeardown(pane: Pane): Promise<void> {
    const existing = this.paneTeardowns.get(pane);
    if (existing) return existing;
    const teardown = this.teardownPane(pane);
    this.paneTeardowns.set(pane, teardown);
    this.pendingTeardowns.add(teardown);
    void teardown.then(
      () => this.pendingTeardowns.delete(teardown),
      () => this.pendingTeardowns.delete(teardown),
    );
    return teardown;
  }

  private async teardownPane(pane: Pane): Promise<void> {
    // Detach/silence synchronously. WYSIWYG destruction may await an in-flight
    // Crepe create, but no dead pane remains visible or able to publish changes.
    const wysiwyg = pane.wysiwyg;
    const raw = pane.raw;
    pane.wysiwyg = null;
    pane.raw = null;
    pane.el.remove();
    raw?.destroy();
    if (wysiwyg) await wysiwyg.destroy();
  }

  private async destroyAllPanes(): Promise<void> {
    const all = [...this.panes.values()];
    this.panes.clear();
    this.rev.clear();
    this.tabMru = [];
    this.activeTabId = null;
    this.currentView = null;
    await Promise.allSettled(all.map((pane) => this.beginPaneTeardown(pane)));
  }

  /** Distinct tab ids with at least one live pane, most-recent first. */
  private retainedTabs(): string[] {
    return this.tabMru.filter(
      (id) => this.panes.has(paneKey(id, "wysiwyg")) || this.panes.has(paneKey(id, "raw")),
    );
  }

  private hasTab(tabId: string): boolean {
    return this.store.get().tabs.some((tab) => tab.id === tabId);
  }

  /** Whether the tab's Document view failed to build and has not built since. */
  private hasFailed(tabId: string | null): boolean {
    return !!this.store.get().tabs.find((tab) => tab.id === tabId)?.documentViewFailure;
  }

  private async enforceLru(): Promise<void> {
    if (this.disposed) return;
    const cap = Math.max(1, Math.floor(this.store.get().settings.maxRetainedTabEditors ?? 5));
    // Least-recent first, never the active tab.
    const evictable = this.retainedTabs()
      .filter((id) => id !== this.activeTabId)
      .reverse();
    let count = this.retainedTabs().length;
    for (const id of evictable) {
      if (this.disposed || count <= cap) break;
      await this.evictTab(id);
      count -= 1;
    }
  }

  private async evictTab(tabId: string): Promise<void> {
    if (this.disposed) return;
    for (const view of ["wysiwyg", "raw"] as View[]) {
      if (this.disposed) return;
      const pane = this.panes.get(paneKey(tabId, view));
      if (!pane) continue;
      // A tab switch already reported this tab's typing (`flush`), so this is a
      // safeguard. A stale pane's report is dropped by its change callback.
      pane.wysiwyg?.reportPendingChange();
      await this.destroyPane(pane);
    }
    this.rev.delete(tabId);
    this.tabMru = this.tabMru.filter((t) => t !== tabId);
  }

  /** Context handed to the WYSIWYG editor's custom plugins (image/paste, etc.),
   *  bound to a specific tab so a background pane reads its own file path. */
  private wysiwygContext(tabId: string): WysiwygContext {
    return {
      getSettings: () => this.store.get().settings,
      getFilePath: () => {
        const tab = this.store.get().tabs.find((t) => t.id === tabId);
        return tab ? tab.doc.filePath : this.store.get().doc.filePath;
      },
      requestSave: () => this.saveHandler?.() ?? Promise.resolve(false),
      openMarkdownFile: (path) => this.openLinkHandler?.(path),
    };
  }
}
