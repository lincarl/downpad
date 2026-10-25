// WYSIWYG find/replace engine (spec §5.13). CodeMirror's panel can't drive the
// ProseMirror document, so the WYSIWYG view gets its own search:
//   - `findMatchRanges` is pure string matching (case/whole-word/regex) — tested.
//   - `searchDoc` maps those matches onto ProseMirror positions per text block
//     (so matches spanning inline marks work, but never cross block boundaries).
//   - a ProseMirror plugin holds the match set + current index, paints
//     decorations, and remaps on edits; replacements go through transactions so
//     undo/redo behaves normally.
//   - `findReveal` shows matches inside code blocks and scrolls to the current one.

import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey, Selection, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { EditorState } from "@milkdown/kit/prose/state";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { codeBlockMatchesView, revealMatch } from "./findReveal";
import { replaceText } from "./autolinkReplace";

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface MatchRange {
  from: number;
  to: number;
}

export interface FindCounts {
  total: number;
  /** 1-based index of the current match, 0 when none. */
  current: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A word character in any script, as the Markdown view's whole-word search counts them. */
const WORD = "[\\p{Alphabetic}\\p{Number}_]";

/** Find non-overlapping match ranges of `query` in `text` (string offsets). */
export function findMatchRanges(text: string, query: string, opts: FindOptions): MatchRange[] {
  if (!query) return [];
  let re: RegExp;
  try {
    const flags = opts.caseSensitive ? "gu" : "giu";
    let pattern = opts.regex ? query : escapeRegExp(query);
    // A whole-word match does not continue a word on either side. JavaScript's
    // \b only knows ASCII letters, so it split words at å, ä, ö and the like.
    if (opts.wholeWord) {
      pattern = `(?:(?<!${WORD})|(?!${WORD}))(?:${pattern})(?:(?!${WORD})|(?<!${WORD}))`;
    }
    re = new RegExp(pattern, flags);
  } catch {
    return []; // invalid regex → no matches (the bar shows 0)
  }
  const ranges: MatchRange[] = [];
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++; // avoid an infinite loop on zero-width matches
      continue;
    }
    ranges.push({ from: m.index, to: m.index + m[0].length });
    if (++guard > 100_000) break;
  }
  return ranges;
}

/** Per-textblock text + a map from each char index to its ProseMirror position. */
function blockText(node: ProseNode, pos: number): { text: string; offsets: number[] } {
  let text = "";
  const offsets: number[] = [];
  node.forEach((child, offset) => {
    const base = pos + 1 + offset;
    if (child.isText && child.text) {
      for (let i = 0; i < child.text.length; i++) {
        text += child.text[i];
        offsets.push(base + i);
      }
    } else {
      text += "￼"; // object-replacement sentinel for atomic inline nodes
      offsets.push(base);
    }
  });
  return { text, offsets };
}

/** Map string matches onto ProseMirror position ranges across all text blocks. */
export function searchDoc(doc: ProseNode, query: string, opts: FindOptions): MatchRange[] {
  if (!query) return [];
  const result: MatchRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const { text, offsets } = blockText(node, pos);
    for (const r of findMatchRanges(text, query, opts)) {
      const from = offsets[r.from];
      const lastChar = offsets[r.to - 1];
      if (from != null && lastChar != null) result.push({ from, to: lastChar + 1 });
    }
    return false; // text blocks hold inline content only
  });
  return result;
}

// ── ProseMirror plugin ──

interface FindPluginState {
  query: string;
  opts: FindOptions;
  ranges: MatchRange[];
  current: number; // 0-based index into ranges, -1 when none
}

const EMPTY_OPTS: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };

export const findKey = new PluginKey<FindPluginState>("downpad-find");

type FindMeta =
  /** With `from`, the first match at or after that position becomes current. */
  | { type: "search"; query: string; opts: FindOptions; from?: number }
  | { type: "current"; current: number }
  | { type: "clear" };

function buildDecorationSet(doc: ProseNode, s: FindPluginState): DecorationSet {
  if (!s.ranges.length) return DecorationSet.empty;
  const decos = s.ranges.map((r, i) =>
    Decoration.inline(r.from, r.to, {
      class: i === s.current ? "md-find-match md-find-current" : "md-find-match",
    }),
  );
  return DecorationSet.create(doc, decos);
}

/** Milkdown wrapper so the search plugin can be registered via `editor.use`.
 *  `onScroll` runs right before find scrolls the page to a match. */
export function searchMilkdownPlugin(onScroll?: () => void) {
  return $prose(() => findPlugin(onScroll));
}

export function findPlugin(onScroll?: () => void) {
  return new Plugin<FindPluginState>({
    key: findKey,
    state: {
      init: () => ({ query: "", opts: EMPTY_OPTS, ranges: [], current: -1 }),
      apply: (tr, prev) => {
        const meta = tr.getMeta(findKey) as FindMeta | undefined;
        if (meta?.type === "search") {
          const ranges = searchDoc(tr.doc, meta.query, meta.opts);
          const after = ranges.findIndex((range) => range.from >= (meta.from ?? 0));
          return { query: meta.query, opts: meta.opts, ranges, current: ranges.length ? Math.max(after, 0) : -1 };
        }
        if (meta?.type === "current") {
          return { ...prev, current: meta.current };
        }
        if (meta?.type === "clear") {
          return { query: "", opts: EMPTY_OPTS, ranges: [], current: -1 };
        }
        if (tr.docChanged && prev.query) {
          // Re-run on edits so positions stay valid. With no current match (it
          // is in the frontmatter table), an edit does not make one current.
          const ranges = searchDoc(tr.doc, prev.query, prev.opts);
          return { ...prev, ranges, current: Math.min(prev.current, ranges.length - 1) };
        }
        return prev;
      },
    },
    // Code blocks draw their own text, so they get the matches separately.
    view: (view) => codeBlockMatchesView(view, (state) => findKey.getState(state), onScroll),
    props: {
      decorations(state: EditorState) {
        const s = findKey.getState(state);
        return s ? buildDecorationSet(state.doc, s) : null;
      },
    },
  });
}

// ── View commands (called by the find bar via EditorHost) ──

function counts(s: FindPluginState | undefined): FindCounts {
  if (!s || !s.ranges.length) return { total: 0, current: 0 };
  return { total: s.ranges.length, current: s.current + 1 };
}

/** The current match position and total, without moving to a match. */
export function matchCounts(view: EditorView): FindCounts {
  return counts(findKey.getState(view.state));
}

/** Select the current match, so closing the card leaves the caret there, and scroll to it. */
function scrollToCurrent(view: EditorView, s: FindPluginState): void {
  const range = s.ranges[s.current];
  if (!range) return;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)));
  revealMatch(view, range);
  // When ProseMirror changes the text of a drawn code block, as Replace does,
  // the block's CodeMirror scrolls its own cursor into view in its next frame,
  // which can take the page away from the match. CodeMirror asked for that
  // frame first, so this callback runs after it and before the page is painted.
  requestAnimationFrame(() => {
    const now = view.isDestroyed ? undefined : findKey.getState(view.state);
    const current = now?.ranges[now.current];
    if (current) revealMatch(view, current);
  });
}

/** Search the document and select its first match, or with `select` false
 *  leave no match current because the current one is in the frontmatter table. */
export function runSearch(view: EditorView, query: string, opts: FindOptions, select = true): FindCounts {
  view.dispatch(view.state.tr.setMeta(findKey, { type: "search", query, opts }));
  return selectMatch(view, select ? 0 : -1);
}

/** Make match `index` current, select it and scroll to it. -1 leaves no match
 *  current and collapses the selection to its end, so a match the user stepped
 *  past does not stay selected for the next keystroke to replace. */
export function selectMatch(view: EditorView, index: number): FindCounts {
  const s = findKey.getState(view.state);
  if (s?.ranges.length && s.current !== index) {
    view.dispatch(view.state.tr.setMeta(findKey, { type: "current", current: index }));
  }
  const next = findKey.getState(view.state);
  const { selection } = view.state;
  if (index < 0 && !selection.empty) {
    view.dispatch(view.state.tr.setSelection(Selection.near(selection.$to)));
  } else if (next) {
    scrollToCurrent(view, next);
  }
  return counts(next);
}

export function clearSearch(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(findKey, { type: "clear" }));
}

export function replaceCurrent(
  view: EditorView,
  replacement: string,
  query: string,
  opts: FindOptions,
): FindCounts {
  const s = findKey.getState(view.state);
  const range = s?.ranges[s.current];
  if (!range) return runSearch(view, query, opts);
  // Search again and carry on with the match after the replacement, so the
  // next Replace does not go back to the first match.
  const tr = replaceText(view.state.tr, range.from, range.to, replacement);
  view.dispatch(tr.setMeta(findKey, { type: "search", query, opts, from: tr.mapping.map(range.to) }));
  const next = findKey.getState(view.state)!;
  scrollToCurrent(view, next);
  return counts(next);
}

/** Replace every match and search again. The replacements go into `tr`, a
 *  transaction from the current state. It may already hold a change that moves
 *  no position, such as the frontmatter table's, so one undo takes back both. */
export function replaceAll(
  view: EditorView,
  replacement: string,
  query: string,
  opts: FindOptions,
  tr = view.state.tr,
): FindCounts {
  const ranges = findKey.getState(view.state)?.ranges ?? [];
  // Replace from last to first so earlier ranges keep their positions.
  for (let i = ranges.length - 1; i >= 0; i--) {
    replaceText(tr, ranges[i].from, ranges[i].to, replacement);
  }
  if (tr.docChanged) view.dispatch(tr);
  return runSearch(view, query, opts);
}
