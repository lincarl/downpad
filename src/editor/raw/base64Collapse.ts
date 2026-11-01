// Collapses long base64 data URIs in the raw (CodeMirror) view (spec §5.3):
// `data:image/png;base64,AAAA…` is shown as `data:image/png;base64,…[148 KB]`,
// click to expand. A replacing widget hides just the base64 payload; clicking it
// (or moving the selection into it) expands that occurrence. Gated by the
// `collapseBase64InRawView` setting (the extension is only added when enabled).
//
// Find in the Markdown view skips the base64 payload of every data: URI,
// collapsed or not (`inBase64Payload`). The data is not text anyone searches
// for, and Replace all would corrupt the image. That includes a data: URI
// written as text, such as in a code sample, which the document view still
// searches. A file dropped on the payload goes in after the image, or beside
// the block that holds the data, instead (`dropOutsidePayload`).

import { ensureSyntaxTree, language } from "@codemirror/language";
import { ViewPlugin, Decoration, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { StateEffect, RangeSetBuilder, type EditorState, type Extension, type Text } from "@codemirror/state";
import { formatSize } from "../../document/docSize";

// data: URI with a base64 payload, in the plain form the view collapses.
const DATA_URI = /data:[\w.+-]*\/?[\w.+-]*;base64,([A-Za-z0-9+/=]+)/g;
// Any data: URI with a base64 payload, which find skips. That includes media
// type parameters such as `;charset=utf-8` and any letter case (RFC 2397).
const ANY_DATA_URI = /data:[^,\s"'()<>]*;base64,([A-Za-z0-9+/=]+)/gi;
/** Shorter payloads are not worth collapsing. */
const MIN_COLLAPSED = 64;

const expandEffect = StateEffect.define<number>();

/** Base64 payload ranges per document version, for find. */
const payloads = new WeakMap<Text, Array<[number, number]>>();

/** The base64 payload range of every data URI in `doc`. */
function payloadRanges(doc: Text): Array<[number, number]> {
  let ranges = payloads.get(doc);
  if (!ranges) {
    ranges = [...doc.toString().matchAll(ANY_DATA_URI)].map((m) => {
      const end = m.index + m[0].length;
      return [end - m[1].length, end];
    });
    payloads.set(doc, ranges);
  }
  return ranges;
}

/** Whether `from`..`to` overlaps the base64 payload of a data URI in `doc`. */
export function inBase64Payload(doc: Text, from: number, to: number): boolean {
  return payloadRanges(doc).some(([start, end]) => from < end && to > start);
}

/** How long a drop on image data, or a file put in as a paragraph of its
 *  own, may wait for the Markdown view to finish reading the text's
 *  structure. */
const PARSE_BUDGET_MS = 200;

/**
 * Where a file dropped at `pos` goes in, moved out of the base64 payload of a
 * data URI that `pos` is in or at either edge of. A file dropped on a
 * collapsed image's chip would otherwise go into the data, since the chip
 * covers the payload and a drop on it finds one of its edges. When the data
 * is the URL of a Markdown image or link, `![](data:…)`, the file goes in
 * after it, after the outermost one for an image inside a link. Elsewhere,
 * such as in a reference definition, HTML or code, the data has no end the
 * file could follow inside its line, so the file goes in as a paragraph of
 * its own (`newBlock`) after the top-level block that holds the data, which
 * keeps a table, a list or an HTML block in one piece. A code fence or an
 * HTML comment that is not closed yet takes in all the text after it, so
 * then the file goes in before the block. Without the text's structure in
 * time, the file goes in after the line.
 */
export function dropOutsidePayload(state: EditorState, pos: number): { pos: number; newBlock: boolean } {
  const payload = payloadRanges(state.doc).find(([start, end]) => pos >= start && pos <= end);
  if (!payload) return { pos, newBlock: false };
  const [start, end] = payload;
  const { block, link } = blockAt(state, start);
  if (link) return { pos: link.to, newBlock: false };
  return { pos: besideBlock(state, block, end), newBlock: true };
}

/**
 * Where a file put in as a paragraph of its own (`newBlock`) goes for a caret
 * at `pos`: after the top-level block that holds the caret, also at either
 * end of it, so the file never joins a line, a heading, a list or the
 * frontmatter, nor goes between the lines of a `$$` formula. Before that
 * block when it is the last one and takes in text after it, as for
 * `dropOutsidePayload`, such as math that is not closed yet. The Markdown
 * view's syntax tree reads display math as the document view does
 * (`markdownSource`).
 */
export function paragraphPlace(state: EditorState, pos: number): number {
  return besideBlock(state, blockAt(state, pos, 1).block ?? blockAt(state, pos, -1).block, pos);
}

/** A node of the Markdown view's syntax tree. */
type SyntaxNode = NonNullable<ReturnType<typeof ensureSyntaxTree>>["topNode"];

/** The top-level block of the text's syntax tree that holds `pos`, and the
 *  outermost Markdown image or link there. Each is null where there is none,
 *  and the block is null without the text's structure in time. At an edge of
 *  a node, `side` 1 finds the node that starts there, and -1 the one that
 *  ends there. */
function blockAt(state: EditorState, pos: number, side: 1 | -1 = 1): { block: SyntaxNode | null; link: SyntaxNode | null } {
  // `resolve` stays in the Markdown tree, out of the HTML parsed inside it.
  let node = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS)?.resolve(pos, side) ?? null;
  let link: SyntaxNode | null = null;
  while (node?.parent?.parent) {
    if (node.name === "Image" || node.name === "Link") link = node;
    node = node.parent;
  }
  return { block: node?.parent ? node : null, link };
}

/** Where a paragraph of its own goes beside a top-level `block`: at the end
 *  of its last line, or at the start of its first line when it is the last
 *  block and takes in text after it. Without a block, at the end of the line
 *  at `pos`. */
function besideBlock(state: EditorState, block: SyntaxNode | null, pos: number): number {
  const { doc } = state;
  if (!block) return doc.lineAt(pos).to;
  if (!block.nextSibling && takesInTextAfter(state, block.from)) return doc.lineAt(block.from).from;
  return doc.lineAt(block.to).to;
}

/** Whether the last top-level block, which starts at `from`, would take in a
 *  paragraph put after it, as a code fence or an HTML comment that is not
 *  closed yet does. Parses that block again with the paragraph after it. */
function takesInTextAfter(state: EditorState, from: number): boolean {
  const tree = state.facet(language)?.parser.parse(`${state.sliceDoc(from)}\n\nx`);
  return tree?.topNode.lastChild?.name !== "Paragraph";
}

/** The chip that stands in for a collapsed base64 payload. Pressing it shows
 *  the payload. CodeMirror keeps a chip it drew while the size stays the same,
 *  also after an edit before it, so the chip looks up where it is when
 *  pressed. */
class CollapsedWidget extends WidgetType {
  constructor(private readonly size: string) {
    super();
  }
  eq(other: CollapsedWidget): boolean {
    return other.size === this.size;
  }
  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-base64-collapsed";
    span.textContent = `…[${this.size}]`;
    span.title = "Base64 image data. Click to show it.";
    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      // A widget's DOM resolves to the start of its range, the payload start.
      view.dispatch({ effects: expandEffect.of(view.posAtDOM(span)) });
    });
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

export function base64Collapse(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private expanded = new Set<number>();

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(u: ViewUpdate): void {
        let expandedChanged = false;
        for (const tr of u.transactions) {
          // Remap stored "expanded" offsets through each edit so a change before
          // a collapsed region doesn't silently re-collapse it.
          if (tr.docChanged && this.expanded.size) {
            const mapped = new Set<number>();
            for (const pos of this.expanded) mapped.add(tr.changes.mapPos(pos));
            this.expanded = mapped;
            expandedChanged = true;
          }
          for (const e of tr.effects) {
            if (e.is(expandEffect)) {
              this.expanded.add(e.value);
              expandedChanged = true;
            }
          }
        }
        if (u.docChanged || u.viewportChanged || u.selectionSet || expandedChanged) {
          this.decorations = this.build(u.view);
        }
      }

      private build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const sel = view.state.selection.main;
        for (const { from, to } of view.visibleRanges) {
          const text = view.state.sliceDoc(from, to);
          DATA_URI.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = DATA_URI.exec(text)) !== null) {
            const payload = m[1];
            if (payload.length < MIN_COLLAPSED) continue;
            const payloadStart = from + m.index + (m[0].length - payload.length);
            const payloadEnd = from + m.index + m[0].length;
            if (this.expanded.has(payloadStart)) continue;
            if (sel.from <= payloadEnd && sel.to >= payloadStart) continue; // editing it
            const size = formatSize((payload.length * 3) / 4);
            builder.add(payloadStart, payloadEnd, Decoration.replace({ widget: new CollapsedWidget(size) }));
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}
