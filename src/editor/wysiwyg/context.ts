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
}
