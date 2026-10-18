// Raw view: CodeMirror 6 with VS Code's Markdown colours. A *view* over the
// canonical markdown string; raw edits are written back verbatim (spec §5.16).

import { EditorView, basicSetup } from "codemirror";
import { EditorState, type Text } from "@codemirror/state";
import {
  SearchQuery,
  findNext as findNextMatch,
  findPrevious as findPreviousMatch,
  getSearchQuery,
  replaceAll as replaceAllMatches,
  replaceNext as replaceNextMatch,
  search,
  setSearchQuery,
} from "@codemirror/search";
import { base64Collapse, inBase64Payload } from "./base64Collapse";
import { specialDashHighlight } from "./specialDash";
import { markdownSource, markdownSourceStyle } from "./markdownSource";
import type { FindCounts, FindOptions } from "../wysiwyg/findEngine";
import { codeMirrorSpan, revealSpan } from "../wysiwyg/findReveal";

/** How long edits and caret moves must pause before the find card recounts.
 *  Counting after an edit walks the whole document, which takes about 200ms
 *  for 2 MB, too slow for every keystroke. */
const FIND_RECOUNT_DELAY_MS = 200;

/** A match of the find card's query, as document offsets. */
type Match = { from: number; to: number };

export interface RawCallbacks {
  onChange: (text: string) => void;
  /** Called once edits or selection moves pause while a find query is set, so
   *  the find card can show the new count and current match (§5.13). */
  onFindChange?: () => void;
}

export interface RawOptions {
  /** Collapse base64 data URIs in the view (§5.3). */
  collapseBase64?: boolean;
}

/** Search test that skips the base64 data of data: URIs, so Replace all cannot corrupt an image. */
function outsideImageData(_match: string, state: EditorState, from: number, to: number): boolean {
  return !inBase64Payload(state.doc, from, to);
}

/** Whether a UTF-16 code unit is the first half of a surrogate pair, the two
 *  units that encode one character such as an emoji. */
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
/** Whether a UTF-16 code unit is the second half of a surrogate pair. */
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/** The one change that turns `before` into `after`, leaving out the text they
 *  share at the start and at the end. Both ends fall between characters, never
 *  between the halves of a surrogate pair, so a caret mapped to an end cannot
 *  split one. */
function changedRange(before: string, after: string): { from: number; to: number; insert: string } {
  const shorter = Math.min(before.length, after.length);
  let from = 0;
  while (from < shorter && before.charCodeAt(from) === after.charCodeAt(from)) from += 1;
  if (from > 0 && isHighSurrogate(before.charCodeAt(from - 1))) from -= 1;
  let to = before.length;
  let end = after.length;
  while (to > from && end > from && before.charCodeAt(to - 1) === after.charCodeAt(end - 1)) {
    to -= 1;
    end -= 1;
  }
  if (to < before.length && isLowSurrogate(before.charCodeAt(to))) {
    to += 1;
    end += 1;
  }
  return { from, to, insert: after.slice(from, end) };
}

export class RawEditor {
  private view: EditorView | null = null;
  /** Set while `setText` replaces the doc programmatically (split-view mirror
   *  sync, §6.1) so the resulting transaction doesn't echo back through onChange
   *  and clobber the pane that authored the change. */
  private applying = false;
  /** Pending `onFindChange` call, set while edits or selection moves have not
   *  paused yet. */
  private findChangeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The matches last counted, reused while the document and query stay the
   *  same, so a caret move or F3 does not walk the whole document again. */
  private counted: { doc: Text; query: SearchQuery; matches: Match[] } | null = null;

  mount(root: HTMLElement, initial: string, cb: RawCallbacks, opts: RawOptions = {}): void {
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged && !this.applying) cb.onChange(u.state.doc.toString());
      // The current match is the selected one, so a caret move changes it too.
      if ((u.docChanged || u.selectionSet) && cb.onFindChange && getSearchQuery(u.state).search) {
        this.scheduleFindChange(cb.onFindChange);
      }
    });
    this.view = new EditorView({
      parent: root,
      state: EditorState.create({
        doc: initial,
        extensions: [
          basicSetup,
          markdownSource(),
          markdownSourceStyle(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": "Markdown source editor" }),
          // Install CodeMirror's search state without exposing its own panel.
          // The app-level capture handler owns Ctrl+F/Ctrl+H and drives this
          // state through the find card; markdownSourceStyle paints the matches.
          search({ top: true }),
          ...(opts.collapseBase64 ? [base64Collapse()] : []),
          // Make non-hyphen dashes (em/en dash, …) unmistakable in the source: a
          // monospace font renders them almost identically to a hyphen (§5.3).
          specialDashHighlight(),
          updateListener,
        ],
      }),
    });
  }

  getText(): string {
    return this.view ? this.view.state.doc.toString() : "";
  }

  /** Set the text to mirror an edit made in the other split pane (§6.1). Only
   *  the range from the first to the last difference is replaced, so the caret,
   *  the selection and the lines in view keep their place when they lie outside
   *  it. This pane can have focus meanwhile, for example when focus moves into
   *  it and the split catches it up first. The change is dispatched with
   *  `applying` set so it doesn't re-emit onChange. No-op when the text already
   *  matches. */
  setText(text: string): void {
    if (!this.view) return;
    const current = this.view.state.doc.toString();
    if (current === text) return;
    this.applying = true;
    try {
      this.view.dispatch({ changes: changedRange(current, text) });
    } finally {
      this.applying = false;
    }
  }

  /** Insert text at the current selection (used by drag-and-drop, §5.4). */
  insertText(text: string): void {
    if (!this.view || !text) return;
    const { from, to } = this.view.state.selection.main;
    this.view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
    this.view.focus();
  }

  /**
   * Drive CodeMirror's search state from the application's find card. When no
   * match is selected, select the first one, unless `selectFirst` is false.
   * With `selectFirst`, the selected match is then scrolled clear of the card.
   */
  searchText(query: string, opts: FindOptions, replacement = "", selectFirst = true): FindCounts {
    const view = this.view;
    if (!view) return { current: 0, total: 0 };
    const searchQuery = new SearchQuery({
      search: query,
      caseSensitive: opts.caseSensitive,
      wholeWord: opts.wholeWord,
      regexp: opts.regex,
      replace: replacement,
      test: outsideImageData,
    });
    view.dispatch({ effects: setSearchQuery.of(searchQuery) });
    if (!query || !searchQuery.valid) return { current: 0, total: 0 };

    const matches = this.matches(searchQuery);
    if (!matches.length) return { current: 0, total: 0 };
    const selection = view.state.selection.main;
    let current = matches.findIndex(
      ({ from, to }) => selection.from === from && selection.to === to,
    );
    if (current < 0) {
      if (!selectFirst) return { current: 0, total: matches.length };
      current = 0;
      const first = matches[0];
      view.dispatch({
        selection: { anchor: first.from, head: first.to },
        scrollIntoView: true,
      });
    }
    if (selectFirst) this.revealSelection();
    return { current: current + 1, total: matches.length };
  }

  findNext(): FindCounts {
    if (!this.view) return { current: 0, total: 0 };
    findNextMatch(this.view);
    return this.revealedCounts();
  }

  findPrev(): FindCounts {
    if (!this.view) return { current: 0, total: 0 };
    findPreviousMatch(this.view);
    return this.revealedCounts();
  }

  /**
   * Replace the selected match and select the next one. With no match
   * selected, only select the next match after the caret, so the user sees
   * what the next Replace changes.
   */
  replaceCurrent(replacement: string, query: string, opts: FindOptions): FindCounts {
    if (!this.view) return { current: 0, total: 0 };
    if (!this.searchText(query, opts, replacement, false).total) return { current: 0, total: 0 };
    const before = this.view.state.doc;
    replaceNextMatch(this.view);
    // CodeMirror leaves the replacement selected. Move on to the next match, as
    // the document view does, so the next Replace does not edit the first one.
    if (this.view.state.doc !== before) findNextMatch(this.view);
    return this.revealedCounts();
  }

  replaceAll(replacement: string, query: string, opts: FindOptions): FindCounts {
    if (!this.view) return { current: 0, total: 0 };
    this.searchText(query, opts, replacement);
    replaceAllMatches(this.view);
    return this.searchText(query, opts, replacement);
  }

  clearSearch(): void {
    if (!this.view) return;
    this.counted = null;
    this.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
  }

  private matches(query: SearchQuery): Match[] {
    if (!this.view || !query.valid) return [];
    const { doc } = this.view.state;
    if (this.counted?.doc === doc && this.counted.query.eq(query)) return this.counted.matches;
    const matches: Match[] = [];
    const cursor = query.getCursor(this.view.state);
    for (let result = cursor.next(); !result.done; result = cursor.next()) {
      matches.push(result.value);
    }
    this.counted = { doc, query, matches };
    return matches;
  }

  /** The match the selection covers (0 when none) and the total. */
  currentCounts(): FindCounts {
    if (!this.view) return { current: 0, total: 0 };
    const query = getSearchQuery(this.view.state);
    const matches = this.matches(query);
    const selection = this.view.state.selection.main;
    const current = matches.findIndex(
      ({ from, to }) => selection.from === from && selection.to === to,
    );
    return { current: current < 0 ? 0 : current + 1, total: matches.length };
  }

  /** The current match and total, with the current match scrolled clear of
   *  the find card. */
  private revealedCounts(): FindCounts {
    const counts = this.currentCounts();
    if (counts.current) this.revealSelection();
    return counts;
  }

  /**
   * Scroll the selected match clear of the find card, which CodeMirror knows
   * nothing of (`revealSpan`). CodeMirror scrolls to the match in its next
   * frame. It asked for that frame first, so this runs after it, before the
   * page is painted.
   */
  private revealSelection(): void {
    requestAnimationFrame(() => {
      const view = this.view;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      const span = codeMirrorSpan(view, from, to);
      if (span) revealSpan(view.scrollDOM, span);
    });
  }

  /** Call `notify` once changes pause, restarting the wait on every change. */
  private scheduleFindChange(notify: () => void): void {
    if (this.findChangeTimer != null) clearTimeout(this.findChangeTimer);
    this.findChangeTimer = setTimeout(() => {
      this.findChangeTimer = null;
      notify();
    }, FIND_RECOUNT_DELAY_MS);
  }

  focus(): void {
    this.view?.focus();
  }

  /** Re-show after being hidden (display:none) on a tab/view switch, or after a
   *  split resize. CodeMirror caches viewport measurements, so it must be told to
   *  re-measure or it renders with stale/zero height and a misplaced cursor. Pass
   *  `focus=false` for the split mirror pane so it doesn't steal focus from the
   *  document editor (§6.1). */
  onShow(focus = true): void {
    this.view?.requestMeasure();
    if (focus) this.view?.focus();
  }

  destroy(): void {
    if (this.findChangeTimer != null) clearTimeout(this.findChangeTimer);
    this.findChangeTimer = null;
    this.counted = null;
    this.view?.destroy();
    this.view = null;
  }
}
