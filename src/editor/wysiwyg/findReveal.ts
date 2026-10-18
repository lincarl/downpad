// Shows the find card's matches where ProseMirror cannot (spec §5.13).
//   - Crepe draws each code block with its own CodeMirror editor, which ignores
//     ProseMirror's decorations. The matches inside a block are handed to its
//     editor as CodeMirror marks with the same classes instead. Crepe creates a
//     block's editor only when the block nears the screen, which can be after
//     the search ran, so a new editor asks for its marks.
//   - ProseMirror's scrollIntoView does nothing while focus is in the find card,
//     so the current match is scrolled to directly. The card floats over the
//     bottom right of the page, and the match is scrolled clear of it
//     (`revealSpan`), also in the Markdown view and the frontmatter table.

import { EditorSelection, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView as CodeMirror, ViewPlugin, type DecorationSet } from "@codemirror/view";
import type { EditorState, PluginView } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { MatchRange } from "./findEngine";

/** The find plugin's matches as document positions, with the 0-based index of the current one. */
interface Matches {
  ranges: readonly MatchRange[];
  current: number;
}

/** Fired on a code block's editor once Crepe has put it into the document. */
const CODE_BLOCK_READY = "md-easy-code-block-ready";

const matchMark = Decoration.mark({ class: "md-find-match" });
const currentMark = Decoration.mark({ class: "md-find-match md-find-current" });
const setMarks = StateEffect.define<DecorationSet>();

const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const effect of tr.effects) if (effect.is(setMarks)) return effect.value;
    return marks.map(tr.changes);
  },
  provide: (field) => CodeMirror.decorations.from(field),
});

/** CodeMirror extension for Crepe's code blocks that draws the find card's matches. */
export const codeBlockFindHighlights: Extension = [
  marksField,
  ViewPlugin.define((cm) => {
    // Crepe adds the editor to the block right after creating it.
    queueMicrotask(() => cm.dom.dispatchEvent(new Event(CODE_BLOCK_READY, { bubbles: true })));
    return {};
  }),
];

/**
 * The code block each document view last scrolled to before Crepe drew the
 * block's editor. The editor's lines are taller than the placeholder's, so the
 * current match is scrolled to again once that editor is ready.
 */
const awaitingEditor = new WeakMap<EditorView, Element>();

/** What each document view calls right before find scrolls it (see `codeBlockMatchesView`). */
const beforeScroll = new WeakMap<EditorView, () => void>();

/**
 * ProseMirror plugin view that marks the matches `read` returns in the code
 * blocks, whenever the matches change and whenever a block's editor is created.
 * `onScroll` runs right before find scrolls the page to a match, including the
 * second scroll once a code block's editor is drawn, which can come well after
 * the find step that asked for it.
 */
export function codeBlockMatchesView(
  view: EditorView,
  read: (state: EditorState) => Matches | undefined,
  onScroll: () => void = () => {},
): PluginView {
  beforeScroll.set(view, onScroll);
  const paint = () => showCodeBlockMatches(view, read(view.state));
  const onReady = (event: Event) => {
    paint();
    if (!(event.target instanceof Node) || !awaitingEditor.get(view)?.contains(event.target)) return;
    awaitingEditor.delete(view);
    const matches = read(view.state);
    const current = matches?.ranges[matches.current];
    if (current) revealMatch(view, current);
  };
  view.dom.addEventListener(CODE_BLOCK_READY, onReady);
  return {
    update(_view, prevState) {
      if (read(view.state) !== read(prevState)) paint();
    },
    destroy() {
      view.dom.removeEventListener(CODE_BLOCK_READY, onReady);
      beforeScroll.delete(view);
    },
  };
}

/** The CodeMirror editor inside a code block's DOM, if Crepe has drawn it. */
function codeMirrorIn(block: Node | null): CodeMirror | null {
  const dom = block instanceof HTMLElement ? block.querySelector(".cm-editor") : null;
  return dom instanceof HTMLElement ? CodeMirror.findFromDOM(dom) : null;
}

/** Mark each drawn code block's share of `matches`, or clear its marks. */
function showCodeBlockMatches(view: EditorView, matches: Matches | undefined): void {
  view.state.doc.descendants((node, pos) => {
    if (!node.type.spec.code) return !node.isTextblock;
    const cm = codeMirrorIn(view.nodeDOM(pos));
    const marked = cm?.state.field(marksField, false);
    if (!cm || !marked) return false;
    const start = pos + 1;
    const end = start + node.content.size;
    const marks = (matches?.ranges ?? []).flatMap((range, index) =>
      range.from >= start && range.to <= end
        ? [(index === matches?.current ? currentMark : matchMark).range(range.from - start, range.to - start)]
        : [],
    );
    // Leave blocks that have no marks and get none alone.
    if (marks.length || marked.size) cm.dispatch({ effects: setMarks.of(Decoration.set(marks)) });
    return false;
  });
}

/**
 * Scroll the find card's current match into view, clear of the card. A match
 * that is already visible and clear of the card stays put.
 */
export function revealMatch(view: EditorView, range: MatchRange): void {
  awaitingEditor.delete(view);
  beforeScroll.get(view)?.();
  if (revealCodeBlockMatch(view, range)) return;
  revealSpan(view.dom, spanBetween(view.coordsAtPos(range.from, 1), view.coordsAtPos(range.to, -1)));
}

/** A box in viewport pixels, such as a match's. */
export interface Span {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The box from caret `start` to caret `end`, which may be on another line. */
function spanBetween(start: Span, end: Span): Span {
  return {
    left: Math.min(start.left, end.left),
    right: Math.max(start.right, end.right),
    top: start.top,
    bottom: end.bottom,
  };
}

/** The box of the text from `from` to `to` in a CodeMirror editor, or null
 *  while CodeMirror has not drawn it. */
export function codeMirrorSpan(cm: CodeMirror, from: number, to: number): Span | null {
  const start = cm.coordsAtPos(from, 1);
  const end = cm.coordsAtPos(to, -1);
  return start && end ? spanBetween(start, end) : null;
}

/** How far above the find card the room below a page's last line lets that line rise. */
const CARD_GAP = 12;

/** Pages that `revealSpan` gave room below their last line. */
const pagesWithRoom = new Set<HTMLElement>();

/**
 * Scroll the page around `inside` so `span` is visible and clear of the find
 * card, which floats over the bottom right of the page. A span out of view or
 * under the card is centred in the part of the page above the card, and a page
 * that scrolls sideways centres it that way too. A span that is visible and
 * clear of the card stays put.
 *
 * Near the end of the document the page can stop before the span is clear of
 * the card. The page then gets room below its last line, as tall as the card
 * reaches up into the page plus a gap, until `releaseFindRoom`.
 *
 * With `sideways` false, nothing scrolls sideways, for a span that another
 * scroll is about to move across.
 */
export function revealSpan(inside: Element, span: Span, { sideways = true } = {}): void {
  // Sideways first, as that can move the span under the card.
  const dx = sideways ? centerSideways(inside, span.left, span.right) : 0;
  const page = pageOf(inside);
  if (!page) return;
  const top = page.getBoundingClientRect().top + page.clientTop;
  const bottom = top + page.clientHeight;
  // A span that shares columns with the card shows above it, unless a very
  // short page leaves no room for it there.
  const card = cardOver(span.left - dx, span.right - dx);
  const end = card && card.top - top >= span.bottom - span.top ? Math.min(bottom, card.top) : bottom;
  if (span.top >= top && span.bottom <= end) return;
  const from = page.scrollTop;
  const target = from + (span.top + span.bottom) / 2 - (top + end) / 2;
  page.scrollTop = target;
  if (end === bottom || span.bottom - (page.scrollTop - from) <= end + 0.5) return;
  makeRoom(page, bottom - end + CARD_GAP);
  page.scrollTop = target;
}

/** Give `page` at least `room` pixels below its last line. The pages' CSS
 *  reads it from --find-room. */
function makeRoom(page: HTMLElement, room: number): void {
  if (room > (parseFloat(page.style.getPropertyValue("--find-room")) || 0)) {
    page.style.setProperty("--find-room", `${Math.ceil(room)}px`);
  }
  pagesWithRoom.add(page);
}

/** Take away the room `revealSpan` gave pages below their last line, once the
 *  find card's search is over. A page scrolled into that room moves back. */
export function releaseFindRoom(): void {
  for (const page of pagesWithRoom) page.style.removeProperty("--find-room");
  pagesWithRoom.clear();
}

/** The page `inside` is on: its outermost ancestor that scrolls vertically,
 *  even while its content fits. That is the editor area, or a pane of the
 *  split or of the Markdown view. */
function pageOf(inside: Element): HTMLElement | null {
  let page: HTMLElement | null = null;
  for (let el = inside.parentElement; el; el = el.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(el).overflowY)) page = el;
  }
  return page;
}

/** The open find card's box, when it shares columns with `left` to `right`. */
function cardOver(left: number, right: number): DOMRect | null {
  const box = document.querySelector(".find-bar")?.getBoundingClientRect();
  return box?.height && box.left < right && box.right > left ? box : null;
}

/**
 * Scroll the nearest ancestor of `inside` that scrolls sideways so the span
 * from `left` to `right` (viewport pixels) is visible, centred when it was
 * not, as a table wider than the page scrolls the page sideways. Returns how
 * far the span moved left.
 */
function centerSideways(inside: Element, left: number, right: number): number {
  for (let el = inside.parentElement; el; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth || !/auto|scroll/.test(getComputedStyle(el).overflowX)) continue;
    // The part of the element that shows its content, without borders or scroll bars.
    const low = el.getBoundingClientRect().left + el.clientLeft;
    const high = low + el.clientWidth;
    if (left >= low && right <= high) return 0;
    const from = el.scrollLeft;
    el.scrollLeft = from + (left + right) / 2 - (low + high) / 2;
    return el.scrollLeft - from;
  }
  return 0;
}

/** Scroll to a match inside a code block. False when `range` is not in one. */
function revealCodeBlockMatch(view: EditorView, range: MatchRange): boolean {
  const $from = view.state.doc.resolve(range.from);
  if (!$from.parent.type.spec.code) return false;
  const block = view.nodeDOM($from.before());
  if (!(block instanceof HTMLElement)) return false;
  const from = range.from - $from.start();
  const to = range.to - $from.start();
  const cm = codeMirrorIn(block);
  if (cm) {
    // A long block draws only the lines near the screen, so a line may have no
    // coordinates yet. CodeMirror scrolls a long line sideways, also the page
    // when it is scrolled sideways, and reaches lines it has not drawn, so this
    // scroll is only up or down. Before CodeMirror scrolls, a match far along a
    // long line lies past the block's edge, and centring on it would scroll the
    // whole page sideways when a wide table lets it.
    const span = codeMirrorSpan(cm, from, to);
    if (span) revealSpan(block, span, { sideways: false });
    const y = span ? "nearest" : "center";
    cm.dispatch({ effects: CodeMirror.scrollIntoView(EditorSelection.range(from, to), { y }) });
    // It does so in its next frame, which can move the match under the find
    // card. CodeMirror asked for that frame first, so this runs after it.
    requestAnimationFrame(() => {
      const after = codeMirrorSpan(cm, from, to);
      if (after) revealSpan(block, after);
    });
    return true;
  }
  awaitingEditor.set(view, block);
  // Until its editor is drawn, the block shows the same text in a placeholder,
  // which wraps long lines. Crepe draws the editor only once the block is on
  // screen, so the page may also have to scroll sideways to it.
  const text = block.querySelector(".milkdown-code-block-placeholder code")?.firstChild;
  if (!(text instanceof Text)) return false;
  const span = document.createRange();
  span.setStart(text, from);
  span.setEnd(text, to);
  revealSpan(block, span.getBoundingClientRect());
  return true;
}
