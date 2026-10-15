// Where `$` starts and ends math, and where `~` ends strikethrough. Crepe reads
// any two single dollars in a paragraph as inline math, so "$5 for kids and $10"
// showed "5 for kids and" as a formula, and its typing shortcuts turned a `$` or
// `~` typed after a space into math or strikethrough. Pandoc, Obsidian and VS
// Code's preview read these as text. These plugins follow their rules, and write
// every formula so that it reads back the same way.
//
// A paragraph that is only `$$...$$` is display math on GitHub, in VS Code and
// in Obsidian. remark-math reads it as inline math, which was saved as `$...$`.

import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { customInputRulesKey } from "@milkdown/kit/prose";
import { type EditorState, Plugin } from "@milkdown/kit/prose/state";
import type { RemarkParser } from "@milkdown/kit/transformer";
import { $prose, $remark } from "@milkdown/kit/utils";

/** The parts of an mdast node these plugins read or write. */
interface MdNode {
  type: string;
  value?: string;
  lang?: string | null;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** remark's plugin data, where plugins register micromark and remark-stringify
 *  extensions. */
type RemarkData = RemarkParser["namespace"];
type MicromarkExtension = NonNullable<RemarkData["micromarkExtensions"]>[number];
/** A micromark syntax construct, such as remark-math's `$x$`. */
type Construct = Exclude<NonNullable<NonNullable<MicromarkExtension["text"]>[number]>, readonly unknown[]>;
/** A micromark tokenizer step, which reads one character and returns the next step. */
type State = ReturnType<Construct["tokenize"]>;
/** A character as micromark reads it. Tabs and line endings are negative, and
 *  the end of the text is null. */
type Code = Parameters<State>[0];
type StringifyExtension = NonNullable<RemarkData["toMarkdownExtensions"]>[number];
/** A remark-stringify writer for one type of mdast node. */
type Handle = NonNullable<NonNullable<StringifyExtension["handlers"]>["text"]>;

const DOLLAR = 36;
const BACKSLASH = 92;

/** Whether micromark's `code` is a space, tab or line ending. */
const isSpace = (code: Code): boolean => code !== null && (code < 0 || code === 32);

/** Whether micromark's `code` is an ASCII digit. */
const isDigit = (code: Code): boolean => code !== null && code >= 48 && code <= 57;

/** Matches a `$` that opens single-dollar math Pandoc reads as text. That is one
 *  with a space or line ending right after it, or one whose closing `$`, found
 *  the way remark-math finds it, has a space right before it or a digit right
 *  after it. A space escaped as `\ ` may come before the closing `$`. Used as a
 *  check, so it reads nothing. */
const textDollarPair: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    /** Backslashes in a row right before the current character. */
    let backslashes = 0;
    /** Whether the character before the current run of dollars is an unescaped space. */
    let spaceBefore = false;
    /** Dollars in the current run. */
    let run = 0;
    return start;

    /** At the opening `$`. */
    function start(code: Code): State | undefined {
      effects.enter("data");
      effects.consume(code);
      return afterOpening;
    }

    /** Right after the opening `$`. `$$` math has no such rules. */
    function afterOpening(code: Code): State | undefined {
      if (code === DOLLAR) return finish(code, false);
      if (isSpace(code)) return finish(code, true);
      return inside(code);
    }

    /** Between the dollars. With no closing `$`, remark-math reads no math either. */
    function inside(code: Code): State | undefined {
      if (code === null) return finish(code, false);
      if (code === DOLLAR) {
        run = 0;
        return dollars(code);
      }
      spaceBefore = isSpace(code) && backslashes % 2 === 0;
      backslashes = code === BACKSLASH ? backslashes + 1 : 0;
      effects.consume(code);
      return inside;
    }

    /** In a run of dollars. Only a single one closes the math. */
    function dollars(code: Code): State | undefined {
      if (code === DOLLAR) {
        run++;
        effects.consume(code);
        return dollars;
      }
      if (run > 1) {
        backslashes = 0;
        return inside(code);
      }
      return finish(code, spaceBefore || isDigit(code));
    }

    /** End the check, matching when the pair is text. */
    function finish(code: Code, text: boolean): State | undefined {
      effects.exit("data");
      return (text ? ok : nok)(code);
    }
  },
};

/** Reads a `$` as text where it opens single-dollar math that Pandoc reads as
 *  text, so that remark-math, which is tried after it, never pairs it. The text
 *  up to the next `$` is then read as Markdown like any other, and that `$` may
 *  still open math, as in "$5 and $x$". */
const pandocDollar: Construct = {
  name: "mdEasyPandocDollar",
  // As in remark-math, a `$` right after an unescaped one is part of its run.
  previous(code) {
    return code !== DOLLAR || this.events.at(-1)?.[1].type === "characterEscape";
  },
  tokenize(effects, ok, nok) {
    return (code) => effects.check(textDollarPair, asText, nok)(code);

    /** Read the opening `$` as text. */
    function asText(code: Code): State | undefined {
      effects.enter("data");
      effects.consume(code);
      effects.exit("data");
      return ok;
    }
  },
};

/** `value` without the spaces and line endings around it, which TeX ignores. A
 *  space escaped as `\ ` stays. */
function trimMath(value: string): string {
  const start = value.replace(/^[ \t\r\n]+/, "");
  const trimmed = start.replace(/[ \t\r\n]+$/, "");
  return /(^|[^\\])\\(\\\\)*$/.test(trimmed) ? start.slice(0, trimmed.length + 1) : trimmed;
}

/** Whether `$inner$` followed by `after` reads as math by Pandoc's rules, with
 *  no space just inside either `$`, unless escaped as `\ `, and no digit right
 *  after. */
function readsAsMath(inner: string, after: string): boolean {
  return !/^[ \t\r\n]/.test(inner) && !/(^|[^\\])(\\\\)*[ \t\r\n]$/.test(inner) && !/^\d/.test(after);
}

/** Wraps remark-math's inline math writer so every formula reads back as the
 *  same formula. The spaces around it are left out. Where single dollars would
 *  read as text, such as right before a digit, it is fenced with the shortest
 *  run of two or more dollars that the formula does not hold on its own, since
 *  `$$` math has no such rules. An empty formula shows nothing and is left out,
 *  because `$$` reads as text or as the start of a math block. */
function pandocMathWriter(write: Handle): Handle {
  return (node: { value?: string }, parent, state, info) => {
    const value = trimMath(node.value ?? "");
    if (!value) return "";
    const written: string = write({ ...node, value }, parent, state, info);
    const inner = written.slice(1, -1);
    if (written.startsWith("$$") || readsAsMath(inner, info.after)) return written;
    let size = 2;
    while (new RegExp(`(^|[^$])${"\\$".repeat(size)}([^$]|$)`).test(value)) size++;
    const fence = "$".repeat(size);
    return fence + inner + fence;
  };
}

/** Reads and writes single-dollar math by Pandoc's rules, with no space just
 *  inside either `$` and no digit right after the closing one. Must follow
 *  Crepe's remark-math plugin, because micromark tries the syntax added last
 *  first, and this wraps remark-math's writer. */
export const pandocInlineMath = $remark("mdEasyPandocInlineMath", () =>
  function () {
    const data = this.data();
    (data.micromarkExtensions ??= []).push({ text: { [DOLLAR]: pandocDollar } });
    const extensions = (data.toMarkdownExtensions ??= []);
    let write: Handle | undefined;
    for (const extension of extensions) {
      // remark-stringify's types do not list remark-math's node types.
      const handlers: Partial<Record<string, Handle>> = extension.handlers ?? {};
      write = handlers.inlineMath ?? write;
    }
    if (!write) return;
    const ours: Partial<Record<string, Handle>> = { inlineMath: pandocMathWriter(write) };
    extensions.push({ handlers: ours });
  },
);

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

/** Whether the typing shortcuts, run for `text` typed at `from`, would close
 *  math or strikethrough with a `$` or `~` that must stay text. */
function closesAsText(state: EditorState, from: number, text: string): boolean {
  const $from = state.doc.resolve(from);
  if ($from.parent.type.spec.code) return false;
  // The shortcuts read up to 500 characters before the cursor.
  const start = Math.max(0, $from.parentOffset - 500);
  const before = $from.parent.textBetween(start, $from.parentOffset, undefined, "￼") + text;
  const mark = before.slice(-1);
  return (mark === "$" || mark === "~") && staysText(before.slice(0, -1), mark);
}

/** Keeps a `$` or `~` as plain text where Markdown would not close math or
 *  strikethrough with it, such as after a space. Crepe's and Milkdown's typing
 *  shortcuts did. */
export const closingDelimiterGuard = $prose(
  () =>
    new Plugin({
      props: {
        // Prose plugins handle typed text before the shortcuts, so they never
        // see it.
        handleTextInput(view, from, _to, text, deflt) {
          if (!closesAsText(view.state, from, text)) return false;
          view.dispatch(deflt());
          return true;
        },
      },
      // Milkdown also runs the shortcuts when a composition ends, such as a
      // dead-key `~`, with no text and the character already typed. Drop what
      // they would do then.
      filterTransaction(tr, state) {
        const input: { from: number; text: string } | undefined = tr.getMeta(customInputRulesKey);
        return !input || !closesAsText(state, input.from, input.text);
      },
    }),
);

/** All three, for `editor.use` after Crepe's features. */
export const mathDelimiters: MilkdownPlugin[] = [oneLineDisplayMath, pandocInlineMath, closingDelimiterGuard].flat();
