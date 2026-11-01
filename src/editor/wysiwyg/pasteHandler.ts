// Smart-paste integration for the WYSIWYG view (spec §5.4). A ProseMirror plugin
// (added to Crepe's underlying Milkdown editor via `$prose`) intercepts paste and
// routes it through the shared paste pipeline:
//   image    → hand to the app, which stores it and puts it in (below)
//   markdown → splice into Markdown source before rendering it
//   text     → fall through to ProseMirror's default plain-text paste
//   URL over selected text → link the text (§5.6)
//
// Plain Markdown is inserted through the source callback. Rich HTML follows
// Milkdown's existing paste path, with its `insert` macro as a fallback.
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
import { parserCtx } from "@milkdown/kit/core";
import { Plugin, PluginKey, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import { closeHistory } from "@milkdown/kit/prose/history";
import { CellSelection } from "@milkdown/kit/prose/tables";
import { insert } from "@milkdown/kit/utils";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Ctx } from "@milkdown/kit/ctx";
import { resolvePaste, snapshotFromDataTransfer } from "../../paste/pastePipeline";
import { looksLikeMarkdown } from "../../paste/markdownHeuristic";
import { normalizeToLf } from "../../document/lineEndings";
import { pasteMarkdownCells } from "./markdownPaste";
import type { WysiwygContext } from "./context";

export const smartPasteKey = new PluginKey("downpad-smart-paste");

/** A clipboard payload that is a single http(s) URL (no surrounding text). */
function isSingleUrl(text: string): boolean {
  return /^https?:\/\/\S+$/.test(text);
}

/** Dispatch a paste's transaction as one undo step of its own. */
function dispatchPaste(view: EditorView, tr: Transaction): void {
  view.dispatch(closeHistory(tr).setMeta("paste", true).setMeta("uiEvent", "paste").scrollIntoView());
  view.dispatch(closeHistory(view.state.tr));
}

/**
 * Spec §5.6: pasting a URL over selected text links the text, which stays
 * selected. Returns true if it handled the paste. It runs from the DOM paste
 * handler, because Milkdown's clipboard plugin would otherwise replace the
 * text with the URL as an autolink.
 */
function tryLinkOverSelection(view: EditorView, text: string): boolean {
  const sel = view.state.selection;
  const linkType = view.state.schema.marks.link;
  const url = text.trim();
  if (!(sel instanceof TextSelection) || sel.empty || !linkType || !isSingleUrl(url)) return false;
  dispatchPaste(view, view.state.tr.addMark(sel.from, sel.to, linkType.create({ href: url })));
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
export function smartPastePlugin(wctx: WysiwygContext, pasteMarkdown: (markdown: string) => boolean) {
  return $prose(
    (mctx: Ctx) =>
      new Plugin({
        key: smartPasteKey,
        props: {
          handleDOMEvents: {
            // An editor the app gives no `pasteImages`, such as the one
            // print renders with, takes no user input and puts nothing in.
            paste: (view: EditorView, event: ClipboardEvent): boolean => {
              const clipboard = event.clipboardData;
              if (!clipboard || !view.editable) return false;
              const images = imagesPastedAlone(clipboard);
              if (images.length) {
                event.preventDefault();
                wctx.pasteImages?.(images);
                return true;
              }
              // Crepe consumes text before handlePaste reaches this plugin.
              // Take Markdown here, including highlighted HTML or an image
              // copied with it, and a URL pasted over selected text.
              // A code block's own editor keeps every paste literal.
              const { selection, storedMarks } = view.state;
              if (selection.$from.parent.type.spec.code) return false;
              const text = clipboard.getData("text/plain");
              const marks = storedMarks ?? (selection.empty ? selection.$from.marks() : selection.$from.marksAcross(selection.$to));
              if (text && marks?.some((mark) => mark.type.spec.code)) {
                // The serializer chooses enough backticks to keep code literal.
                // Splicing into its source would let a pasted backtick close it.
                event.preventDefault();
                dispatchPaste(view, view.state.tr.insertText(normalizeToLf(text)));
                return true;
              }
              if (tryLinkOverSelection(view, text)) {
                event.preventDefault();
                return true;
              }
              if (!looksLikeMarkdown(text)) return false;
              const action = resolvePaste(snapshotFromDataTransfer(clipboard));
              if (action.kind !== "markdown") return false;
              if (selection instanceof CellSelection) {
                // A rectangle is not a source range. Keep the table's paste
                // fitting so its unselected cells stay in the same table.
                const parsed = mctx.get(parserCtx)(normalizeToLf(action.md));
                if (!parsed) return false;
                if (!pasteMarkdownCells(view, parsed)) return false;
              } else if (!pasteMarkdown(action.md)) return false;
              event.preventDefault();
              return true;
            },
          },
          // Milkdown's clipboard plugin leaves this a paste it does not
          // take, such as one with the selection starting in a code block.
          // ProseMirror's own paste keeps text in code literal.
          handlePaste: (view: EditorView, event: ClipboardEvent): boolean => {
            const dt = event.clipboardData;
            if (!dt || view.state.selection.$from.parent.type.spec.code) return false;
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
                // text / empty: let ProseMirror handle plain-text paste.
                return false;
            }
          },
        },
      }),
  );
}
