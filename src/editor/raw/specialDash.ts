// Highlights dash-like characters that are NOT the plain ASCII hyphen-minus
// (U+002D) in the raw (CodeMirror) Markdown view. A monospace font squeezes an
// em dash (—) into the same cell as a hyphen (-), so the two are almost
// impossible to tell apart in the source — which means a stray em/en dash in a
// title reads exactly like a hyphen. Marking the non-hyphen dashes with a chip
// makes the raw view *accurately* show which dash is which (the document view
// already renders them at their true width).

import { ViewPlugin, Decoration, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, type Extension } from "@codemirror/state";

/** Dash-like code points that render ~identically to a hyphen but are not U+002D.
 *  The plain ASCII hyphen-minus is deliberately absent — it's the "normal" dash. */
export const SPECIAL_DASHES: Readonly<Record<string, string>> = {
  "‐": "Hyphen",
  "‑": "Non-breaking hyphen",
  "‒": "Figure dash",
  "–": "En dash",
  "—": "Em dash",
  "―": "Horizontal bar",
  "−": "Minus sign",
};

export interface DashHit {
  /** Document offset of the character. */
  from: number;
  /** The character itself (always a single code unit here). */
  ch: string;
  /** Human-readable name, e.g. "Em dash". */
  name: string;
}

/** A "U+2014"-style label for a character. */
export function codePointLabel(ch: string): string {
  return "U+" + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
}

/** Find every special (non-hyphen) dash in `text`, with offsets shifted by `base`.
 *  Pure and side-effect free so it can be unit-tested without CodeMirror. */
export function findSpecialDashes(text: string, base = 0): DashHit[] {
  const hits: DashHit[] = [];
  for (let i = 0; i < text.length; i++) {
    const name = SPECIAL_DASHES[text[i]];
    if (name) hits.push({ from: base + i, ch: text[i], name });
  }
  return hits;
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    for (const hit of findSpecialDashes(text, from)) {
      builder.add(
        hit.from,
        hit.from + hit.ch.length,
        Decoration.mark({
          class: "cm-special-dash",
          attributes: { title: `${hit.name} (${hit.ch}) ${codePointLabel(hit.ch)} — not a plain hyphen` },
        }),
      );
    }
  }
  return builder.finish();
}

/** CodeMirror extension that chips non-hyphen dashes in the raw Markdown view. */
export function specialDashHighlight(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = build(view);
      }

      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
