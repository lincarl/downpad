// Copies without Crepe's empty last line. Crepe keeps an empty paragraph after a
// final list, code block, quote, table, rule or image so there is a line to type
// on. Milkdown leaves an empty last paragraph out of the Markdown, including the
// plain text of a copy, but the HTML of a copy kept it as `<p></p>`. Pasting a
// copy of the whole document into md-easy therefore added an empty paragraph,
// saved as a `<br />` line, and other apps that read the HTML can show it as an
// extra empty line.

import { Slice } from "@milkdown/kit/prose/model";
import { Plugin } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

/** Leaves an empty last paragraph out of a copied or dragged slice when other
 *  blocks precede it, as Milkdown does for the slice's plain text. */
export const copyWithoutTrailingLine = $prose(
  () =>
    new Plugin({
      props: {
        transformCopied: (slice) => {
          const { content } = slice;
          const last = content.lastChild;
          if (content.childCount < 2 || last?.type.name !== "paragraph" || last.content.size > 0) return slice;
          return new Slice(content.cut(0, content.size - last.nodeSize), slice.openStart, 0);
        },
      },
    }),
);
