// Maps the user's markdown serialization preferences (spec §5.16) onto
// remark-stringify options, which is what Milkdown uses to serialize the
// WYSIWYG document back to markdown.

import type { SerializerStyle } from "../../state/types";

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
