import { closeHistory } from "@milkdown/kit/prose/history";
import type { EditorView } from "@milkdown/kit/prose/view";
import { frontmatterSpellingWords, type FrontmatterSpellingWord } from "../frontmatterSpelling";
import { SpellingController, type SpellingWord } from "../spelling";
import { focusCaret, matchRange, replaceInFrontmatter } from "./frontmatterFind";
import { frontmatterOf, setFrontmatter, type Frontmatter } from "./frontmatterHistory";

let highlights: Highlight | null = null;

/** Check metadata values without rewriting React's editable table cells. */
export class FrontmatterSpelling {
  readonly controller: SpellingController;
  private model: { token: Frontmatter; words: FrontmatterSpellingWord[] } | null = null;
  private marked: SpellingWord[] = [];
  private ranges: Range[] = [];
  private composing = false;
  private disposed = false;
  private readonly observer: MutationObserver;
  private readonly previousSpellcheck: string | null;
  private readonly compositionStart = (): void => { this.composing = true; };
  private readonly compositionEnd = (): void => { this.composing = false; this.paintRanges(); };

  constructor(private readonly root: HTMLElement, private readonly panel: () => HTMLElement | null, private readonly view: EditorView) {
    this.previousSpellcheck = root.getAttribute("spellcheck");
    root.setAttribute("spellcheck", "false");
    root.addEventListener("compositionstart", this.compositionStart);
    root.addEventListener("compositionend", this.compositionEnd);
    this.controller = new SpellingController({
      root,
      snapshot: () => {
        const model = this.current();
        return { token: model.token, words: async () => model.words };
      },
      paint: (words) => { this.marked = words; this.paintRanges(); },
      positionAt: (x, y) => this.positionAt(x, y),
      replace: (word, replacement) => this.replace(word, replacement),
    });
    // A table redraw replaces its text nodes. Rebuild ranges without scanning
    // again or touching the cell's text, selection or native undo state.
    this.observer = new MutationObserver((records) => {
      const panel = this.panel();
      if (records.some(({ target }) => target === this.root || panel?.contains(target))) this.paintRanges();
    });
    this.observer.observe(root, { childList: true, characterData: true, subtree: true });
  }

  /** Invalidate positions and schedule checking after a metadata model edit. */
  changed(): void {
    this.marked = [];
    this.paintRanges();
    this.controller.changed();
  }

  /** Read words from the complete metadata model, including collapsed fields. */
  private current() {
    const token = frontmatterOf(this.view.state);
    if (this.model?.token !== token) this.model = { token, words: token.block ? frontmatterSpellingWords(token.block) : [] };
    return this.model;
  }

  /** Paint the ranges owned by this editor in the shared highlight registry. */
  private paintRanges(): void {
    if (this.composing || typeof Highlight === "undefined" || typeof CSS === "undefined" || !CSS.highlights) return;
    if (!highlights) highlights = new Highlight();
    for (const range of this.ranges) highlights.delete(range);
    this.ranges = [];
    const panel = this.panel();
    if (!this.disposed && panel) {
      const words = new Map(this.current().words.map((word) => [word.from, word]));
      for (const marked of this.marked) {
        const word = words.get(marked.from);
        if (!word || word.word !== marked.word) continue;
        const range = matchRange(panel, word.cell);
        if (range && range.toString() === word.word) { highlights.add(range); this.ranges.push(range); }
      }
    }
    CSS.highlights.set("md-spelling-metadata", highlights);
  }

  /** Map a clicked metadata value to its lossless YAML source offset. */
  private positionAt(x: number, y: number): number | null {
    const caret = this.root.ownerDocument.caretPositionFromPoint?.(x, y);
    if (!caret) return null;
    const element = caret.offsetNode instanceof Element ? caret.offsetNode : caret.offsetNode.parentElement;
    const cell = element?.closest<HTMLElement>('.frontmatter-value-edit[data-part="value"]');
    if (!cell || !this.panel()?.contains(cell)) return null;
    const anchor = this.current().words.find((word) => word.cell.line === Number(cell.dataset.line));
    if (!anchor) return null;
    const range = this.root.ownerDocument.createRange();
    range.selectNodeContents(cell);
    range.setEnd(caret.offsetNode, caret.offset);
    return anchor.from - anchor.cell.from + range.toString().length;
  }

  /** Apply only a YAML-safe value correction through the document undo stack. */
  private replace(clicked: SpellingWord, replacement: string): void {
    const model = this.current();
    const word = model.words.find((word) => word.from === clicked.from && word.to === clicked.to);
    if (!word || !model.token.block) throw new Error("The metadata changed. Open its spelling menu again.");
    const block = replaceInFrontmatter(model.token.block, [word.cell], replacement);
    if (block === model.token.block) throw new Error("This correction would change the metadata format. Edit the value directly.");
    this.view.dispatch(setFrontmatter(this.view.state, closeHistory(this.view.state.tr), { block }));
    this.view.dispatch(closeHistory(this.view.state.tr).setMeta("addToHistory", false));
    const panel = this.panel();
    if (panel) focusCaret(panel, { ...word.cell, from: word.cell.from + replacement.length });
  }

  /** Stop observing and remove this editor's ranges and pending checks. */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.composing = false;
    this.controller.destroy();
    this.observer.disconnect();
    this.paintRanges();
    this.root.removeEventListener("compositionstart", this.compositionStart);
    this.root.removeEventListener("compositionend", this.compositionEnd);
    if (this.previousSpellcheck === null) this.root.removeAttribute("spellcheck");
    else this.root.setAttribute("spellcheck", this.previousSpellcheck);
  }
}
