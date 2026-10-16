// Raw view: CodeMirror 6 with VS Code's Markdown colours. A *view* over the
// canonical markdown string; raw edits are written back verbatim (spec §5.16).

import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
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

/** How long edits must pause before the find card recounts. Counting walks the
 *  whole document, which takes about 200ms for 2 MB, too slow for every
 *  keystroke. */
const FIND_RECOUNT_DELAY_MS = 200;

export interface RawCallbacks {
  onChange: (text: string) => void;
  /** Called once edits pause while a find query is set, so the find card can
   *  show the new count (§5.13). */
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

export class RawEditor {
  private view: EditorView | null = null;
  /** Set while `setText` replaces the doc programmatically (split-view mirror
   *  sync, §6.1) so the resulting transaction doesn't echo back through onChange
   *  and clobber the pane that authored the change. */
  private applying = false;
  /** Pending `onFindChange` call, set while edits have not paused yet. */
  private findChangeTimer: ReturnType<typeof setTimeout> | null = null;

  mount(root: HTMLElement, initial: string, cb: RawCallbacks, opts: RawOptions = {}): void {
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged && !this.applying) cb.onChange(u.state.doc.toString());
      if (u.docChanged && cb.onFindChange && getSearchQuery(u.state).search) {
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

  /** Replace the whole document to mirror an edit made in the other split pane
   *  (§6.1). The replacement is dispatched with `applying` set so it doesn't
   *  re-emit onChange. No-op when the text already matches (avoids needless
   *  transactions / cursor churn). This pane is the unfocused mirror, so the
   *  resulting caret position doesn't matter. */
  setText(text: string): void {
    if (!this.view) return;
    if (this.view.state.doc.toString() === text) return;
    this.applying = true;
    try {
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
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
    return { current: current + 1, total: matches.length };
  }

  findNext(): FindCounts {
    if (!this.view) return { current: 0, total: 0 };
    findNextMatch(this.view);
    return this.currentCounts();
  }

  findPrev(): FindCounts {
    if (!this.view) return { current: 0, total: 0 };
    findPreviousMatch(this.view);
    return this.currentCounts();
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
    return this.currentCounts();
  }

  replaceAll(replacement: string, query: string, opts: FindOptions): FindCounts {
    if (!this.view) return { current: 0, total: 0 };
    this.searchText(query, opts, replacement);
    replaceAllMatches(this.view);
    return this.searchText(query, opts, replacement);
  }

  clearSearch(): void {
    if (!this.view) return;
    this.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
  }

  private matches(query: SearchQuery): Array<{ from: number; to: number }> {
    if (!this.view || !query.valid) return [];
    const matches: Array<{ from: number; to: number }> = [];
    const cursor = query.getCursor(this.view.state);
    for (let result = cursor.next(); !result.done; result = cursor.next()) {
      matches.push(result.value);
    }
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

  /** Call `notify` once edits pause, restarting the wait on every edit. */
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
    this.view?.destroy();
    this.view = null;
  }
}
