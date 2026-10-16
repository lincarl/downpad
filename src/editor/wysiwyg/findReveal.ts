// Shows the find card's matches where ProseMirror cannot (spec §5.13).
//   - Crepe draws each code block with its own CodeMirror editor, which ignores
//     ProseMirror's decorations. The matches inside a block are handed to its
//     editor as CodeMirror marks with the same classes instead. Crepe creates a
//     block's editor only when the block nears the screen, which can be after
//     the search ran, so a new editor asks for its marks.
//   - ProseMirror's scrollIntoView does nothing while focus is in the find card,
//     so the current match is scrolled to directly.

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

/**
 * ProseMirror plugin view that marks the matches `read` returns in the code
 * blocks, whenever the matches change and whenever a block's editor is created.
 */
export function codeBlockMatchesView(view: EditorView, read: (state: EditorState) => Matches | undefined): PluginView {
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
 * Scroll the find card's current match into view. A match that is already
 * visible stays put.
 */
export function revealMatch(view: EditorView, range: MatchRange): void {
  awaitingEditor.delete(view);
  if (revealCodeBlockMatch(view, range)) return;
  centerIfHidden(view.dom, view.coordsAtPos(range.from, 1).top, view.coordsAtPos(range.to, -1).bottom);
}

/**
 * Scroll the nearest scrolling ancestor of `inside` so the span from `top` to
 * `bottom` (viewport pixels) is visible. A hidden span is centred, which also
 * keeps it clear of the find card at the top.
 */
function centerIfHidden(inside: Element, top: number, bottom: number): void {
  for (let el = inside.parentElement; el; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight || !/auto|scroll/.test(getComputedStyle(el).overflowY)) continue;
    const box = el.getBoundingClientRect();
    if (top < box.top || bottom > box.bottom) el.scrollTop += (top + bottom) / 2 - (box.top + box.bottom) / 2;
    return;
  }
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
    // coordinates yet.
    const start = cm.coordsAtPos(from, 1);
    const end = cm.coordsAtPos(to, -1);
    if (start && end) centerIfHidden(block, start.top, end.bottom);
    // CodeMirror scrolls a long line sideways and reaches lines it has not drawn.
    const y = start && end ? "nearest" : "center";
    cm.dispatch({ effects: CodeMirror.scrollIntoView(EditorSelection.range(from, to), { y }) });
    return true;
  }
  awaitingEditor.set(view, block);
  // Until its editor is drawn, the block shows the same text in a placeholder.
  const text = block.querySelector(".milkdown-code-block-placeholder code")?.firstChild;
  if (!(text instanceof Text)) return false;
  const span = document.createRange();
  span.setStart(text, from);
  span.setEnd(text, to);
  const rect = span.getBoundingClientRect();
  centerIfHidden(block, rect.top, rect.bottom);
  return true;
}
