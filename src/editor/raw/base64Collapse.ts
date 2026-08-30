// Collapses long base64 data URIs in the raw (CodeMirror) view (spec §5.3):
// `data:image/png;base64,AAAA…` is shown as `data:image/png;base64,…[148 KB]`,
// click to expand. A replacing widget hides just the base64 payload; clicking it
// (or moving the selection into it) expands that occurrence. Gated by the
// `collapseBase64InRawView` setting (the extension is only added when enabled).

import { ViewPlugin, Decoration, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { StateEffect, RangeSetBuilder, type Extension } from "@codemirror/state";

// data: URI with a base64 payload long enough to be worth collapsing.
const DATA_URI = /data:[\w.+-]*\/?[\w.+-]*;base64,([A-Za-z0-9+/=]{64,})/g;

const expandEffect = StateEffect.define<number>();

class CollapsedWidget extends WidgetType {
  constructor(
    private readonly kb: number,
    private readonly onExpand: () => void,
  ) {
    super();
  }
  eq(other: CollapsedWidget): boolean {
    return other.kb === this.kb;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-base64-collapsed";
    span.textContent = `…[${this.kb} KB]`;
    span.title = "Base64 image data — click to expand";
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
            const payloadStart = from + m.index + (m[0].length - payload.length);
            const payloadEnd = from + m.index + m[0].length;
            if (this.expanded.has(payloadStart)) continue;
            if (sel.from <= payloadEnd && sel.to >= payloadStart) continue; // editing it
            const kb = Math.max(1, Math.round((payload.length * 3) / 4 / 1024));
            builder.add(
              payloadStart,
              payloadEnd,
              Decoration.replace({
                widget: new CollapsedWidget(kb, () => view.dispatch({ effects: expandEffect.of(payloadStart) })),
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
