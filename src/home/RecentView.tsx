import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { KeyboardEvent } from "react";
import { FolderOpen } from "lucide-react";
import type { RecentEntry } from "@/state/types";
import type { FileStat } from "@/ipc/contracts";
import type { RecentDataSource } from "./recentData";
import { fileName, dirName } from "./recentFormat";
import {
  buildListing,
  emptyNote,
  recentSummary,
  searchStatus,
  widestSearchStatus,
  type ContentHit,
  type RecentListing,
  type SearchPhase,
  type SearchScope,
} from "./recentListing";
import { RecentSearchField } from "./RecentSearchField";
import { RecentCaption, RecentRow } from "./RecentRow";
import { showContextMenu } from "@/shell/contextMenu";
import { openMissingFileDialog } from "./MissingFileDialog";
import { cn } from "@/lib/utils";
import { disposeReactRoot } from "@/app/disposeReactRoot";
import { Button } from "@/components/ui/button";
import { FileCopyIcon, FolderCopyIcon } from "@/components/icons";

export interface RecentViewCallbacks {
  onOpenFile(path: string): void;
  onSummaryChange(text: string): void;
  pickFile(): Promise<string | null>;
  reveal(path: string): void | Promise<void>;
  copy(text: string): void | Promise<void>;
}

/** Name filtering waits for a short pause in typing; content search for a longer one. */
const NAME_DEBOUNCE_MS = 200;
const CONTENT_DEBOUNCE_MS = 400;
/** File row height, for Page Up and Page Down. */
const ROW_HEIGHT = 64;

/**
 * The Recent page, after Mervin PDF's: a search field with Names / Contents / All
 * scopes above one list with starred files pinned under "Favorites" and the rest
 * of the history under "Recent". The class owns the state and renders through
 * its own React root into `element`.
 */
export class RecentView {
  readonly element = document.createElement("div");
  private readonly root: Root;
  private searchInput: HTMLInputElement | null = null;
  private listElement: HTMLDivElement | null = null;
  private entries: RecentEntry[] = [];
  private readonly stats = new Map<string, FileStat>();
  private scope: SearchScope = "names";
  private query = "";
  private renderedNameQuery = "";
  private readonly contentHits = new Map<string, ContentHit>();
  private phase: SearchPhase = "idle";
  private scanned = 0;
  /**
   * The section each row starred or unstarred during this visit was listed in.
   * The row keeps its place until the query or scope changes or Recent is left,
   * so a mistaken click is undone by clicking the same star again.
   */
  private readonly keptSections = new Map<string, boolean>();
  /** The row that holds the list's single tab stop. */
  private currentPath: string | null = null;
  private searchSeq = 0;
  private prevSearchId: string | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private nameTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private missingDialogAbort: AbortController | null = null;

  constructor(
    private readonly data: RecentDataSource,
    private readonly getVisibleCount: () => number,
    private readonly cb: RecentViewCallbacks,
  ) {
    this.element.dataset.reactRecentView = "";
    this.element.className = "h-full";
    this.root = createRoot(this.element);
    this.render();
  }

  /** Reload the history. Called each time Recent is shown. */
  async refresh(): Promise<void> {
    const focusBefore = document.activeElement;
    try {
      this.entries = await this.data.list();
    } catch {
      this.entries = [];
    }
    if (this.destroyed) return;
    this.stats.clear();
    this.keptSections.clear();
    this.resetContentSearch();
    this.scheduleContentSearch();
    this.render();
    this.focusSearchOnShow(focusBefore);
  }

  focusSearch(): void {
    this.searchInput?.focus();
    this.searchInput?.select();
  }

  onLeave(): void {
    if (this.nameTimer) clearTimeout(this.nameTimer);
    this.nameTimer = null;
    this.renderedNameQuery = this.query;
    this.keptSections.clear();
    this.resetContentSearch();
    this.render();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resetContentSearch();
    if (this.nameTimer) clearTimeout(this.nameTimer);
    this.nameTimer = null;
    this.missingDialogAbort?.abort();
    this.missingDialogAbort = null;
    this.searchInput = null;
    this.listElement = null;
    disposeReactRoot(this.root, this.element);
  }

  /**
   * Mervin focuses the search field whenever Recent opens. Take focus only while
   * the view is on screen, the user has not moved focus since the refresh began,
   * and no dialog or menu holds it.
   */
  private focusSearchOnShow(focusBefore: Element | null): void {
    if (!this.element.isConnected || this.element.getClientRects().length === 0) return;
    const active = document.activeElement;
    if (active && active !== focusBefore && active !== document.body) return;
    if (active?.closest("[role='dialog'], [role='alertdialog'], [role='menu']")) return;
    this.focusSearch();
  }

  /** The file-name filter the list applies; the Contents scope has none. */
  private nameQuery(): string {
    return this.scope === "contents" ? "" : this.renderedNameQuery.trim();
  }

  /** The content query, or "" when the scope does not search contents. */
  private contentQuery(): string {
    return this.scope === "names" ? "" : this.query.trim();
  }

  private readonly bindSearchInput = (element: HTMLInputElement | null): void => {
    this.searchInput = element;
    if (element) element.oninput = () => this.onInput(element.value);
  };

  private readonly bindList = (element: HTMLDivElement | null): void => {
    this.listElement = element;
  };

  private onInput(value: string): void {
    this.query = value;
    this.keptSections.clear();
    this.resetContentSearch();
    if (this.nameTimer) clearTimeout(this.nameTimer);
    this.nameTimer = setTimeout(() => {
      this.nameTimer = null;
      this.renderedNameQuery = this.query;
      this.render();
    }, NAME_DEBOUNCE_MS);
    this.scheduleContentSearch();
    this.render();
  }

  private setScope(scope: SearchScope): void {
    if (this.scope === scope) return;
    this.scope = scope;
    if (this.nameTimer) clearTimeout(this.nameTimer);
    this.nameTimer = null;
    this.renderedNameQuery = this.query;
    this.keptSections.clear();
    this.resetContentSearch();
    this.scheduleContentSearch();
    this.render();
  }

  private clearQuery(): void {
    this.query = "";
    this.renderedNameQuery = "";
    if (this.searchInput) this.searchInput.value = "";
    if (this.nameTimer) clearTimeout(this.nameTimer);
    this.nameTimer = null;
    this.keptSections.clear();
    this.resetContentSearch();
    this.render();
  }

  private onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      this.clearQuery();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      this.focusList();
    }
  }

  /** Focus the list's current row, or its first row. */
  private focusList(): void {
    const list = this.listElement;
    const target =
      list?.querySelector<HTMLButtonElement>(".recent-row-open[tabindex='0']") ??
      list?.querySelector<HTMLButtonElement>(".recent-row-open");
    target?.focus();
  }

  /** Arrow keys, Home, End, Page Up and Page Down move between rows; Right and Left
   * step between a row and its star. Up from the first row returns to the field. */
  private onListKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const row = target.closest<HTMLElement>(".recent-row");
    if (!row) return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(".recent-row"));
    const index = rows.indexOf(row);
    const onStar = target.classList.contains("recent-star");
    const page = Math.max(1, Math.floor(event.currentTarget.clientHeight / ROW_HEIGHT));
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = index + 1;
        break;
      case "ArrowUp":
        if (index === 0) {
          event.preventDefault();
          this.focusSearch();
          return;
        }
        next = index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = rows.length - 1;
        break;
      case "PageDown":
        next = index + page;
        break;
      case "PageUp":
        next = index - page;
        break;
      case "ArrowRight":
        if (!onStar) {
          event.preventDefault();
          row.querySelector<HTMLButtonElement>(".recent-star")?.focus();
        }
        return;
      case "ArrowLeft":
        if (onStar) {
          event.preventDefault();
          row.querySelector<HTMLButtonElement>(".recent-row-open")?.focus();
        }
        return;
      default:
        return;
    }
    event.preventDefault();
    const destination = rows[Math.max(0, Math.min(rows.length - 1, next))];
    destination.querySelector<HTMLButtonElement>(onStar ? ".recent-star" : ".recent-row-open")?.focus();
  }

  private onRowFocus(path: string): void {
    if (this.currentPath === path) return;
    this.currentPath = path;
    this.render();
  }

  /** Arm the content search after the typing pause, if the scope searches contents. */
  private scheduleContentSearch(): void {
    if (!this.contentQuery()) return;
    this.phase = "pending";
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      void this.runContentSearch();
    }, CONTENT_DEBOUNCE_MS);
  }

  /** Drop the pending or running content search and its hits. */
  private resetContentSearch(): void {
    this.cancelContentSearch();
    this.contentHits.clear();
    this.phase = "idle";
    this.scanned = 0;
  }

  private cancelContentSearch(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
    if (this.prevSearchId) this.data.cancelContentSearch(this.prevSearchId);
    this.prevSearchId = null;
    this.searchSeq++;
  }

  /** Stop: end the scan but keep what it found. */
  private stopContentSearch(): void {
    if (this.phase !== "pending" && this.phase !== "running") return;
    this.cancelContentSearch();
    this.phase = "stopped";
    this.render();
  }

  private async runContentSearch(): Promise<void> {
    const query = this.contentQuery();
    if (!query) {
      this.phase = "idle";
      this.render();
      return;
    }
    const seq = ++this.searchSeq;
    const searchId = `recent-search-${seq}`;
    const current = (): boolean => seq === this.searchSeq && !this.destroyed;
    this.prevSearchId = searchId;
    this.contentHits.clear();
    this.phase = "running";
    this.scanned = 0;
    this.render();
    try {
      const summary = await this.data.searchContents(searchId, query, {
        onHit: (path, line, snippet) => {
          if (!current()) return;
          this.contentHits.set(path, { line, snippet });
          this.render();
        },
        onProgress: (scanned) => {
          if (!current()) return;
          this.scanned = scanned;
          this.render();
        },
      });
      if (!current()) return;
      this.prevSearchId = null;
      this.phase = summary.cancelled ? "idle" : "done";
      this.render();
    } catch {
      if (!current()) return;
      this.prevSearchId = null;
      this.phase = "idle";
      this.render();
    }
  }

  private listing(): RecentListing {
    return buildListing({
      entries: this.entries,
      scope: this.scope,
      nameQuery: this.nameQuery(),
      contentQuery: this.contentQuery(),
      hits: this.contentHits,
      visibleCount: this.getVisibleCount(),
      inFavorites: (entry) => this.keptSections.get(entry.path) ?? entry.favorite,
    });
  }

  private render(): void {
    if (this.destroyed) return;
    const { favorites, recent } = this.listing();
    const rows = [...favorites, ...recent];
    const nameQuery = this.nameQuery();
    const contentQuery = this.contentQuery();
    const filter = this.scope === "names" ? nameQuery : contentQuery;
    this.cb.onSummaryChange(recentSummary(Boolean(nameQuery || contentQuery), rows));
    const empty = rows.length ? "" : emptyNote(this.scope, filter, this.phase);
    const status = contentQuery
      ? searchStatus(this.phase, this.scanned, this.entries.length, rows.length)
      : null;
    const tabStop = rows.some((row) => row.entry.path === this.currentPath)
      ? this.currentPath
      : (rows[0]?.entry.path ?? null);
    const now = Date.now();
    const renderRows = (section: typeof rows) =>
      section.map((row) => (
        <RecentRow
          key={row.entry.path}
          row={row}
          stat={this.stats.get(row.entry.path)}
          nameQuery={row.hit ? "" : nameQuery}
          snippetQuery={contentQuery}
          now={now}
          tabStop={row.entry.path === tabStop}
          onOpen={() => void this.openEntry(row.entry)}
          onMenu={(x, y) => this.showRowMenu(row.entry, x, y)}
          onToggleStar={() => void this.toggleFavorite(row.entry)}
          onFocus={() => this.onRowFocus(row.entry.path)}
        />
      ));
    flushSync(() => {
      this.root.render(
        <div className="recent-view flex h-full flex-col bg-window px-6 pt-4 pb-3">
          <div className="recent-searchbar mb-3 flex h-[29px] shrink-0 items-center">
            <RecentSearchField
              scope={this.scope}
              defaultValue={this.query}
              hasQuery={this.query !== ""}
              inputRef={this.bindSearchInput}
              onScope={(scope) => this.setScope(scope)}
              onClear={() => this.clearQuery()}
              onKeyDown={(event) => this.onSearchKeyDown(event)}
            />
            <div
              className={cn(
                "recent-progress ml-4 text-[12px] whitespace-nowrap",
                status?.running ? "text-ink" : "text-ink-soft",
              )}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {status && (
                <span className="grid">
                  {/* While the scan runs the label keeps the width of its longest
                      text, so Stop never moves as the count grows. */}
                  {status.running && (
                    <span className="invisible col-start-1 row-start-1" aria-hidden="true">
                      {`${widestSearchStatus(this.entries.length)} `}
                    </span>
                  )}
                  <span className="recent-progress-text col-start-1 row-start-1">{status.text}</span>
                </span>
              )}
            </div>
            {status?.running && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="recent-search-stop ml-[10px] bg-transparent"
                // Tab focus only: a click leaves the caret in the field.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => this.stopContentSearch()}
              >
                Stop
              </Button>
            )}
          </div>
          <div
            ref={this.bindList}
            className="recent-list flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto bg-popover dark:bg-well"
            onKeyDown={(event) => this.onListKeyDown(event)}
          >
            {favorites.length > 0 && <RecentCaption first>Favorites</RecentCaption>}
            {renderRows(favorites)}
            {favorites.length > 0 && recent.length > 0 && (
              <RecentCaption first={false}>Recent</RecentCaption>
            )}
            {renderRows(recent)}
            {empty && (
              <div className="recent-empty flex h-9 shrink-0 items-center px-4 text-[12px] text-ink-disabled">
                {empty}
              </div>
            )}
          </div>
        </div>,
      );
    });
    if (rows.length) void this.ensureStats(rows.map(({ entry }) => entry.path));
  }

  private async ensureStats(paths: string[]): Promise<void> {
    const unknown = paths.filter((path) => !this.stats.has(path));
    if (!unknown.length) return;
    try {
      for (const stat of await this.data.stat(unknown)) this.stats.set(stat.path, stat);
      this.render();
    } catch {
      // Rows remain usable without size/missing metadata.
    }
  }

  private async toggleFavorite(entry: RecentEntry): Promise<void> {
    const previous = entry.favorite;
    if (!this.keptSections.has(entry.path)) this.keptSections.set(entry.path, previous);
    entry.favorite = !previous;
    this.render();
    try {
      await this.data.setFavorite(entry.path, entry.favorite);
    } catch {
      entry.favorite = previous;
      this.render();
    }
  }

  private async openEntry(entry: RecentEntry): Promise<void> {
    let stat = this.stats.get(entry.path);
    if (!stat) {
      const [resolved] = await this.data.stat([entry.path]).catch(() => []);
      if (resolved) {
        this.stats.set(resolved.path, resolved);
        stat = resolved;
      }
    }
    if (stat && !stat.exists) {
      await this.handleMissing(entry);
      return;
    }
    this.cb.onOpenFile(entry.path);
  }

  private async handleMissing(entry: RecentEntry): Promise<void> {
    this.missingDialogAbort?.abort();
    const controller = new AbortController();
    this.missingDialogAbort = controller;
    const action = await openMissingFileDialog(fileName(entry.path), controller.signal);
    if (this.missingDialogAbort === controller) this.missingDialogAbort = null;
    if (this.destroyed || controller.signal.aborted) return;
    if (action === "locate") {
      const picked = await this.cb.pickFile();
      if (picked) {
        await this.data.remove(entry.path).catch(() => {});
        this.cb.onOpenFile(picked);
        await this.refresh();
      }
    } else if (action === "remove") {
      await this.data.remove(entry.path).catch(() => {});
      await this.refresh();
    }
  }

  private showRowMenu(entry: RecentEntry, x: number, y: number): void {
    const folder = dirName(entry.path);
    const stat = this.stats.get(entry.path);
    const folderMissing = stat ? !stat.folderExists : false;
    showContextMenu(x, y, [
      { label: "Open", run: () => this.openEntry(entry) },
      {
        label: "Open folder",
        icon: FolderOpen,
        separatorBefore: true,
        disabled: folderMissing,
        run: () => void this.cb.reveal(entry.path),
      },
      {
        label: "Copy file path",
        icon: FileCopyIcon,
        separatorBefore: true,
        run: () => void this.cb.copy(entry.path),
      },
      { label: "Copy folder path", icon: FolderCopyIcon, run: () => void this.cb.copy(folder) },
    ]);
  }
}
