// Crepe's selection toolbar decides whether to show only when the document
// view updates, and a move of focus is no update. After text was selected in
// the document and a click moved focus to the split's Markdown pane, the
// toolbar stayed over the document, covered the text under it and took
// clicks. A click on it formatted the document's selection while the next key
// went to the Markdown pane. This hides the toolbar when the document view
// loses focus to anything but the toolbar. Crepe shows it again once the
// selection changes while the view has focus, so it stays hidden when focus
// comes back without a change, such as after Esc in the find card. Crepe
// keeps focus in the view on a click in the toolbar, so a click there still
// formats the text.

import { rootDOMCtx } from "@milkdown/kit/core";
import { Plugin } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

/** Milkdown plugin that hides the selection toolbar when focus leaves the
 *  document view (see the header). */
export const toolbarBlur = $prose(
  (ctx) =>
    new Plugin({
      props: {
        handleDOMEvents: {
          /** Hide a shown toolbar unless focus went into it, or only the
           *  window lost focus. The view stays the active element then, and
           *  takes focus back with the window. */
          blur: (view, event) => {
            const toolbar = ctx.get(rootDOMCtx).querySelector<HTMLElement>('.milkdown-toolbar[data-show="true"]');
            const to = event.relatedTarget;
            if (toolbar && !view.hasFocus() && !(to instanceof Node && toolbar.contains(to))) toolbar.dataset.show = "false";
            return false;
          },
        },
      },
    }),
);
