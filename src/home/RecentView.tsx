import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { FileText, Search, X } from "lucide-react";
import type { ReactNode } from "react";
import type { RecentEntry } from "@/state/types";
import type { FileStat } from "@/ipc/contracts";
import type { RecentDataSource } from "./recentData";
import {
  fileName,
  dirName,
  formatDate,
  formatSize,
  filterByName,
  favoritesSorted,
} from "./recentFormat";
import { showContextMenu } from "@/shell/contextMenu";
import { openMissingFileDialog } from "./MissingFileDialog";
import { cn } from "@/lib/utils";
import { disposeReactRoot } from "@/app/disposeReactRoot";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export interface RecentViewCallbacks {
  onOpenFile(path: string): void;
  onSummaryChange(text: string): void;
  pickFile(): Promise<string | null>;
  reveal(path: string): void | Promise<void>;
  copy(text: string): void | Promise<void>;
}

type Mode = "all" | "favorites";
type Scope = "name" | "inside";

interface ContentHit {
  line: number;
  snippet: string;
}

interface RowModel {
  entry: RecentEntry;
  hit?: ContentHit;
}

export class RecentView {
  readonly element = document.createElement("div");
  private readonly root: Root;
  private searchInput: HTMLInputElement | null = null;
  private entries: RecentEntry[] = [];
  private readonly stats = new Map<string, FileStat>();
  private mode: Mode = "all";
  private scope: Scope = "name";
  private query = "";
  private renderedNameQuery = "";
  private progressText = "";
  private readonly contentHits = new Map<string, ContentHit>();
  private searchSeq = 0;
  private prevSearchId: string | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private nameTimer: ReturnType<typeof setTimeout> | null = null;
  private contentSearchSettled = false;
  private destroyed = false;
  private missingDialogAbort: AbortController | null = null;

  constructor(
    private readonly data: RecentDataSource,
    private readonly getVisibleCount: () => number,
    private readonly cb: RecentViewCallbacks,
  ) {
    this.element.dataset.reactRecentView = "";
    this.root = createRoot(this.element);
    this.render();
  }

  async refresh(): Promise<void> {
    try {
      this.entries = await this.data.list();
    } catch {
      this.entries = [];
    }
    if (this.destroyed) return;
    this.stats.clear();
    this.stopContentSearch();
    this.setProgress("");
    this.render();
    if (this.scope === "inside" && this.query.trim()) this.scheduleContentSearch();
  }

  focusSearch(): void {
    this.searchInput?.focus();
    this.searchInput?.select();
  }

  onLeave(): void {
    this.stopContentSearch();
    this.setProgress("");
    this.render();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopContentSearch();
    if (this.nameTimer) clearTimeout(this.nameTimer);
    this.nameTimer = null;
    this.missingDialogAbort?.abort();
    this.missingDialogAbort = null;
    this.searchInput = null;
    disposeReactRoot(this.root, this.element);
  }

  private setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.render();
    this.refreshContentCount();
  }

  private setScope(scope: Scope): void {
    if (this.scope === scope) return;
    this.scope = scope;
    this.stopContentSearch();
    this.setProgress("");
    if (scope === "inside" && this.query.trim()) this.scheduleContentSearch();
    this.render();
  }

  private onInput(value: string): void {
    this.query = value;
    if (this.scope === "inside") {
      this.stopContentSearch();
      this.setProgress("");
      this.render();
      this.scheduleContentSearch();
      return;
    }
    if (this.nameTimer) clearTimeout(this.nameTimer);
    this.render();
    this.nameTimer = setTimeout(() => {
      this.renderedNameQuery = this.query;
      this.render();
    }, 200);
  }

  private clearQuery(): void {
    this.query = "";
    this.renderedNameQuery = "";
    if (this.searchInput) this.searchInput.value = "";
    if (this.nameTimer) clearTimeout(this.nameTimer);
    this.nameTimer = null;
    this.stopContentSearch();
    this.setProgress("");
    this.render();
  }

  private scheduleContentSearch(): void {
    this.contentSearchSettled = false;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (this.scope !== "inside") return;
    this.searchTimer = setTimeout(() => void this.runContentSearch(), 400);
  }

  private stopContentSearch(): void {
    this.contentSearchSettled = false;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
    if (this.prevSearchId) this.data.cancelContentSearch(this.prevSearchId);
    this.prevSearchId = null;
    this.searchSeq++;
    this.contentHits.clear();
  }

  private async runContentSearch(): Promise<void> {
    const query = this.query.trim();
    if (this.scope !== "inside" || !query) {
      this.setProgress("");
      this.render();
      return;
    }
    if (this.prevSearchId) this.data.cancelContentSearch(this.prevSearchId);
    const seq = ++this.searchSeq;
    const searchId = `recent-search-${seq}`;
    this.prevSearchId = searchId;
    this.contentHits.clear();
    this.setProgress("Searching file contents…");
    this.render();
    try {
      const summary = await this.data.searchContents(searchId, query, {
        onHit: (path, line, snippet) => {
          if (seq !== this.searchSeq || this.destroyed) return;
          this.contentHits.set(path, { line, snippet });
          this.render();
        },
        onProgress: (scanned) => {
          if (seq !== this.searchSeq || this.destroyed) return;
          this.setProgress(`Searching file contents… ${scanned} / ${this.entries.length}`);
          this.render();
        },
      });
      if (seq !== this.searchSeq || this.destroyed) return;
      this.prevSearchId = null;
      if (summary.cancelled) {
        this.setProgress("");
        this.render();
        return;
      }
      this.contentSearchSettled = true;
      this.showContentCount(query);
      this.render();
    } catch {
      if (seq === this.searchSeq && !this.destroyed) {
        this.setProgress("");
        this.render();
      }
    }
  }

  private setProgress(text: string): void {
    this.progressText = text;
  }

  private contentMatches(): RecentEntry[] {
    const base = this.mode === "favorites" ? favoritesSorted(this.entries) : this.entries;
    return base.filter((entry) => this.contentHits.has(entry.path));
  }

  private showContentCount(query: string): void {
    const q = query.trim();
    if (this.scope !== "inside" || !q) return;
    const count = this.contentMatches().length;
    this.setProgress(
      count > 0
        ? `${count} file${count === 1 ? "" : "s"} found`
        : this.mode === "favorites"
          ? `No favorites contain "${q}"`
          : `No files contain "${q}"`,
    );
  }

  private refreshContentCount(): void {
    if (this.scope === "inside" && this.contentSearchSettled) {
      this.showContentCount(this.query);
      this.render();
    }
  }

  private rows(): { rows: RowModel[]; empty: string; nameQuery: string } {
    const insideQuery = this.query.trim();
    const nameQuery = this.scope === "name" ? this.renderedNameQuery.trim() : "";
    const favorites = favoritesSorted(this.entries);
    if (this.scope === "inside" && insideQuery) {
      return {
        rows: this.contentMatches().map((entry) => ({ entry, hit: this.contentHits.get(entry.path) })),
        empty: "",
        nameQuery: "",
      };
    }
    let base = this.mode === "favorites" ? favorites : this.entries;
    if (nameQuery) base = filterByName(base, nameQuery);
    else if (this.mode === "all") base = base.slice(0, this.getVisibleCount());
    let empty = "";
    if (this.entries.length === 0) empty = "No recent files yet";
    else if (this.mode === "favorites" && favorites.length === 0) empty = "No favorites yet";
    else if (nameQuery && base.length === 0) empty = "No recent files match the filter";
    return { rows: base.map((entry) => ({ entry })), empty, nameQuery };
  }

  private render(): void {
    if (this.destroyed) return;
    const { rows, empty, nameQuery } = this.rows();
    const count = rows.length;
    this.cb.onSummaryChange(
      this.mode === "favorites"
        ? "Your starred documents"
        : `Your last ${count} opened document${count === 1 ? "" : "s"}`,
    );
    const now = Date.now();
    flushSync(() => {
      this.root.render(
        <div className="recent-view h-full overflow-auto bg-[var(--editor-bg)]">
          <div className="recent-inner mx-auto max-w-[860px] px-6 pt-7 pb-16">
            <h1 className="recent-heading mt-0 mb-[14px] text-[24px] font-semibold">Recent files</h1>
            <ToggleGroup
              type="single"
              value={this.mode}
              className="segmented recent-modes mb-[14px] inline-flex overflow-hidden rounded-[7px] border border-[var(--chrome-border)] bg-[var(--chrome-bg)]"
              role="group"
              aria-label="Recent file filter"
              onValueChange={(value) => {
                if (value) this.setMode(value as Mode);
              }}
            >
              <Segment value="all" active={this.mode === "all"}>All</Segment>
              <Segment value="favorites" active={this.mode === "favorites"}>Favorites</Segment>
            </ToggleGroup>
            <div className="recent-searchbar mb-[6px] flex items-center gap-3">
              <div className="recent-search-wrap flex flex-1 items-center gap-[6px] rounded-[7px] border border-[var(--chrome-border)] bg-[var(--editor-bg)] px-[10px] py-[5px] focus-within:border-[var(--accent)]">
                <span className="recent-search-icon text-[13px] opacity-70"><Search aria-hidden="true" /></span>
                <input
                  ref={(element) => {
                    this.searchInput = element;
                    if (element) element.oninput = () => this.onInput(element.value);
                  }}
                  type="text"
                  className="recent-search-input flex-1 border-0 bg-transparent font-[inherit] text-[13px] text-[var(--chrome-fg)] outline-none"
                  aria-label={this.scope === "inside" ? "Search inside recent documents" : "Search recent file names"}
                  placeholder={this.scope === "inside" ? "Search inside documents" : "Search file names"}
                  defaultValue={this.query}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      this.clearQuery();
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="recent-search-clear size-auto rounded-none border-0 bg-transparent px-0.5 py-0 text-[13px] font-normal text-[var(--muted-fg)] hover:bg-transparent"
                  title="Clear"
                  aria-label="Clear"
                  style={{ visibility: this.query ? "visible" : "hidden" }}
                  onClick={() => this.clearQuery()}
                ><X aria-hidden="true" /></Button>
              </div>
              <ToggleGroup
                type="single"
                value={this.scope}
                className="segmented recent-scope inline-flex overflow-hidden rounded-[7px] border border-[var(--chrome-border)] bg-[var(--chrome-bg)]"
                role="group"
                aria-label="Search scope"
                onValueChange={(value) => {
                  if (value) this.setScope(value as Scope);
                }}
              >
                <Segment value="name" active={this.scope === "name"}>Name</Segment>
                <Segment value="inside" active={this.scope === "inside"}>Inside docs</Segment>
              </ToggleGroup>
            </div>
            <div
              className="recent-progress min-h-[1.2em] px-0.5 py-1 text-[12px] leading-[normal] text-[var(--muted-fg)]"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {this.progressText}
            </div>
            <div className="recent-list flex flex-col">
              {empty ? (
                <div className="recent-empty px-1 py-8 text-center text-[14px] leading-[normal] text-[var(--muted-fg)]">{empty}</div>
              ) : (
                rows.map(({ entry, hit }) => this.renderRow(entry, hit, nameQuery, now))
              )}
            </div>
          </div>
        </div>,
      );
    });
    if (!empty) void this.ensureStats(rows.map(({ entry }) => entry.path));
  }

  private renderRow(entry: RecentEntry, hit: ContentHit | undefined, nameQuery: string, now: number) {
    const stat = this.stats.get(entry.path);
    const missing = stat ? !stat.exists : false;
    return (
      <div
        key={entry.path}
        className={cn(
          "recent-row grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-[14px] rounded-[7px] px-[10px] py-[9px] hover:bg-[var(--chrome-bg)]",
          missing && "missing opacity-50",
        )}
        title={missing ? "This file is no longer on disk." : entry.path}
        onClick={() => void this.openEntry(entry)}
        onContextMenu={(event) => {
          event.preventDefault();
          this.showRowMenu(entry, event.clientX, event.clientY);
        }}
      >
        <button
          type="button"
          className="recent-row-open col-[1/4] grid w-full min-w-0 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-[14px] border-0 bg-transparent p-0 text-left font-[inherit] text-[inherit] [&_.recent-icon]:text-[18px] [&_.recent-icon]:leading-none [&_.recent-mid]:min-w-0 [&_.recent-name]:truncate [&_.recent-name]:text-[14px] [&_.recent-name]:leading-[normal] [&_.recent-name]:font-semibold [&_.recent-line]:font-normal [&_.recent-line]:text-[var(--muted-fg)] [&_.recent-snippet]:my-px [&_.recent-snippet]:truncate [&_.recent-snippet]:text-[12px] [&_.recent-snippet]:leading-[normal] [&_.recent-snippet]:text-[var(--muted-fg)] [&_.recent-path]:truncate [&_.recent-path]:text-left [&_.recent-path]:text-[12px] [&_.recent-path]:leading-[normal] [&_.recent-path]:text-[var(--muted-fg)] [&_.recent-path]:[direction:rtl] [&_.recent-right]:text-right [&_.recent-right]:whitespace-nowrap [&_.recent-date]:text-[12.5px] [&_.recent-date]:leading-[normal] [&_.recent-date]:text-[var(--chrome-fg)] [&_.recent-size]:text-[12px] [&_.recent-size]:leading-[normal] [&_.recent-size]:text-[var(--muted-fg)]"
          aria-label={`Open ${fileName(entry.path)}`}
        >
          <div className="recent-icon"><FileText aria-hidden="true" /></div>
          <div className="recent-mid">
            <div className="recent-name">
              <Highlighted text={fileName(entry.path)} query={nameQuery} />
              {hit && <span className="recent-line"> — line {hit.line}</span>}
            </div>
            {hit?.snippet && (
              <div className="recent-snippet"><Highlighted text={hit.snippet} query={this.query.trim()} /></div>
            )}
            <div className="recent-path">{String.fromCharCode(0x200e) + entry.path}</div>
          </div>
          <div className="recent-right">
            <div className="recent-date">{formatDate(entry.lastOpenedMs, now)}</div>
            <div className="recent-size">{stat?.exists ? formatSize(stat.sizeBytes) : ""}</div>
          </div>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "recent-star size-auto rounded-none border-0 bg-transparent px-1 py-0.5 text-[17px] leading-none font-normal text-[var(--muted-fg)] hover:bg-transparent hover:text-[#e3b341]",
            entry.favorite && "on text-[#e3b341]",
          )}
          title={entry.favorite ? "Unstar" : "Star"}
          aria-label={entry.favorite ? "Remove from favorites" : "Add to favorites"}
          onClick={(event) => {
            event.stopPropagation();
            void this.toggleFavorite(entry);
          }}
        >{entry.favorite ? "★" : "☆"}</Button>
      </div>
    );
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
    entry.favorite = !previous;
    this.render();
    this.refreshContentCount();
    try {
      await this.data.setFavorite(entry.path, entry.favorite);
    } catch {
      entry.favorite = previous;
      this.render();
      this.refreshContentCount();
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
      { label: "Open folder", separatorBefore: true, disabled: folderMissing, run: () => void this.cb.reveal(entry.path) },
      { label: "Copy folder path", run: () => void this.cb.copy(folder) },
      { label: "Copy file path", run: () => void this.cb.copy(entry.path) },
    ]);
  }
}

function Segment({ value, active, children }: { value: string; active: boolean; children: string }) {
  return (
    <ToggleGroupItem
      value={value}
      role="button"
      className={cn(
        "seg-btn cursor-pointer rounded-none border-0 border-r border-[var(--chrome-border)] bg-transparent px-[14px] py-[5px] text-[12.5px] leading-[normal] font-normal text-[var(--chrome-fg)] last:border-r-0 hover:bg-[var(--editor-bg)]",
        active && "active bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent)]",
      )}
      aria-pressed={active}
    >
      {children}
    </ToggleGroupItem>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const ranges = highlightRanges(text, query);
  if (!ranges.length) return <>{text}</>;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(
      <span
        key={`${start}-${end}`}
        className="recent-match rounded-[3px] bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] px-px font-bold"
      >
        {text.slice(start, end)}
      </span>,
    );
    cursor = end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

function highlightRanges(text: string, query: string): Array<[number, number]> {
  const q = query.trim();
  if (!q) return [];
  let lowered = "";
  const origin: number[] = [];
  for (let index = 0; index < text.length; ) {
    const point = text.codePointAt(index)!;
    const length = point > 0xffff ? 2 : 1;
    const low = text.slice(index, index + length).toLowerCase();
    for (let unit = 0; unit < low.length; unit++) origin.push(index);
    lowered += low;
    index += length;
  }
  const needle = q.toLowerCase();
  const ranges: Array<[number, number]> = [];
  let cursor = 0;
  let from = 0;
  while (from <= lowered.length) {
    const at = lowered.indexOf(needle, from);
    if (at < 0) break;
    from = at + needle.length;
    const start = origin[at];
    const endStart = origin[at + needle.length - 1];
    const end = endStart + (text.codePointAt(endStart)! > 0xffff ? 2 : 1);
    if (start < cursor) continue;
    ranges.push([start, end]);
    cursor = end;
  }
  return ranges;
}
