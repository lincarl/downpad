// Live find count (§5.13). The find card learns its count from the commands it
// runs, but typing, undo and a split mirror sync also add and remove matches
// while it is open. The find plugin searches again after every edit; this
// plugin then tells the card to read the new count.

import { $prose } from "@milkdown/kit/utils";
import { Plugin } from "@milkdown/kit/prose/state";
import { findKey } from "./findEngine";

/** Milkdown plugin that calls `onChange` after each edit to the document while
 *  a find query is set. It runs once the find plugin has searched the edited
 *  document, so `matchCounts` already includes the edit. */
export function findChangeListener(onChange: () => void) {
  return $prose(
    () =>
      new Plugin({
        view: () => ({
          update(view, prevState) {
            if (view.state.doc !== prevState.doc && findKey.getState(view.state)?.query) onChange();
          },
        }),
      }),
  );
}
