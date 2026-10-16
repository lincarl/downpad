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
// would read.
//
// A paragraph that is only `$$...$$` is display math on GitHub, in VS Code and
// in Obsidian. remark-math reads it as inline math, which was saved as `$...$`.

import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { customInputRulesKey } from "@milkdown/kit/prose";
import { type EditorState, Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { Node as ProseNode, ResolvedPos } from "@milkdown/kit/prose/model";
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
 *  math block. */
function pandocMathWriter(write: Handle): Handle {
  return (node: { value?: string }, parent, state, info) => {
    const value = trimMath(node.value ?? "");
    if (!value) return "";
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

/** Reads and writes single-dollar math by Pandoc's rules. Must follow Crepe's
 *  remark-math plugin, because micromark tries the syntax added last first, and
 *  this wraps remark-math's writer. */
export const pandocInlineMath = $remark("mdEasyPandocInlineMath", () =>
  /** Adds the reader, wraps remark-math's writer and escapes every `$` in
   *  text. */
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
    // remark-math escapes a `$` in text through a pattern with an `after` key,
    // which mdast-util-to-markdown reads as a condition. It then left the `$`
    // unescaped before a character it always escapes, so `\$_GET` was saved
    // as `$\_GET`, and two of them read as a formula. This pattern has no
    // condition, so a `$` in text is always escaped.
    const unsafe: StringifyExtension["unsafe"] = [{ character: "$", inConstruct: "phrasing" }];
    extensions.push({ handlers: ours, unsafe });
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
  // Crepe's math shortcut opens at the nearest `$`. An opening mark is not
  // escaped and has no space after it.
  const open = rest.lastIndexOf("$");
  return open < 0 || escapes(rest.slice(0, open)) || /^\s/.test(rest.slice(open + 1));
}

/** What typing `text` at `from` does with a closing `$` or `~`. "text" keeps it
 *  as text, "wait" decides once the next character is known, and undefined
 *  leaves the typing shortcuts to run. */
function closingMark(state: EditorState, from: number, text: string): "text" | "wait" | undefined {
  const $from = state.doc.resolve(from);
  if ($from.parent.type.spec.code) return undefined;
  const before = textBefore($from) + text;
  const mark = before.slice(-1);
  if (mark !== "$" && mark !== "~") return undefined;
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
 *  as backticks and other inline nodes as U+FFFC. */
function plainText(block: ProseNode): string {
  let text = "";
  block.forEach((child) => {
    if (!child.isText) text += "￼";
    else if (child.marks.some((mark) => mark.type.spec.code)) text += "`".repeat(child.nodeSize);
    else text += child.text ?? "";
  });
  return text;
}

/** GFM's class of the character next to a run of tildes: a space, which the
 *  start and end of the paragraph count as, punctuation, or neither. */
function classOf(character: string): "space" | "punctuation" | undefined {
  if (character === "" || /\s/.test(character)) return "space";
  return /[\p{P}\p{S}]/u.test(character) ? "punctuation" : undefined;
}

/** Where strikethrough opens that the run of tildes at the end of `text` closes
 *  when `next` follows, or -1. GFM pairs the runs from the start of the
 *  paragraph. Each run of one or two that can close takes the nearest open run
 *  of its length, and the runs between them can no longer open. A run with a
 *  space after it cannot open, nor one before punctuation unless a space or
 *  punctuation comes before it, and the reverse holds for closing. */
function strikeOpening(text: string, next: string): number {
  const open: { index: number; size: number }[] = [];
  for (const run of text.matchAll(/~+/g)) {
    // A backslash makes the first `~` text.
    const escaped = escapes(text.slice(0, run.index)) ? 1 : 0;
    const index = run.index + escaped;
    const size = run[0].length - escaped;
    const last = index + size === text.length;
    const before = classOf(text.charAt(index - 1));
    const after = classOf(last ? next : text.charAt(index + size));
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
    if (!after || (after === "punctuation" && before)) open.push({ index, size });
  }
  return -1;
}

/** Strike the text that the run of tildes ending at `end` closes, when `next`
 *  follows it, and report whether it did. Milkdown's shortcut paired the run
 *  with the first `~` that fits instead of the one GFM pairs it with. */
function strike(view: EditorView, end: number, next: string): boolean {
  const { state } = view;
  const strikethrough = state.schema.marks.strike_through;
  const $end = state.doc.resolve(end);
  const text = plainText($end.parent).slice(0, $end.parentOffset);
  const index = strikeOpening(text, next);
  if (!strikethrough || index < 0) return false;
  const size = text.length - text.replace(/~+$/, "").length;
  const open = $end.start() + index;
  const close = end - size;
  const tr = state.tr.delete(close, end).delete(open, open + size);
  tr.addMark(open, close - size, strikethrough.create());
  // Text typed next continues with the marks around it, but not struck.
  tr.setStoredMarks(strikethrough.removeFromSet(state.storedMarks ?? tr.doc.resolve(close - size).marks()));
  view.dispatch(tr);
  return true;
}

/** Run the typing shortcuts for the `$` at `pos` as if it were typed now, and
 *  report whether one ran. */
function runShortcuts(view: EditorView, pos: number): boolean {
  const rules = customInputRulesKey.get(view.state);
  const insert = () => view.state.tr.insertText("$", pos, pos + 1);
  return rules?.props.handleTextInput?.call(rules, view, pos, pos + 1, "$", insert) === true;
}

/** Close math or strikethrough with the waiting `$` or `~` at `pos` where
 *  `next`, the character after it or "" at the end of the paragraph, lets it,
 *  and report whether it did. In Pandoc a `$` closes unless a digit follows.
 *  In GFM another `~` makes the run longer, and that one decides. */
function closeWaiting(view: EditorView, pos: number, next: string): boolean {
  if (view.state.doc.textBetween(pos, pos + 1) === "$") return !/^\d/.test(next) && runShortcuts(view, pos);
  return !next.startsWith("~") && strike(view, pos + 1, next);
}

/** Type `text` over the selection through the editor's typing hooks, as the
 *  browser does. */
function typeText(view: EditorView, text: string): void {
  const { from, to } = view.state.selection;
  const insert = () => view.state.tr.insertText(text, from, to);
  if (!view.someProp("handleTextInput", (handle) => handle(view, from, to, text, insert))) view.dispatch(insert());
}

/** The position of a typed closing `$` or `~` that waits for the next
 *  character, or null. */
const waitingKey = new PluginKey<number | null>("mdEasyWaitingMark");

/** Let a `$` or `~` that a composition put right before the cursor wait like a
 *  typed one. */
function waitAfterComposition(view: EditorView): void {
  if (view.isDestroyed) return;
  const { $from, empty } = view.state.selection;
  if (!empty || $from.parentOffset === 0) return;
  const mark = $from.parent.textBetween($from.parentOffset - 1, $from.parentOffset, undefined, "￼");
  if (closingMark(view.state, $from.pos - 1, mark) === "wait") {
    view.dispatch(view.state.tr.setMeta(waitingKey, $from.pos - 1));
  }
}

/** Makes a typed `$` or `~` close math or strikethrough only where Markdown
 *  would read the same text that way. One that never could, such as after a
 *  space, stays text. One that could waits for the next character, since a `$`
 *  right before a digit, or a `~` after punctuation and before a letter, closes
 *  nothing. The next character typed, Enter, or moving the cursor away decides.
 *  Crepe's and Milkdown's typing shortcuts decided at once, and Milkdown's
 *  could strike from a different `~` than GFM. */
export const closingDelimiterGuard = $prose(
  () =>
    new Plugin<number | null>({
      key: waitingKey,
      state: {
        init: () => null,
        /** Keep the waiting mark until the document or the selection changes. */
        apply(tr, waiting, before, after) {
          const set: number | undefined = tr.getMeta(waitingKey);
          if (set !== undefined) return set;
          return tr.docChanged || !after.selection.eq(before.selection) ? null : waiting;
        },
      },
      props: {
        // Prose plugins handle typed text before the shortcuts, so they never
        // see it.
        handleTextInput(view, from, to, text, deflt) {
          const waiting = waitingKey.getState(view.state);
          if (waiting === from - 1 && from === to && closeWaiting(view, waiting, text)) {
            typeText(view, text);
            return true;
          }
          const decision = closingMark(view.state, from, text);
          if (!decision) return false;
          const tr = deflt();
          view.dispatch(decision === "wait" ? tr.setMeta(waitingKey, from + text.length - 1) : tr);
          return true;
        },
        // A line break after the mark ends its paragraph or line, so it closes.
        handleKeyDown(view, event) {
          const waiting = waitingKey.getState(view.state);
          const { empty, from } = view.state.selection;
          if (event.key === "Enter" && waiting === from - 1 && empty) closeWaiting(view, waiting, "\n");
          return false;
        },
        handleDOMEvents: {
          // Milkdown runs the shortcuts in a timeout once a composition ends,
          // such as a dead-key `~`. This timeout is set first, so it runs first.
          compositionend(view) {
            setTimeout(() => waitAfterComposition(view));
            return false;
          },
        },
      },
      view: () => ({
        /** Decide a waiting mark by the character after it once the cursor
         *  leaves it. */
        update(view, previous) {
          const waiting = waitingKey.getState(previous);
          if (waiting == null || waitingKey.getState(view.state) != null || view.state.doc !== previous.doc) return;
          if (!closeWaiting(view, waiting, characterAt(view.state, waiting + 1))) return;
          // Backspace undoes the last shortcut until the selection is next set,
          // which must not happen away from where it ran.
          view.dispatch(view.state.tr.setSelection(view.state.selection));
        },
      }),
      // Milkdown also runs the shortcuts when a composition ends, with no text
      // and the character already typed. A closing mark then stays text or
      // waits, as when it is typed.
      filterTransaction(tr, state) {
        const input: { from: number; text: string } | undefined = tr.getMeta(customInputRulesKey);
        if (!input) return true;
        const decision = closingMark(state, input.from, input.text);
        return input.text ? decision !== "text" : !decision;
      },
    }),
);

/** All three, for `editor.use` after Crepe's features. */
export const mathDelimiters: MilkdownPlugin[] = [oneLineDisplayMath, pandocInlineMath, closingDelimiterGuard].flat();
