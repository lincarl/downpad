// Everything the WYSIWYG editor's custom plugins need from the rest of the app,
// passed in at mount time so the editor stays decoupled from the Store. Grows
// across milestones (link display in M4 Chunk B, spellcheck in M5).

import type { ImageStoreContext } from "../../images/imageStore";

export interface WysiwygContext extends ImageStoreContext {
  /**
   * Open a local markdown file in a tab — used when the user double-clicks a
   * relative/absolute `.md` link in the WYSIWYG view (spec §5.6). Optional: a
   * transient editor (e.g. the off-screen print render) never receives a
   * double-click and is built from a plain ImageStoreContext, so it omits this.
   */
  openMarkdownFile?(absPath: string): void;
  /**
   * Put images pasted into the document in at the caret, as files dropped
   * away from the text go in (§5.4, §5.5). The app stores each image and puts
   * it into the document's view shown by then, which may no longer be this
   * editor. Call it while handling the paste event. Optional for the same
   * reason as `openMarkdownFile`. Without it, a pasted image puts nothing in.
   */
  pasteImages?(files: File[]): void;
}
