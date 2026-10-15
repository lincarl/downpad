// Where `$` starts and ends math, and where `~` ends strikethrough. Crepe reads
// any two single dollars in a paragraph as inline math, so "$5 for kids and $10"
// showed "5 for kids and" as a formula, and its typing shortcuts turned a `$` or
// `~` typed after a space into math or strikethrough. Pandoc, Obsidian and VS
// Code's preview read these as text. These plugins follow their rules.
//
// A paragraph that is only `$$...$$` is display math on GitHub, in VS Code and
// in Obsidian. remark-math reads it as inline math, which was saved as `$...$`.

import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { Plugin } from "@milkdown/kit/prose/state";
import { $prose, $remark } from "@milkdown/kit/utils";

/** The parts of an mdast node these plugins read or write. */
interface MdNode {
  type: string;
  value?: string;
  lang?: string | null;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** Replace nodes below `parent`, depth first. `replace` gets each node and its
 *  parent, and returns a new node, or undefined to keep the node and visit its
 *  children. */
function replaceNodes(parent: MdNode, replace: (node: MdNode, parent: MdNode) => MdNode | undefined): void {
  parent.children?.forEach((child, index, children) => {
    const next = replace(child, parent);
    if (next) children[index] = next;
    else replaceNodes(child, replace);
  });
}

/** Reads single-dollar math only where Pandoc does, with no space just inside
 *  either `$` and no digit right after the closing one. Other pairs stay text,
 *  as written. Must follow Crepe's remark-math plugin. A price followed by real
 *  math in one paragraph, as in "$5 and $x$", keeps both as text, because
 *  remark-math already paired the second `$` with the first. */
export const pandocInlineMath = $remark("mdEasyPandocInlineMath", () => () => (tree: MdNode, file) => {
  const source = String(file.value);
  replaceNodes(tree, (node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type !== "inlineMath" || start == null || end == null) return undefined;
    // In a pair that spans lines, each later line starts with the quote markers
    // and indentation of its list or quote. Those are not part of the text, and
    // neither are spaces at the end of a line.
    const text = source.slice(start, end).replace(/[ \t]*(\r?\n)[ \t>]*/g, "$1");
    // `$$` math has no such rules.
    if (text.startsWith("$$")) return undefined;
    const inner = text.slice(1, -1);
    return /^\s|\s$/.test(inner) || /\d/.test(source.charAt(end)) ? { type: "text", value: text } : undefined;
  });
});

/** Reads a paragraph that is only `$$...$$` as a math block, which Crepe keeps as
 *  a LaTeX code block. `$$...$$` inside other text stays inline math, and so does
 *  the first line of a list item, which must stay a paragraph. */
export const oneLineDisplayMath = $remark("mdEasyOneLineDisplayMath", () => () => (tree: MdNode, file) => {
  const source = String(file.value);
  replaceNodes(tree, (node, parent) => {
    if (parent.type === "listItem" && parent.children?.[0] === node) return undefined;
    const only = node.type === "paragraph" && node.children?.length === 1 ? node.children[0] : undefined;
    const start = only?.position?.start.offset;
    if (only?.type !== "inlineMath" || start == null || !source.startsWith("$$", start)) return undefined;
    return { type: "code", lang: "LaTeX", value: only.value ?? "" };
  });
});

/** Whether a `$` or `~` typed after `before` must stay text, because the math
 *  or strikethrough it would close is not one in Pandoc or GFM. */
function staysText(before: string, mark: "$" | "~"): boolean {
  // Leave out a run of the same mark before the cursor, so the second `~` of
  // `~~` or `$` of `$$` counts as closing too.
  const rest = before.replace(mark === "$" ? /\$+$/ : /~+$/, "");
  // A closing mark never follows a space.
  if (/\s$/.test(rest)) return true;
  if (mark === "$") {
    // Crepe's math shortcut opens at the nearest `$`. An opening mark never has
    // a space after it.
    const open = rest.lastIndexOf("$");
    return open < 0 || /^\s/.test(rest.slice(open + 1));
  }
  // Milkdown's strikethrough shortcut opens at the first `~` that fits, not the
  // nearest one, so it could strike a span that holds other tildes. Let it run
  // only when a single run of tildes, as long as the closing one and with no
  // space after it, can open the span.
  const closing = before.length - rest.length + 1;
  const runs = [...rest.matchAll(/~+/g)];
  if (runs.length !== 1) return true;
  const [run] = runs;
  return run[0].length !== closing || /^\s/.test(rest.slice(run.index + run[0].length));
}

/** Types a `$` or `~` as plain text where Markdown would not close math or
 *  strikethrough with it, such as after a space. Crepe's and Milkdown's typing
 *  shortcuts did. Prose plugins handle typed text before the shortcuts, so they
 *  never see it. */
export const closingDelimiterGuard = $prose(
  () =>
    new Plugin({
      props: {
        handleTextInput(view, from, _to, text, deflt) {
          if (text !== "$" && text !== "~") return false;
          const $from = view.state.doc.resolve(from);
          if ($from.parent.type.spec.code) return false;
          // The shortcuts read up to 500 characters before the cursor.
          const start = Math.max(0, $from.parentOffset - 500);
          if (!staysText($from.parent.textBetween(start, $from.parentOffset, undefined, "\uFFFC"), text)) return false;
          view.dispatch(deflt());
          return true;
        },
      },
    }),
);

/** All three, for `editor.use` after Crepe's features. */
export const mathDelimiters: MilkdownPlugin[] = [oneLineDisplayMath, pandocInlineMath, closingDelimiterGuard].flat();
