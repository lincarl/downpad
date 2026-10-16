// Where `$` starts and ends math, and where `~` ends strikethrough. Crepe reads
// any two single dollars in a paragraph as inline math, so "$5 for kids and $10"
// showed "5 for kids and" as a formula, and its typing shortcuts turned a `$` or
// `~` typed after a space into math or strikethrough. Pandoc, Obsidian and VS
// Code's preview read these as text. These plugins read single-dollar math by
// Pandoc's rules and write each formula so that it reads back as the same
// formula, except two formulas side by side where one needs `$$`, because it
// holds a `$` no backslash escapes, ends in a backslash or comes right before
// a digit. No run of dollars can keep those apart. A typed closing `$` or `~`
// waits for the next character, which decides how a file with the same text
// would read. The one exception is a typed run of tildes right after a letter
// or digit, which opens no strikethrough, as in Milkdown's shortcut, so typed
// "10~20 and 30~40" stays text while GFM strikes it in a file.
//
// A paragraph that is only `$$...$$` is display math on GitHub, in VS Code and
// in Obsidian. remark-math reads it as inline math, which was saved as `$...$`.

import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { customInputRulesKey } from "@milkdown/kit/prose";
import { closeHistory } from "@milkdown/kit/prose/history";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@milkdown/kit/prose/state";
import type { Mark, Node as ProseNode, ResolvedPos } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
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

/** A micromark token type. */
type TokenType = Parameters<Parameters<Construct["tokenize"]>[0]["enter"]>[0];

// remark-math's token types, from which it builds its inline math node.
// micromark's types list them only where remark-math's own types are loaded,
// and remark-math is Crepe's dependency, not md-easy's.
const MATH = "mathText" as TokenType;
const MATH_SEQUENCE = "mathTextSequence" as TokenType;
const MATH_DATA = "mathTextData" as TokenType;

const DOLLAR = 36;
const BACKSLASH = 92;

/** Whether micromark's `code` is a space, tab or line ending. */
const isSpace = (code: Code): boolean => code !== null && (code < 0 || code === 32);

/** Whether micromark's `code` is a line ending. A tab and the spaces it
 *  expands to are -2 and -1. */
const isLineEnding = (code: Code): boolean => code !== null && code < -2;

/** Whether micromark's `code` is an ASCII digit. */
const isDigit = (code: Code): boolean => code !== null && code >= 48 && code <= 57;

/** Matches `$$`. Used as a check, so it reads nothing. */
const dollarRun: Construct = {
  partial: true,
  /** Reads the first `$` and matches when another follows. */
  tokenize(effects, ok, nok) {
    return start;

    /** At the first `$`. */
    function start(code: Code): State | undefined {
      effects.enter("data");
      effects.consume(code);
      return second;
    }

    /** Right after it. */
    function second(code: Code): State | undefined {
      effects.exit("data");
      return (code === DOLLAR ? ok : nok)(code);
    }
  },
};

/** Reads `$...$` math by Pandoc's rules, as remark-math's tokens, so remark-math
 *  builds the node. No space or line ending may follow the opening `$`. The
 *  formula ends at the first `$` that no backslash escapes, even one another `$`
 *  follows, as in "$a$$b$". That `$` may not follow a space or line ending that
 *  no backslash escapes, nor come right before a digit, or the pair is no
 *  formula. */
const singleDollarMath: Construct = {
  partial: true,
  /** Reads the formula from its opening `$`. */
  tokenize(effects, ok, nok) {
    /** Whether the last character read is a space, tab or line ending that no
     *  backslash escapes. */
    let space = false;
    return start;

    /** Read one `$` of the pair. */
    function sequence(code: Code): void {
      effects.enter(MATH_SEQUENCE);
      effects.consume(code);
      effects.exit(MATH_SEQUENCE);
    }

    /** Read a line ending inside the formula. */
    function lineEnding(code: Code): void {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
    }

    /** At the opening `$`. */
    function start(code: Code): State | undefined {
      effects.enter(MATH);
      sequence(code);
      return afterOpening;
    }

    /** Right after the opening `$`. */
    function afterOpening(code: Code): State | undefined {
      return code === null || isSpace(code) ? nok(code) : between(code);
    }

    /** Inside the formula, outside its text. */
    function between(code: Code): State | undefined {
      if (code === null) return nok(code);
      if (code === DOLLAR) {
        if (space) return nok(code);
        sequence(code);
        effects.exit(MATH);
        return afterClosing;
      }
      if (isLineEnding(code)) {
        lineEnding(code);
        space = true;
        return between;
      }
      effects.enter(MATH_DATA);
      return data(code);
    }

    /** In the formula's text on one line. */
    function data(code: Code): State | undefined {
      if (code === null || code === DOLLAR || isLineEnding(code)) {
        effects.exit(MATH_DATA);
        return between(code);
      }
      space = isSpace(code);
      effects.consume(code);
      return code === BACKSLASH ? escaped : data;
    }

    /** After a backslash, which makes the next character part of the formula. */
    function escaped(code: Code): State | undefined {
      space = false;
      if (code === null || isLineEnding(code)) {
        effects.exit(MATH_DATA);
        if (code === null) return nok(code);
        lineEnding(code);
        return between;
      }
      effects.consume(code);
      return data;
    }

    /** Right after the closing `$`. */
    function afterClosing(code: Code): State | undefined {
      return isDigit(code) ? nok(code) : ok(code);
    }
  },
};

/** Reads a single `$` by Pandoc's rules, as math or as text, before remark-math
 *  sees it. Text between two dollar amounts is then read as Markdown like any
 *  other. A run of two or more dollars is left to remark-math. */
const pandocDollar: Construct = {
  name: "mdEasyPandocDollar",
  /** Whether a `$` may start here. As in remark-math, one right after an
   *  unescaped `$` is part of its run, unless that `$` ended a formula. */
  previous(code) {
    const last = this.events.at(-1)?.[1].type;
    return code !== DOLLAR || last === "characterEscape" || last === MATH;
  },
  /** Reads the `$` as math or text, or leaves a run to remark-math. */
  tokenize(effects, ok, nok) {
    // remark-math reads no `$` right after a formula, so a run there is text.
    const afterFormula = this.events.at(-1)?.[1].type === MATH;
    return start;

    /** At the `$`. */
    function start(code: Code): State | undefined {
      return effects.check(dollarRun, afterFormula ? asText : nok, single)(code);
    }

    /** At a single `$`. */
    function single(code: Code): State | undefined {
      return effects.attempt(singleDollarMath, ok, asText)(code);
    }

    /** Read the `$` as text. */
    function asText(code: Code): State | undefined {
      effects.enter("data");
      effects.consume(code);
      effects.exit("data");
      return ok;
    }
  },
};

/** `value` without the spaces and line endings around it, which TeX ignores. A
 *  space or line ending escaped by a backslash, such as `\ `, stays. */
function trimMath(value: string): string {
  const start = value.replace(/^[ \t\r\n]+/, "");
  const trimmed = start.replace(/[ \t\r\n]+$/, "");
  if (!/(^|[^\\])\\(\\\\)*$/.test(trimmed)) return trimmed;
  return start.slice(0, trimmed.length + (start.startsWith("\r\n", trimmed.length) ? 2 : 1));
}

/** Whether `$inner$` followed by `after` reads back as the formula `inner`, both
 *  by Pandoc's rules and in remark-math. That needs no `$` inside, no space just
 *  inside either `$` unless escaped as `\ `, no backslash escaping the closing
 *  `$`, and no digit right after. */
function readsAsMath(inner: string, after: string): boolean {
  return (
    !inner.includes("$") &&
    !/^[ \t\r\n]/.test(inner) &&
    // A backslash escapes a CRLF line ending as a whole.
    !/(^|[^\\])(\\\\)*([ \t\r\n]|\\)$/.test(inner.replace(/\r\n/g, "\n")) &&
    !/^\d/.test(after)
  );
}

/** Whether every `$` in `value` follows an odd run of backslashes, which
 *  escapes it. */
const escapesEveryDollar = (value: string): boolean => !/(^|[^\\])(\\\\)*\$/.test(value);

/** Whether `node` sits right before or after another formula in `parent`. */
function besideFormula(node: unknown, parent: { children?: readonly { type: string }[] } | undefined): boolean {
  const siblings = parent?.children ?? [];
  const index = siblings.findIndex((sibling) => sibling === node);
  return index >= 0 && (siblings[index - 1]?.type === "inlineMath" || siblings[index + 1]?.type === "inlineMath");
}

/** `value` written so that a table cell holds it. GFM ends a cell at a `|`
 *  that no backslash escapes, so a `|` is written `\|`, as remark-gfm writes
 *  one in inline code, and GitHub, VS Code and md-easy read it back as `|`. No
 *  backslash may come before such a `|`, so TeX's `\|` is written `\Vert`,
 *  which TeX reads the same, with a space before a letter or `@`, which KaTeX
 *  reads as part of a command's name. A cell is one line, so line endings
 *  are written as spaces. */
function inTableCell(value: string): string {
  return value.replace(/\r\n?|\n/g, " ").replace(/(\\*)\|([a-zA-Z@]?)/g, (_match, backslashes: string, letter: string) =>
    backslashes.length % 2 ? `${backslashes.slice(1)}\\Vert${letter && " "}${letter}` : `${backslashes}\\|${letter}`,
  );
}

/** Wraps remark-math's inline math writer so every formula reads back as the
 *  same formula. remark-math alone reads it the same too, unless another formula
 *  sits right next to it. The spaces around it are left out. Where single
 *  dollars would not read back, such as right before a digit, it is fenced with
 *  the shortest run of two or more dollars that the formula does not hold on
 *  its own, and of three or more when it fills a line, because a paragraph that
 *  is only `$$...$$` reads as a math block. Line endings in such a formula are
 *  written as spaces, because a line that starts with `$$` and holds no other
 *  `$` opens a math block. TeX reads a line ending as a space, except at the end
 *  of a `%` comment. Right next to another formula a run of dollars reads as
 *  text, so a formula whose every `$` is escaped is fenced with single dollars
 *  there, with its line endings written as spaces too. An empty formula shows
 *  nothing and is left out, because `$$` reads as text or as the start of a
 *  math block. A formula in a table cell keeps its `|` from ending the cell
 *  (`inTableCell`). */
function pandocMathWriter(write: Handle): Handle {
  return (node: { value?: string }, parent, state, info) => {
    const trimmed = trimMath(node.value ?? "");
    if (!trimmed) return "";
    const value = state.stack.includes("tableCell") ? inTableCell(trimmed) : trimmed;
    const written: string = write({ ...node, value }, parent, state, info);
    // remark-math's fence, and the formula as it writes it between the fences.
    const size = written.search(/[^$]/);
    const inner = written.slice(size, -size);
    if (size === 1 && readsAsMath(inner, info.after)) return written;
    // Single dollars hold a `$` that a backslash escapes.
    const oneLine = value.replace(/\r\n?|\n/g, " ");
    if (besideFormula(node, parent) && escapesEveryDollar(value) && readsAsMath(oneLine.replace(/\$/g, "x"), info.after)) {
      return "$" + oneLine + "$";
    }
    const fillsLine = /^$|[\r\n]$/.test(info.before) && /^$|^[\r\n]/.test(info.after);
    let fence = fillsLine ? 3 : 2;
    while (new RegExp(`(^|[^$])${"\\$".repeat(fence)}([^$]|$)`).test(value)) fence++;
    return "$".repeat(fence) + inner.replace(/\r\n?|\n/g, " ") + "$".repeat(fence);
  };
}

/** Read a `\|` in a formula in a table cell, below `node`, as `|`, as GFM
 *  reads it in inline code and GitHub and VS Code read it in a formula.
 *  `inCell` says whether `node` is in a table cell. */
function unescapeCellPipes(node: MdNode, inCell = false): void {
  if (inCell && node.type === "inlineMath") {
    // An escaped backslash stays as it is and escapes nothing.
    node.value = node.value?.replace(/\\([\\|])/g, (escape, character: string) => (character === "|" ? "|" : escape));
  }
  node.children?.forEach((child) => unescapeCellPipes(child, inCell || node.type === "tableCell"));
}

/** Reads and writes single-dollar math by Pandoc's rules. Must follow Crepe's
 *  remark-math plugin, because micromark tries the syntax added last first, and
 *  this wraps remark-math's writer. */
export const pandocInlineMath = $remark("mdEasyPandocInlineMath", () =>
  /** Adds the reader, wraps remark-math's writer, escapes every `$` in text
   *  and reads `\|` in a formula in a table cell as `|`. */
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
    if (write) {
      const ours: Partial<Record<string, Handle>> = { inlineMath: pandocMathWriter(write) };
      // remark-math escapes a `$` in text through a pattern with an `after`
      // key, which mdast-util-to-markdown reads as a condition. It then left
      // the `$` unescaped before a character it always escapes, so `\$_GET`
      // was saved as `$\_GET`, and two of them read as a formula. This
      // pattern has no condition, so a `$` in text is always escaped.
      const unsafe: StringifyExtension["unsafe"] = [{ character: "$", inConstruct: "phrasing" }];
      extensions.push({ handlers: ours, unsafe });
    }
    return (tree: MdNode) => unescapeCellPipes(tree);
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
 *  a LaTeX code block. `$$...$$` inside other text stays inline math, and so do
 *  the first line of a list item, which must stay a paragraph, and a formula
 *  fenced with three or more dollars. */
export const oneLineDisplayMath = $remark("mdEasyOneLineDisplayMath", () => () => (tree: MdNode, file) => {
  const source = String(file.value);
  replaceNodes(tree, (node, parent) => {
    if (parent.type === "listItem" && parent.children?.[0] === node) return undefined;
    const only = node.type === "paragraph" && node.children?.length === 1 ? node.children[0] : undefined;
    const start = only?.position?.start.offset;
    if (only?.type !== "inlineMath" || start == null || !/^\$\$(?!\$)/.test(source.slice(start, start + 3))) {
      return undefined;
    }
    return { type: "code", lang: "LaTeX", value: only.value ?? "" };
  });
});

/** Up to 500 characters before `$pos` in its textblock, the most the typing
 *  shortcuts read, with other inline nodes as U+FFFC. */
function textBefore($pos: ResolvedPos): string {
  return $pos.parent.textBetween(Math.max(0, $pos.parentOffset - 500), $pos.parentOffset, undefined, "￼");
}

/** Whether a backslash at the end of `text` escapes the character after it. */
const escapes = (text: string): boolean => /(^|[^\\])(\\\\)*\\$/.test(text);

/** Whether a `$` or `~` typed after `before` must stay text, because it closes
 *  no math or strikethrough in Pandoc or GFM, whatever comes next. */
function staysText(before: string, mark: "$" | "~"): boolean {
  // Leave out a run of the same mark before the cursor, so the second `~` of
  // `~~` or `$` of `$$` counts as closing too.
  const rest = before.replace(mark === "$" ? /\$+$/ : /~+$/, "");
  // A closing mark never follows a space, starts a paragraph or is escaped.
  if (rest === "" || /\s$/.test(rest) || escapes(rest)) return true;
  // Which `~` the run closes is decided once the next character is known.
  if (mark === "~") return false;
  // Crepe's math shortcut, which `formula` follows, opens at the nearest `$`.
  // An opening mark is not escaped and has no space after it.
  const open = rest.lastIndexOf("$");
  if (open < 0 || escapes(rest.slice(0, open)) || /^\s/.test(rest.slice(open + 1))) return true;
  // remark-math closes a run of two or more only with a run of the same length.
  return rest.charAt(open - 1) === "$" && !escapes(rest.slice(0, open - 1));
}

/** Whether one of `marks` is inline code, whose text is literal. */
const isCode = (marks: readonly Mark[] | null | undefined): boolean => marks?.some((mark) => mark.type.spec.code) ?? false;

/** What typing `text` at `from` does with a closing `$` or `~`, or with no
 *  text, what the character before `from` does. "text" keeps it as text,
 *  "wait" decides once the next character is known, and undefined leaves the
 *  typing shortcuts to run. */
function closingMark(state: EditorState, from: number, text: string): "text" | "wait" | undefined {
  const $from = state.doc.resolve(from);
  if ($from.parent.type.spec.code) return undefined;
  const mark = text ? text.slice(-1) : textBefore($from).slice(-1);
  if (mark !== "$" && mark !== "~") return undefined;
  const before = plainText($from.parent).slice(0, $from.parentOffset) + text;
  return staysText(before.slice(0, -1), mark) ? "text" : "wait";
}

/** The character at `pos` in its textblock, "" at its end, or U+FFFC for another
 *  inline node. */
function characterAt(state: EditorState, pos: number): string {
  const $pos = state.doc.resolve(pos);
  const end = Math.min($pos.parentOffset + 1, $pos.parent.content.size);
  return $pos.parent.textBetween($pos.parentOffset, end, undefined, "￼");
}

/** The text of a textblock, one character for each position, with inline code
 *  and other inline nodes as U+FFFC and tildes in struck text as `^`. A `$` or
 *  `~` in inline code is code text, and a tilde inside struck text sits in a
 *  closed span, so neither pairs with anything. Both stand for punctuation,
 *  like the backticks and `~` they replace. */
function plainText(block: ProseNode): string {
  let text = "";
  block.forEach((child) => {
    if (!child.isText || isCode(child.marks)) text += "￼".repeat(child.nodeSize);
    else if (child.marks.some((mark) => mark.type.name === "strike_through")) text += (child.text ?? "").replace(/~/g, "^");
    else text += child.text ?? "";
  });
  return text;
}

/** GFM's class of the character next to a run of tildes: a space, which the
 *  start and end of the paragraph count as, punctuation, or neither.
 *  `character` is one UTF-16 unit, as md-easy's Markdown reader reads it, so
 *  a character outside the Basic Multilingual Plane, such as 😀, is neither. */
function classOf(character: string): "space" | "punctuation" | undefined {
  if (character === "" || /\s/.test(character)) return "space";
  return /[\p{P}\p{S}]/u.test(character) ? "punctuation" : undefined;
}

/** Whether `character` is a letter or digit in any script, or a combining mark,
 *  which belongs to the letter before it. */
const isWordCharacter = (character: string): boolean => /[\p{L}\p{M}\p{N}]/u.test(character);

/** The character before `index` in `text`. One outside the Basic Multilingual
 *  Plane, such as 𝑥, takes two UTF-16 units. It is taken whole, since
 *  Electron 44's V8 does not match such a character with a class of `\p{...}`
 *  escapes followed by `$`. */
const characterBefore = (text: string, index: number): string =>
  [...text.slice(Math.max(0, index - 2), index)].at(-1) ?? "";

/** Where strikethrough opens that the run of tildes at the end of `text` closes
 *  when `next` follows, or -1. GFM pairs the runs from the start of the
 *  paragraph. Each run of one or two that can close takes the nearest open run
 *  of its length, and the runs between them can no longer open. A run with a
 *  space after it cannot open, nor one before punctuation unless a space or
 *  punctuation comes before it, and the reverse holds for closing. A run right
 *  after a letter or digit opens nothing either, as in Milkdown's shortcut, so
 *  typed ranges such as "10~20 and 30~40" stay text, though GFM strikes them
 *  in a file. Such a run can still close. */
function strikeOpening(text: string, next: string): number {
  const open: { index: number; size: number }[] = [];
  for (const run of text.matchAll(/~+/g)) {
    // A backslash makes the first `~` text.
    const escaped = escapes(text.slice(0, run.index)) ? 1 : 0;
    const index = run.index + escaped;
    const size = run[0].length - escaped;
    const last = index + size === text.length;
    const before = classOf(text.charAt(index - 1));
    const after = classOf(last ? next.charAt(0) : text.charAt(index + size));
    if (size < 1 || size > 2) {
      if (last) return -1;
      continue;
    }
    if (!before || (before === "punctuation" && after)) {
      let match = open.length - 1;
      while (match >= 0 && open[match].size !== size) match--;
      if (match >= 0) {
        if (last) return open[match].index;
        open.length = match;
        continue;
      }
    }
    if (last) return -1;
    const opens = !after || (after === "punctuation" && before);
    if (opens && !isWordCharacter(characterBefore(text, index))) open.push({ index, size });
  }
  return -1;
}

/** Crepe's typing shortcut for inline math, which reads the text before the
 *  cursor with other inline nodes as U+FFFC. */
const MATH_SHORTCUT = /(?:\$)([^$]+)(?:\$)$/;

/** The text that a waiting mark closes: from `open`, where its opening `$` or
 *  run of tildes starts, to the waiting mark, which ends its closing run.
 *  `size` is the length of each run. */
interface Span {
  open: number;
  size: number;
}

/** The span that the waiting `$` or `~` at `pos` closes when `next`, the
 *  character after it or "" at the end of the paragraph, follows it, or null.
 *  In Pandoc a `$` closes unless a digit follows. It opens at the nearest `$`
 *  outside inline code, as in Crepe's shortcut. That shortcut would also
 *  replace inline code, a formula or another inline node between the marks,
 *  which then showed and was saved as U+FFFC, so none may be there. In GFM
 *  another `~` makes the run longer, and that one decides. Milkdown's shortcut
 *  paired a run of tildes with the first `~` that fits instead of the one GFM
 *  pairs it with. The text before the mark is read again, since it may have
 *  changed while the mark waited. */
function closedSpan(state: EditorState, pos: number, next: string): Span | null {
  const $end = state.doc.resolve(pos + 1);
  // Nothing closes in code, where a mark is code text.
  if ($end.parent.type.spec.code || isCode($end.nodeBefore?.marks)) return null;
  const mark = state.doc.textBetween(pos, pos + 1);
  const text = plainText($end.parent).slice(0, $end.parentOffset);
  if (mark === "$") {
    const match = MATH_SHORTCUT.exec(text);
    const value = match?.[1] ?? "";
    if (/^\d/.test(next) || staysText(text.slice(0, -1), "$") || !value.trim() || value.includes("￼")) return null;
    return { open: $end.pos - value.length - 2, size: 1 };
  }
  if (mark !== "~" || next.startsWith("~")) return null;
  const index = strikeOpening(text, next);
  return index < 0 ? null : { open: $end.start() + index, size: text.length - text.replace(/~+$/, "").length };
}

/** The marks for the text typed next once `tr` closes the waiting mark at
 *  `pos` in `state`, or null to take them from the text before the cursor.
 *  Closing replaces text, which clears marks set for the next character, such
 *  as by Ctrl+B, so they are set again. Right after the closing mark the text
 *  typed next gets the marks it would have had if the mark stayed text, so it
 *  is not struck, as in a file with the same text. Inside text that the change
 *  strikes, the marks set for the next character are struck too. */
function nextMarks(state: EditorState, pos: number, tr: Transaction): readonly Mark[] | null {
  const { empty, from, $from } = state.selection;
  const stored = state.storedMarks;
  const strikethrough = state.schema.marks.strike_through;
  if (!empty) return null;
  if (!strikethrough) return stored;
  if (from === pos + 1) {
    return state.doc.textBetween(pos, from) === "~" ? strikethrough.removeFromSet(stored ?? $from.marks()) : stored;
  }
  if (!stored) return null;
  const struck = strikethrough.isInSet(tr.doc.resolve(tr.mapping.map(from)).marks()) && !strikethrough.isInSet($from.marks());
  return struck ? strikethrough.create().addToSet(stored) : stored;
}

/** The change that closes math or strikethrough with the waiting `$` or `~` at
 *  `pos` where `next` lets it, or null. It sets the marks for the text typed
 *  next (`nextMarks`). */
function closing(state: EditorState, pos: number, next: string): Transaction | null {
  const span = closedSpan(state, pos, next);
  if (!span) return null;
  const { open, size } = span;
  const end = pos + 1;
  let tr: Transaction;
  if (state.doc.textBetween(pos, end) === "$") {
    const node = state.schema.nodes.math_inline?.createAndFill({ value: state.doc.textBetween(open + 1, pos) });
    if (!node) return null;
    tr = state.tr.replaceRangeWith(open, end, node);
  } else {
    const strikethrough = state.schema.marks.strike_through;
    if (!strikethrough) return null;
    tr = state.tr.delete(end - size, end).delete(open, open + size).addMark(open, end - 2 * size, strikethrough.create());
  }
  const marks = nextMarks(state, pos, tr);
  return marks ? tr.setStoredMarks(marks) : tr;
}

/** Dispatch `tr`, which may close a waiting mark, and set the marks it sets
 *  for the next character again if a change made in reply, such as a
 *  heading's new id, cleared them. */
function dispatchClosing(view: EditorView, tr: Transaction): void {
  const marks = tr.storedMarks;
  view.dispatch(tr);
  if (marks && view.state.storedMarks !== marks) view.dispatch(view.state.tr.setStoredMarks(marks));
}

/** Whether the selection keeps the waiting mark at `pos` waiting. It does
 *  while it covers the mark, as after Shift+Left, so typing replaces the mark,
 *  and while it lies between the marks of the span the mark closes, as after a
 *  click or Left there, so the text can be edited before it becomes a formula
 *  or struck. */
function keepsWaiting(state: EditorState, pos: number): boolean {
  const { from, to, empty } = state.selection;
  if (!empty && from <= pos && to > pos) return true;
  const span = closedSpan(state, pos, characterAt(state, pos + 1));
  return span !== null && from > span.open && to <= pos;
}

/** Whether a backtick at the start of `text`, typed right after the waiting
 *  mark at `pos`, makes Milkdown's inline code shortcut turn the text from an
 *  earlier backtick into code, along with the mark and the span it closes. The
 *  marks then stay code text, as in a file with the same text. A formula or
 *  strikethrough made first ended up in the code, where the formula's text
 *  was lost. The shortcut starts at the nearest backtick before the cursor. A
 *  formula would be one inline node, so a backtick inside it does not count,
 *  and the formula is made first. */
function codeTakes(state: EditorState, pos: number, text: string): boolean {
  const span = text.startsWith("`") ? closedSpan(state, pos, text) : null;
  if (!span) return false;
  const end = state.doc.textBetween(pos, pos + 1) === "$" ? span.open : pos + 1;
  return textBefore(state.doc.resolve(end)).includes("`");
}

/** Close math or strikethrough with the waiting mark at `pos` where `next`,
 *  typed or a line break, lets it, and report whether it did. `next` starts a
 *  new undo step, so undoing it keeps the formula or strikethrough. */
function closeWaiting(view: EditorView, pos: number, next: string): boolean {
  if (codeTakes(view.state, pos, next)) return false;
  const tr = closing(view.state, pos, next);
  if (!tr) return false;
  dispatchClosing(view, tr);
  view.dispatch(closeHistory(view.state.tr));
  return true;
}

/** Type `text` over the selection through the editor's typing hooks, as the
 *  browser does. */
function typeText(view: EditorView, text: string): void {
  const { from, to } = view.state.selection;
  const insert = () => view.state.tr.insertText(text, from, to);
  if (!view.someProp("handleTextInput", (handle) => handle(view, from, to, text, insert))) view.dispatch(insert());
}

/** A typed closing `$` or `~` that waits for the next character. `decide` is
 *  set once a change other than typing right after it, such as a paste or the
 *  cursor moving, means the character now after it decides, once the
 *  selection no longer keeps it waiting (`keepsWaiting`). */
interface Waiting {
  pos: number;
  decide: boolean;
}

/** The waiting mark, or null. A transaction sets it with this key's meta, a
 *  position or null. */
const waitingKey = new PluginKey<Waiting | null>("mdEasyWaitingMark");

/** The change that decides the waiting mark at `pos` by the character now
 *  after it, and stops it waiting. */
function decide(state: EditorState, pos: number): Transaction {
  return (closing(state, pos, characterAt(state, pos + 1)) ?? state.tr).setMeta(waitingKey, null);
}

/** The change that decides a typed closing `$` or `~` that still waits, or
 *  null when none waits or a composition runs, which decides it once it
 *  ends. */
function decision(view: EditorView): Transaction | null {
  const waiting = waitingKey.getState(view.state);
  return waiting && !view.composing ? decide(view.state, waiting.pos) : null;
}

/** Decide a typed closing `$` or `~` that still waits by the character now
 *  after it. The document editor calls this before its text is read, as for
 *  Save or a view switch, and when it loses focus, such as to the split's
 *  Markdown pane. A composition decides the mark once it ends. */
export function decideTypedMark(view: EditorView): void {
  const tr = decision(view);
  if (tr) dispatchClosing(view, tr);
}

/** The document as `decideTypedMark` would leave it, without changing the
 *  editor. The document editor reports this, so the text it reports, and
 *  autosave writes, holds what Save would write, while the mark keeps waiting
 *  for the next character. Deciding the mark later then changes nothing in
 *  that text, unless the next character makes it decide otherwise. */
export function decidedDoc(view: EditorView): ProseNode {
  return decision(view)?.doc ?? view.state.doc;
}

/** Once a composition ends, decide a mark that waited through it by the text
 *  it put after the mark, and let a `$` or `~` that it put right before the
 *  cursor wait like a typed one. */
function afterComposition(view: EditorView): void {
  if (view.isDestroyed) return;
  const waiting = waitingKey.getState(view.state);
  // A composition that put nothing after the mark, such as a cancelled one,
  // leaves it waiting, and so does one between the marks of its span, unless
  // the editor lost focus, which ended the composition.
  if (waiting) {
    const { selection } = view.state;
    const kept = (selection.empty && selection.from === waiting.pos + 1) || keepsWaiting(view.state, waiting.pos);
    if (!kept || !view.hasFocus()) dispatchClosing(view, decide(view.state, waiting.pos));
  }
  const { from, empty } = view.state.selection;
  if (empty && closingMark(view.state, from, "") === "wait") view.dispatch(view.state.tr.setMeta(waitingKey, from - 1));
}

/** Makes a typed `$` or `~` close math or strikethrough only where Markdown
 *  would read the same text that way. One that never could, such as after a
 *  space, stays text. One that could waits for the next character, since a `$`
 *  right before a digit, or a `~` after punctuation and before a letter, closes
 *  nothing. The next character typed decides, and so does Enter, the cursor
 *  leaving it, or another edit such as a paste. A cursor moved between the
 *  marks, as by a click or Left, keeps it waiting until the cursor leaves the
 *  span, so the text there can still be edited. Changes nobody typed, such as
 *  a heading's new id, leave it waiting. A `$` or `~` in a code block or
 *  inline code, or one that ends up there, is code text. Crepe's and
 *  Milkdown's typing shortcuts decided at once, and Milkdown's could strike
 *  from a different `~` than GFM. */
export const closingDelimiterGuard = $prose(() => {
  /** The editor's view, to tell whether a composition is running. */
  let editorView: EditorView | undefined;
  return new Plugin<Waiting | null>({
    key: waitingKey,
    state: {
      init: () => null,
      /** Follow the waiting mark through changes, and note when one means
       *  it must be decided. */
      apply(tr, waiting, before, after): Waiting | null {
        const set: number | null | undefined = tr.getMeta(waitingKey);
        if (set !== undefined) return set === null ? null : { pos: set, decide: false };
        if (!waiting) return null;
        if (!tr.docChanged) return after.selection.eq(before.selection) ? waiting : { ...waiting, decide: true };
        const { pos, deleted } = tr.mapping.mapResult(waiting.pos, 1);
        const mark = after.doc.textBetween(pos, Math.min(pos + 1, after.doc.content.size));
        if (deleted || (mark !== "$" && mark !== "~")) return null;
        // A mark that ends up in code, as when Ctrl+Alt+C makes its paragraph
        // a code block, is code text.
        if (after.doc.resolve(pos).parent.type.spec.code || isCode(after.doc.nodeAt(pos)?.marks)) return null;
        // Changes left out of the undo history, such as a heading's new id,
        // are nobody's edit.
        return { pos, decide: waiting.decide || tr.getMeta("addToHistory") !== false };
      },
    },
    props: {
      /** Decide a waiting mark by the character typed after it, and keep a
       *  typed closing mark as text or let it wait. Prose plugins handle typed
       *  text before the shortcuts, so they never see it. */
      handleTextInput(view, from, to, text, deflt) {
        // The text of a composition is not final yet. Changing the text
        // around it restarts the composition, which typed its first
        // character twice, so marks are decided once it ends.
        if (view.composing) return false;
        const waiting = waitingKey.getState(view.state);
        if (waiting?.pos === from - 1 && from === to && closeWaiting(view, waiting.pos, text)) {
          typeText(view, text);
          return true;
        }
        const decision = closingMark(view.state, from, text);
        if (!decision) return false;
        // A `$` typed inside a formula that a `$` waits to close closes it
        // first, so it waits instead. A `~` there is part of the formula, and
        // the reverse holds inside struck text.
        const inside =
          waiting && view.state.doc.textBetween(waiting.pos, waiting.pos + 1) !== text.slice(-1) && keepsWaiting(view.state, waiting.pos);
        const tr = deflt();
        view.dispatch(decision === "wait" && !inside ? tr.setMeta(waitingKey, from + text.length - 1) : tr);
        return true;
      },
      /** Close a waiting mark on Enter, since a line break after the mark ends
       *  its paragraph or line. */
      handleKeyDown(view, event) {
        const waiting = waitingKey.getState(view.state);
        const { empty, from } = view.state.selection;
        if (event.key === "Enter" && waiting?.pos === from - 1 && empty) closeWaiting(view, waiting.pos, "\n");
        return false;
      },
      handleDOMEvents: {
        /** Decide a waiting mark when the editor loses focus, so it shows
         *  and is reported as it will be saved. */
        blur(view) {
          decideTypedMark(view);
          return false;
        },
        /** Run `afterComposition` once a composition ends. Milkdown runs the
         *  shortcuts in a timeout then, such as for a dead-key `~`. This
         *  timeout is set first, so it runs first. */
        compositionend(view) {
          setTimeout(() => afterComposition(view));
          return false;
        },
      },
    },
    /** Keep the view for `appendTransaction`. */
    view(view) {
      editorView = view;
      return {};
    },
    /** Decide a waiting mark once a change says so, in the same update, so
     *  views drawn for that change already see the result. Crepe's list
     *  items restore the cursor to where it was when they were drawn. */
    appendTransaction(_transactions, _before, state) {
      const waiting = waitingKey.getState(state);
      if (!waiting?.decide || editorView?.composing || keepsWaiting(state, waiting.pos)) return null;
      return decide(state, waiting.pos);
    },
    /** Block Milkdown's shortcuts for a closing mark that stays text or
     *  waits. Milkdown also runs them when a composition ends, with no text
     *  and the character already typed. */
    filterTransaction(tr, state) {
      const input: { from: number; text: string } | undefined = tr.getMeta(customInputRulesKey);
      if (!input) return true;
      const decision = closingMark(state, input.from, input.text);
      return input.text ? decision !== "text" : !decision;
    },
  });
});

/** All three, for `editor.use` after Crepe's features. */
export const mathDelimiters: MilkdownPlugin[] = [oneLineDisplayMath, pandocInlineMath, closingDelimiterGuard].flat();
