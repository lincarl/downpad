import { ensureSyntaxTree, language } from "@codemirror/language";
import { isolateHistory } from "@codemirror/commands";
import { ChangeSet, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import { managedSpellingAvailable, proseWords, SpellingController, spellingEdits, yieldSpelling, type SpellingWord } from "../spelling";
import { splitFrontmatter } from "../../document/frontmatter";
import { frontmatterSpellingWords } from "../frontmatterSpelling";
import { replaceInFrontmatter } from "../wysiwyg/frontmatterFind";

const marks = StateEffect.define<SpellingWord[]>();
const underline = Decoration.mark({ class: "md-spelling-error" });
const decorations = StateField.define({
  create: () => Decoration.none,
  update(previous, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(marks)) return Decoration.set(effect.value.flatMap((word) => (word.parts ?? [word]).map(({ from, to }) => underline.range(from, to))), true);
    }
    return transaction.docChanged ? Decoration.none : previous;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const excludedNodes = new Set(["Frontmatter", "InlineCode", "FencedCode", "CodeBlock", "URL", "Autolink", "HTMLTag", "HTMLBlock", "CommentBlock", "LinkTitle", "LinkReference", "LinkLabel"]);
const formattingNodes = new Set(["EmphasisMark", "StrikethroughMark", "Escape"]);

/** Remove formatting delimiters whose entire contents a correction deletes. */
export function sourceSpellingChanges(state: EditorState, word: SpellingWord, replacement: string): ChangeSet {
  let changes = state.changes(spellingEdits(word, replacement));
  if (!word.parts || word.parts.length < 2) return changes;
  const tree = ensureSyntaxTree(state, word.to, 50) ?? state.facet(language)?.parser.parse(state.doc.toString());
  const wrappers: { from: number; contentFrom: number; contentTo: number; to: number }[] = [];
  tree?.iterate({
    from: word.from,
    to: word.to,
    enter(node) {
      if (!["Emphasis", "StrongEmphasis", "Strikethrough"].includes(node.name)) return;
      const open = node.node.firstChild;
      const close = node.node.lastChild;
      if (open && close && open !== close && formattingNodes.has(open.name) && formattingNodes.has(close.name)) {
        wrappers.push({ from: open.from, contentFrom: open.to, contentTo: close.from, to: close.to });
      }
    },
  });
  // Inner wrappers must disappear first so an emptied outer wrapper also goes.
  for (const wrapper of wrappers.reverse()) {
    const contentFrom = changes.mapPos(wrapper.contentFrom, -1);
    const contentTo = changes.mapPos(wrapper.contentTo, 1);
    if (contentFrom !== contentTo) continue;
    changes = changes.compose(ChangeSet.of([
      { from: changes.mapPos(wrapper.from, 1), to: contentFrom },
      { from: contentTo, to: changes.mapPos(wrapper.to, -1) },
    ], changes.newLength));
  }
  return changes;
}

/** Parse the entire Markdown model, preserving word positions across formatting. */
export async function sourceSpellingWords(state: EditorState): Promise<SpellingWord[]> {
  const source = state.doc.toString();
  const { frontmatter } = splitFrontmatter(source);
  const parser = state.facet(language)?.parser;
  if (!parser) return proseWords(source);
  const parse = parser.startParse(source);
  let tree = parse.advance();
  let started = performance.now();
  while (!tree) {
    if (performance.now() - started > 10) {
      await yieldSpelling();
      started = performance.now();
    }
    tree = parse.advance();
  }
  const spans: { from: number; to: number; join: boolean }[] = [];
  tree.iterate({
    enter(node) {
      if (excludedNodes.has(node.name)) {
        spans.push({ from: node.from, to: node.to, join: false });
        return false;
      }
      if (formattingNodes.has(node.name)) {
        // Escape includes the following literal character. Only omit its slash.
        spans.push({ from: node.from, to: node.name === "Escape" ? node.from + 1 : node.to, join: true });
        return false;
      }
    },
  });
  spans.sort((a, b) => a.from - b.from);
  let text = "";
  const positions: number[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.from < at) continue;
    text += source.slice(at, span.from);
    for (let pos = at; pos < span.from; pos++) positions.push(pos);
    if (!span.join) {
      text += " ";
      positions.push(span.from);
    }
    at = span.to;
  }
  text += source.slice(at);
  for (let pos = at; pos < source.length; pos++) positions.push(pos);
  const bodyWords = proseWords(text).map((word) => {
    const parts: { from: number; to: number }[] = [];
    for (let pos = word.from; pos < word.to; pos++) {
      const sourcePos = positions[pos];
      const previous = parts[parts.length - 1];
      if (previous?.to === sourcePos) previous.to++;
      else parts.push({ from: sourcePos, to: sourcePos + 1 });
    }
    return { word: word.word, from: parts[0].from, to: parts[parts.length - 1].to, parts };
  });
  return [...(frontmatter ? frontmatterSpellingWords(frontmatter) : []), ...bodyWords];
}

/** Install app-owned checks while browser previews retain native spelling. */
export function sourceSpelling() {
  let controller: SpellingController | null = null;
  return {
    controller: () => controller,
    extension: managedSpellingAvailable() ? [decorations, ViewPlugin.define((view) => {
      controller = new SpellingController({
        root: view.contentDOM,
        snapshot: () => {
          const { state } = view;
          return { token: state.doc, words: () => sourceSpellingWords(state) };
        },
        paint: (words) => view.dispatch({ effects: marks.of(words) }),
        positionAt: (x, y) => view.posAtCoords({ x, y }),
        replace: (word, replacement) => {
          const block = splitFrontmatter(view.state.doc.toString()).frontmatter;
          if (block && word.from < block.length) {
            const value = frontmatterSpellingWords(block).find((value) => value.from === word.from && value.to === word.to);
            if (!value || replaceInFrontmatter(block, [value.cell], replacement) === block) {
              throw new Error("This correction would change the metadata format. Edit the value directly.");
            }
          }
          view.dispatch({ changes: sourceSpellingChanges(view.state, word, replacement), annotations: isolateHistory.of("full"), userEvent: "input.spelling" });
          view.focus();
        },
      });
      return {
        update(update) { if (update.docChanged) controller?.changed(); },
        destroy() { controller?.destroy(); controller = null; },
      };
    })] : [],
  };
}
