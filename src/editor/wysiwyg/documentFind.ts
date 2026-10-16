// The document view's find and replace (spec §5.13) uses one list of matches.
// The frontmatter table's come first, as the table sits above the document,
// then ProseMirror's. findEngine keeps the document's matches and paints them as
// decorations. This class keeps the table's matches and paints them with the
// CSS Custom Highlight API under the same names, md-find-match and
// md-find-current, so app.css gives both the same colours. While the current
// match is in the table, no document match is current and no document text is
// selected.

import type { EditorView } from "@milkdown/kit/prose/view";
import {
  clearSearch,
  findKey,
  replaceAll,
  replaceCurrent,
  runSearch,
  selectMatch,
  type FindCounts,
  type FindOptions,
} from "./findEngine";
import {
  findInFrontmatter,
  focusMatch,
  isBefore,
  matchRange,
  replaceInFrontmatter,
  revealCell,
  type FrontmatterMatch,
} from "./frontmatterFind";

/** What the table side needs from WysiwygEditor. */
export interface FrontmatterHost {
  /** The YAML block the table shows, or null when no table is shown. */
  block(): string | null;
  /** The element the table is drawn in. */
  panel(): HTMLElement | null;
  /** Publish a block Replace rewrote, and draw the table again. */
  replaceBlock(block: string): void;
  /** The table's matches were found again after the table changed, so the
   *  find card's count may be out of date. */
  changed(): void;
}

const NO_OPTIONS: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };

/** Find and replace over the frontmatter table and the document as one list of matches. */
export class DocumentFind {
  private query = "";
  private opts = NO_OPTIONS;
  /** The table's matches, top to bottom. */
  private matches: FrontmatterMatch[] = [];
  /** Index into `matches` of the current match; -1 when it is in the document
   *  or there is none. */
  private current = -1;
  /** This editor's highlights. They are registered again on each paint while a
   *  search is active, as the registry is shared by every open document. */
  private highlights: { match: Highlight; current: Highlight } | null = null;
  /** Finds and paints again when React redraws the table or a cell is edited,
   *  as both replace the text the highlights cover. */
  private observer: MutationObserver | null = null;
  private observed: HTMLElement | null = null;
  /** The frame that runs that refresh. A cell's mutation is seen before its
   *  input handler has published the new block, so it waits for the frame. */
  private frame: number | null = null;

  constructor(private readonly host: FrontmatterHost) {}

  /** Search the table and the document and make the first match current. */
  search(view: EditorView, query: string, opts: FindOptions): FindCounts {
    this.setQuery(query, opts);
    this.current = this.matches.length ? 0 : -1;
    runSearch(view, query, opts, this.current < 0);
    this.paint(true);
    return this.counts(view);
  }

  /** Step `delta` matches forward or back, wrapping around the whole list. */
  move(view: EditorView, delta: number): FindCounts {
    const { total, current } = this.counts(view);
    if (!total) return { total, current };
    const next = current ? (current - 1 + delta + total) % total : delta > 0 ? 0 : total - 1;
    this.select(view, next);
    return this.counts(view);
  }

  /** Replace the current match and move on to the match after it. Replace
   *  leaves a read-only table match as it is and only moves on. */
  replaceCurrent(view: EditorView, replacement: string, query: string, opts: FindOptions): FindCounts {
    const match = this.matches[this.current];
    const block = this.host.block();
    if (!match || block == null) {
      // findEngine replaces the document's match and searches the document
      // again. With no document match left, the table's first comes next.
      // ProseMirror's insertText has collapsed the document's selection, so no
      // text stays selected.
      replaceCurrent(view, replacement, query, opts);
      this.setQuery(query, opts);
      const documentMatches = findKey.getState(view.state)?.ranges.length ?? 0;
      this.current = !documentMatches && this.matches.length ? 0 : -1;
      this.paint(true);
      return this.counts(view);
    }
    const rewritten = replaceInFrontmatter(block, [match], replacement);
    if (rewritten !== block) this.host.replaceBlock(rewritten);
    // Go on from the end of the replacement, or past a match that stayed.
    const end = { ...match, from: rewritten !== block ? match.from + replacement.length : match.to };
    this.setQuery(query, opts);
    // The next match in the table, else the document's first, else around to
    // the table's first.
    const total = this.matches.length + (findKey.getState(view.state)?.ranges.length ?? 0);
    const after = this.matches.findIndex((m) => !isBefore(m, end));
    const next = after >= 0 ? after : this.matches.length;
    this.select(view, next < total ? next : total ? 0 : -1);
    return this.counts(view);
  }

  /** Replace every match, then search again from the top. */
  replaceAll(view: EditorView, replacement: string, query: string, opts: FindOptions): FindCounts {
    // The document first, so the table's change report already carries its edits.
    replaceAll(view, replacement, query, opts);
    const block = this.host.block();
    if (block != null) {
      const rewritten = replaceInFrontmatter(block, findInFrontmatter(block, query, opts), replacement);
      if (rewritten !== block) this.host.replaceBlock(rewritten);
    }
    return this.search(view, query, opts);
  }

  /** Put the caret on the table's current match with its text selected, the
   *  way ProseMirror keeps a document match selected. Returns false when the
   *  current match is not in an editable cell of the drawn table. */
  focusCurrent(): boolean {
    const panel = this.host.panel();
    const match = this.matches[this.current];
    if (!panel || !match) return false;
    return focusMatch(panel, match);
  }

  /** Forget the search and remove every highlight. */
  clear(view: EditorView): void {
    this.dispose();
    clearSearch(view);
  }

  /** Remove the table's highlights and stop watching the table. */
  dispose(): void {
    this.setQuery("", NO_OPTIONS);
    this.current = -1;
    this.paint(false);
  }

  /** Find again in the table after its block or drawing changed, keeping the
   *  current match where it can. */
  refresh(): void {
    if (!this.query) return;
    this.setQuery(this.query, this.opts);
    this.current = Math.min(this.current, this.matches.length - 1);
    this.paint(false);
    this.host.changed();
  }

  /** Remember the search and find it again in the table's current block. */
  private setQuery(query: string, opts: FindOptions): void {
    this.query = query;
    this.opts = opts;
    const block = this.host.block();
    this.matches = block == null ? [] : findInFrontmatter(block, query, opts);
  }

  /** Make match `index` of the whole list current (-1 for none). */
  private select(view: EditorView, index: number): void {
    const inTable = index >= 0 && index < this.matches.length;
    this.current = inTable ? index : -1;
    selectMatch(view, inTable || index < 0 ? -1 : index - this.matches.length);
    this.paint(true);
  }

  /** The whole list's total and 1-based current match. */
  counts(view: EditorView): FindCounts {
    const doc = findKey.getState(view.state);
    const total = this.matches.length + (doc?.ranges.length ?? 0);
    if (this.current >= 0) return { total, current: this.current + 1 };
    return { total, current: doc && doc.current >= 0 ? this.matches.length + doc.current + 1 : 0 };
  }

  /** Paint the table's matches, and with `reveal` scroll the current one into view. */
  private paint(reveal: boolean): void {
    const panel = this.host.panel();
    this.watch(this.query ? panel : null);
    // Created on the first match. jsdom has no Highlight.
    if (!this.highlights && this.matches.length && typeof Highlight !== "undefined") {
      this.highlights = { match: new Highlight(), current: new Highlight() };
    }
    if (this.highlights) {
      const { match, current } = this.highlights;
      match.clear();
      current.clear();
      this.matches.forEach((m, i) => {
        const range = panel && matchRange(panel, m);
        if (range) (i === this.current ? current : match).add(range);
      });
      // Only a search takes the names over. Clearing empties this editor's
      // highlights and leaves another document's search painted.
      if (this.query) {
        CSS.highlights.set("md-find-match", match);
        CSS.highlights.set("md-find-current", current);
      }
    }
    const shown = this.matches[this.current];
    if (reveal && panel && shown) revealCell(panel, shown);
  }

  /** Observe `panel` for redraws and edits, or nothing when it is null. */
  private watch(panel: HTMLElement | null): void {
    if (panel === this.observed) return;
    this.observer?.disconnect();
    if (this.frame != null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.observed = panel;
    if (!panel) return;
    this.observer ??= new MutationObserver(() => {
      this.frame ??= requestAnimationFrame(() => {
        this.frame = null;
        this.refresh();
      });
    });
    this.observer.observe(panel, { childList: true, subtree: true, characterData: true });
  }
}
