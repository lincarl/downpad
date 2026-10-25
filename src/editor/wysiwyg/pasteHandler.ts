// Smart-paste integration for the WYSIWYG view (spec §5.4). A ProseMirror plugin
// (added to Crepe's underlying Milkdown editor via `$prose`) intercepts paste and
// routes it through the shared paste pipeline:
//   image    → hand to the app, which stores it and puts it in (below)
//   markdown → insert parsed markdown (HTML is converted to markdown first)
//   text     → fall through to ProseMirror's default plain-text paste
//
// Insertion uses Milkdown's `insert` macro, which parses markdown with the
// editor's own parser (so GFM tables, image-block, etc. all apply).
//
// Crepe's own paste plugins come first. Milkdown's clipboard plugin takes a
// paste with HTML or plain text. An image alone on the clipboard, such as a
// screenshot, would go to Crepe's upload plugin, which stores it through the
// image config's onUpload (imageView.ts) and puts it into this editor once it
// is stored. By then the editor can be rebuilt or gone, which loses the image.
// It can also be hidden behind the Markdown view, where an edit before the
// editor reports the image loses it too. The upload plugin also puts in an
// empty image when the save that an untitled document needs is cancelled. So this
// plugin takes such a paste first, in a DOM event handler, which ProseMirror
// runs before any plugin's handlePaste, and hands its images to the app
// (`WysiwygContext.pasteImages`). The app puts them in as the files of a drop
// at the caret (FileDropCoordinator.pasteImages, §5.5).

import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { insert } from "@milkdown/kit/utils";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Ctx } from "@milkdown/kit/ctx";
import { resolvePaste, snapshotFromDataTransfer } from "../../paste/pastePipeline";
import type { WysiwygContext } from "./context";

export const smartPasteKey = new PluginKey("downpad-smart-paste");

/** A clipboard payload that is a single http(s) URL (no surrounding text). */
function isSingleUrl(text: string): boolean {
  return /^https?:\/\/\S+$/.test(text);
}

/**
 * Spec §5.6: pasting a URL over a non-empty selection wraps the selection in a
 * link (selection stays as the link text). Returns true if it handled the paste.
 */
function tryLinkOverSelection(view: EditorView, text: string): boolean {
  const sel = view.state.selection;
  const linkType = view.state.schema.marks.link;
  if (sel.empty || !linkType || !isSingleUrl(text.trim())) return false;
  const tr = view.state.tr.addMark(sel.from, sel.to, linkType.create({ href: text.trim() }));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** The image files of a paste that Crepe's upload plugin would take, one
 *  whose clipboard holds neither HTML nor plain text, which Milkdown's
 *  clipboard plugin takes first. */
function imagesPastedAlone(clipboard: DataTransfer): File[] {
  if (clipboard.getData("text/html") || clipboard.getData("text/plain")) return [];
  return Array.from(clipboard.files).filter((file) => file.type.startsWith("image/"));
}

/** A `$prose` plugin wiring smart paste into the editor. */
export function smartPastePlugin(wctx: WysiwygContext) {
  return $prose(
    (mctx: Ctx) =>
      new Plugin({
        key: smartPasteKey,
        props: {
          handleDOMEvents: {
            // An editor the app gives no `pasteImages`, such as the one
            // print renders with, takes no user input and puts nothing in.
            paste: (view: EditorView, event: ClipboardEvent): boolean => {
              const images = event.clipboardData && view.editable ? imagesPastedAlone(event.clipboardData) : [];
              if (images.length === 0) return false;
              event.preventDefault();
              wctx.pasteImages?.(images);
              return true;
            },
          },
          handlePaste: (view: EditorView, event: ClipboardEvent): boolean => {
            const dt = event.clipboardData;
            if (!dt) return false;
            const action = resolvePaste(snapshotFromDataTransfer(dt));
            switch (action.kind) {
              case "image":
                event.preventDefault();
                wctx.pasteImages?.([action.file]);
                return true;
              case "markdown":
                event.preventDefault();
                insert(action.md)(mctx);
                return true;
              default:
                // text / empty: a URL pasted over a selection becomes a link
                // (§5.6); otherwise let ProseMirror handle plain-text paste.
                if (tryLinkOverSelection(view, dt.getData("text/plain") || "")) {
                  event.preventDefault();
                  return true;
                }
                return false;
            }
          },
        },
      }),
  );
}
