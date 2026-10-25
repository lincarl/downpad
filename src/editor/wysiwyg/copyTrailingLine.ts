// Copies without Crepe's empty last line. Crepe keeps an empty paragraph after a
// final list, code block, quote, table, rule or image so there is a line to type
// on. Milkdown leaves an empty last paragraph out of the Markdown, including the
// plain text of a copy, but the HTML of a copy kept it as `<p></p>`. Pasting a
// copy of the whole document into Downpad therefore added an empty paragraph,
// saved as a `<br />` line, and other apps that read the HTML can show it as an
// extra empty line.
//
// Only that last line of the document is left out, and only where Crepe adds
// one. A copy that ends at the start of any other line, such as a whole line
// selected with Shift+Down, ends in an empty paragraph too, but there it carries
// the copied line break. So does an empty last line the user typed after a
// paragraph or heading, where Crepe adds none.

import { trailingConfig } from "@milkdown/kit/plugin/trailing";
import { Slice } from "@milkdown/kit/prose/model";
import { Plugin } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

/** Leaves the document's empty last paragraph out of a copied or dragged slice
 *  that reaches it, when other blocks precede it in the slice and the block
 *  before it is one Crepe adds a line to type on after. */
export const copyWithoutTrailingLine = $prose(
  (ctx) =>
    new Plugin({
      props: {
        transformCopied: (slice, view) => {
          const { state } = view;
          const { doc, selection } = state;
          const { content } = slice;
          const last = content.lastChild;
          // Positions from here on are inside the document's last block or after it.
          const reachesLastBlock = selection.to >= doc.content.size - 1;
          if (!reachesLastBlock || content.childCount < 2 || last?.type.name !== "paragraph" || last.content.size > 0) {
            return slice;
          }
          // Crepe's own rule for where it adds the line.
          const before = doc.maybeChild(doc.childCount - 2);
          if (!ctx.get(trailingConfig.key).shouldAppend(before, state)) return slice;
          return new Slice(content.cut(0, content.size - last.nodeSize), slice.openStart, 0);
        },
      },
    }),
);
