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
// searches. A file dropped on the payload goes in after the image instead
// (`pastBase64Payload`).

import { ViewPlugin, Decoration, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { StateEffect, RangeSetBuilder, type Extension, type Text } from "@codemirror/state";
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

/**
 * A position moved out of the base64 payload of a data URI it is in or at
 * either edge of, to after the image's closing `)`, or to the end of the
 * payload if no `)` follows on its line. A file dropped on a collapsed
 * image's chip would otherwise go into the data, since the chip covers the
 * payload and a drop on it finds one of its edges.
 */
export function pastBase64Payload(doc: Text, pos: number): number {
  const payload = payloadRanges(doc).find(([start, end]) => pos >= start && pos <= end);
  if (!payload) return pos;
  const line = doc.lineAt(payload[1]);
  const close = line.text.indexOf(")", payload[1] - line.from);
  return close < 0 ? payload[1] : line.from + close + 1;
}

class CollapsedWidget extends WidgetType {
  constructor(
    private readonly size: string,
    private readonly onExpand: () => void,
  ) {
    super();
  }
  eq(other: CollapsedWidget): boolean {
    return other.size === this.size;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-base64-collapsed";
    span.textContent = `…[${this.size}]`;
    span.title = "Base64 image data. Click to show it.";
    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.onExpand();
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
            builder.add(
              payloadStart,
              payloadEnd,
              Decoration.replace({
                widget: new CollapsedWidget(size, () => view.dispatch({ effects: expandEffect.of(payloadStart) })),
              }),
            );
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}
