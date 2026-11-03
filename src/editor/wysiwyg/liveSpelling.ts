import type { Node } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { closeHistory } from "@milkdown/kit/prose/history";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { managedSpellingAvailable, proseWords, SpellingController, spellingEdits, type SpellingWord } from "../spelling";
import { FrontmatterSpelling } from "./frontmatterSpelling";
import { frontmatterOf } from "./frontmatterHistory";

/** Collect complete prose textblocks, joining text across formatting marks. */
export function documentSpellingWords(doc: Node): SpellingWord[] {
  const words: SpellingWord[] = [];
  doc.descendants((node, position) => {
    if (node.type.spec.code) return false;
    if (!node.isTextblock) return true;
    let text = "";
    node.forEach((child, offset) => {
      text += " ".repeat(offset - text.length);
      text += child.isText && !child.marks.some((mark) => mark.type.spec.code || mark.type.name === "inlineCode")
        ? child.text : " ".repeat(child.nodeSize);
    });
    for (const word of proseWords(text, position + 1)) words.push(word);
    return false;
  });
  return words;
}

/** Keep spelling decorations out of document content, selection and undo. */
export function documentSpelling(frontmatter?: () => { root: HTMLElement | null; panel: HTMLElement | null }) {
  let controller: SpellingController | null = null;
  let metadata: FrontmatterSpelling | null = null;
  const key = new PluginKey<DecorationSet>("document-spelling");
  return {
    controller: () => controller,
    metadata: () => metadata,
    plugin: $prose(() => new Plugin<DecorationSet>({
      key,
      state: {
        init: () => DecorationSet.empty,
        apply(transaction, previous) {
          const words: SpellingWord[] | undefined = transaction.getMeta(key);
          if (words) return DecorationSet.create(transaction.doc, words.map(({ from, to }) => Decoration.inline(from, to, { class: "md-spelling-error" })));
          return transaction.doc !== transaction.before ? DecorationSet.empty : previous;
        },
      },
      props: {
        decorations: (state) => key.getState(state),
        attributes: managedSpellingAvailable() ? { spellcheck: "false" } : {},
      },
      view(view) {
        if (!managedSpellingAvailable()) return {};
        const root = frontmatter?.().root;
        if (root) metadata = new FrontmatterSpelling(root, () => frontmatter?.().panel ?? null, view);
        controller = new SpellingController({
          root: view.dom,
          snapshot: () => {
            const { doc } = view.state;
            return { token: doc, words: async () => documentSpellingWords(doc) };
          },
          paint: (words) => view.dispatch(view.state.tr.setMeta(key, words).setMeta("addToHistory", false)),
          positionAt: (x, y) => view.posAtCoords({ left: x, top: y })?.pos ?? null,
          replace: (word, replacement) => {
            const transaction = closeHistory(view.state.tr);
            for (const edit of spellingEdits(word, replacement).reverse()) transaction.insertText(edit.insert, edit.from, edit.to);
            view.dispatch(transaction);
            view.dispatch(closeHistory(view.state.tr).setMeta("addToHistory", false));
            view.focus();
          },
        });
        return {
          update(current, previous) {
            if (current.state.doc !== previous.doc) controller?.changed();
            if (frontmatterOf(current.state).block !== frontmatterOf(previous).block) metadata?.changed();
          },
          destroy() {
            controller?.destroy();
            controller = null;
            metadata?.destroy();
            metadata = null;
          },
        };
      },
    })),
  };
}
