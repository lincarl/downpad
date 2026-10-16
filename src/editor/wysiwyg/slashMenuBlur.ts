// Crepe's slash menu reads Enter and the arrow keys from the whole window while
// it is open. Besides Esc and a picked block, only a change to the document or
// its selection closes it. A click that moved focus out of the document, onto
// the toolbar or the split's Markdown pane, left it open over keys meant for
// there. This closes it when the document editor loses focus to anything but
// the menu. Crepe keeps focus in the editor on a click in the menu, so a click
// still picks a block.

import { rootDOMCtx } from "@milkdown/kit/core";
import { Plugin } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

/** The part of Crepe's slash menu API used here. Crepe keeps the API in a
 *  context slice that it does not export, so this reads it by name. */
type SlashMenuAPI = { hide: () => void };

/** Milkdown plugin that closes the slash menu when focus leaves the document. */
export const slashMenuBlur = $prose(
  (ctx) =>
    new Plugin({
      props: {
        handleDOMEvents: {
          /** Close an open menu unless focus went into it, or only the window
           *  lost focus. The editor stays the active element then, and takes
           *  focus back with the window. */
          blur: (view, event) => {
            const menu = ctx.get(rootDOMCtx).querySelector('.milkdown-slash-menu[data-show="true"]');
            const to = event.relatedTarget;
            if (menu && !view.hasFocus() && !(to instanceof Node && menu.contains(to))) {
              ctx.get<SlashMenuAPI, "menuAPICtx">("menuAPICtx").hide();
            }
            return false;
          },
        },
      },
    }),
);
