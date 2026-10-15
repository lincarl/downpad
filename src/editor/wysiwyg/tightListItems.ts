// Tight new list items. Milkdown gives a list item it creates `spread: true`, so
// an item started by typing "- " or "1. ", or from the slash menu, was loose, and
// so was every item Enter made from it. Once Tab gave such an item a nested
// list, Milkdown wrote a blank line between the item's text and that list
// ("- A\n\n  - B"), which makes the whole list loose in other Markdown viewers.
//
// Items read from Markdown or pasted keep the spread their source had, and Enter
// copies it from the item it splits, so a loose list stays loose.

import { extendListItemSchemaForTask } from "@milkdown/kit/preset/gfm";

/** Crepe's list item schema (GFM's, with task items) with tight new items. Use
 *  it after Crepe's presets so it replaces the original node spec in place. */
export const tightListItemSchema = extendListItemSchemaForTask.extendSchema((prev) => (ctx) => {
  const schema = prev(ctx);
  return { ...schema, attrs: { ...schema.attrs, spread: { ...schema.attrs?.spread, default: false } } };
});
