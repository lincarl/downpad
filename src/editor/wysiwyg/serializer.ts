// Maps the user's markdown serialization preferences (spec §5.16) onto
// remark-stringify options, which is what Milkdown uses to serialize the
// WYSIWYG document back to markdown.

import type { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import type { SliceType } from "@milkdown/kit/ctx";
import type { SerializerStyle } from "../../state/types";

/** remark-stringify options, as Milkdown's options slice declares them. */
type StringifyOptions = typeof remarkStringifyOptionsCtx extends SliceType<infer T> ? T : never;
type TextHandler = NonNullable<NonNullable<StringifyOptions["handlers"]>["text"]>;

/** remark-stringify (mdast-util-to-markdown) options we control. */
export interface RemarkStringifyOptions {
  bullet: "-" | "*" | "+";
  emphasis: "*" | "_";
  strong: "*" | "_";
  rule: "-" | "*" | "_";
  setext: boolean;
  fences: boolean;
  listItemIndent: "one";
}

export function toRemarkStringifyOptions(style: SerializerStyle): RemarkStringifyOptions {
  return {
    bullet: style.bullet,
    emphasis: style.emphasis,
    // remark expresses strong as a single repeated marker char: "**" -> "*".
    strong: style.strong === "__" ? "_" : "*",
    rule: "-",
    setext: style.headingStyle === "setext",
    // Always use fenced code blocks and keep them tidy.
    fences: true,
    listItemIndent: "one",
  };
  // Note: mdHardWrap (a wrap column) is not applied here — mdast-util-to-markdown
  // does not wrap prose. The default (no wrap) matches the spec default; a
  // numeric wrap column would need a dedicated remark plugin (future work).
}

/**
 * Escapes text as remark-stringify does, but writes the spaces and tabs at its
 * end as plain characters, so a space just typed is not saved as `&#x20;`. At
 * the end of a line it writes only the first of them. Milkdown's own text
 * handler keeps them by skipping all escaping for text that ends in a space and
 * has no `*`, `_` or `\`, so it saved `&amp;copy; **b**` as `&copy; **b**`, read
 * back as `© b`.
 */
const escapeText: TextHandler = (node: { value: string }, _parent, state, info) => {
  const body = node.value.replace(/[ \t]+$/, "");
  const trailing = node.value.slice(body.length);
  if (!/^[\r\n]/.test(info.after)) {
    return state.safe(body, { ...info, after: trailing.charAt(0) || info.after }) + trailing;
  }
  // A reader drops spaces at the end of a line, so the text before them is
  // escaped as the end of the line, or a ` #` there would close a heading. Only
  // the first space or tab is kept, because two spaces make a hard line break.
  return state.safe(body, info) + trailing.slice(0, 1);
};

/** Milkdown's remark-stringify options with the user's style and Downpad's
 *  text escaping. */
export function stringifyOptions(prev: StringifyOptions, style: SerializerStyle): StringifyOptions {
  return {
    ...prev,
    ...toRemarkStringifyOptions(style),
    handlers: { ...prev.handlers, text: escapeText },
  };
}
