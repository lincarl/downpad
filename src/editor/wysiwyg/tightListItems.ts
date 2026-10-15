// Tight new list items. Milkdown gives a list item it creates `spread: true`, so
// an item started by typing "- " or "1. ", or from the slash menu, was loose, and
// so was every item Enter made from it. Once Tab gave such an item a nested
// list, Milkdown wrote a blank line between the item's text and that list
// ("- A\n\n  - B"), which makes the whole list loose in other Markdown viewers.
//
// A list read from a file keeps its own spread, which decides the blank lines
// between its items, so a loose list stays loose. Items keep theirs too, and
// Enter copies the spread of the item it splits.
//
// remark-stringify writes the blocks of a tight item one line apart. Some pairs
// of blocks then read back as something else, for example text followed by a
// rule reads as a heading. `looseWhenNeeded` writes such an item as a loose one,
// which is how a reader takes it anyway.

import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import type { Ctx, SliceType } from "@milkdown/kit/ctx";
import { extendListItemSchemaForTask } from "@milkdown/kit/preset/gfm";

/** remark-stringify options, as Milkdown's options slice declares them. */
type StringifyOptions = typeof remarkStringifyOptionsCtx extends SliceType<infer T> ? T : never;
/** A remark-stringify rule for the line breaks between two blocks. */
type Join = NonNullable<StringifyOptions["join"]>[number];
type Block = Parameters<Join>[0];

/** Crepe's list item schema (GFM's, with task items) with tight new items. Use
 *  it after Crepe's presets so it replaces the original node spec in place. */
export const tightListItemSchema = extendListItemSchemaForTask.extendSchema((prev) => (ctx) => {
  const schema = prev(ctx);
  return { ...schema, attrs: { ...schema.attrs, spread: { ...schema.attrs?.spread, default: false } } };
});

/** Blocks that a following line of text would continue. A quote or list takes
 *  the line into its last paragraph, and a table takes it as a new row. */
const CONTINUED = new Set(["blockquote", "list", "table"]);

/** Whether `right` needs a blank line after `left` to keep its meaning. */
function needsBlankLine(left: Block, right: Block): boolean {
  if (left.type === "paragraph") {
    // A lone HTML tag, such as the `<br />` of an empty line, starts an HTML
    // block that runs to the next blank line.
    if (left.children.length === 1 && left.children[0].type === "html") return true;
    // Two paragraphs need one to stay apart, "---" under text makes the text a
    // heading, and only a numbered list that starts at 1 can begin right after text.
    if (right.type === "paragraph" || right.type === "thematicBreak") return true;
    return right.type === "list" && !!right.ordered && (right.start ?? 1) !== 1;
  }
  // Text or a table would continue a quote, list or table right above it, and a
  // quote right after a quote would join it.
  if (!CONTINUED.has(left.type)) return false;
  return right.type === "paragraph" || right.type === "table" || (right.type === "blockquote" && left.type === "blockquote");
}

/** Writes a tight list item with blank lines between its blocks when two of
 *  them need one. Other joins are left to remark-stringify. */
const looseWhenNeeded: Join = (_left, _right, parent) => {
  if (parent.type !== "listItem" || parent.spread) return undefined;
  const { children } = parent;
  return children.some((child, index) => index > 0 && needsBlankLine(children[index - 1], child)) ? 1 : undefined;
};

/** Adds `looseWhenNeeded` to Milkdown's remark-stringify options. Pass it to
 *  `editor.config`. */
export function tightListItemJoin(ctx: Ctx): void {
  ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, join: [...(prev.join ?? []), looseWhenNeeded] }));
}
