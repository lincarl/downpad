// Smart-paste integration for the WYSIWYG view (spec §5.4). A ProseMirror plugin
// (added to Crepe's underlying Milkdown editor via `$prose`) intercepts paste and
// routes it through the shared paste pipeline:
//   image    → store (base64 / attachment) and insert `![](src)`
//   markdown → insert parsed markdown (HTML is converted to markdown first)
//   text     → fall through to ProseMirror's default plain-text paste
//
// Insertion uses Milkdown's `insert` macro, which parses markdown with the
// editor's own parser (so GFM tables, image-block, etc. all apply).

import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { insert } from "@milkdown/kit/utils";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Ctx } from "@milkdown/kit/ctx";
import { resolvePaste, snapshotFromDataTransfer } from "../../paste/pastePipeline";
import { resolveImageSrc } from "../../images/imageStore";
import type { WysiwygContext } from "./context";

export const smartPasteKey = new PluginKey("md-easy-smart-paste");

/** Markdown for an image embed; alt is left empty for pasted/dropped images. */
function imageMarkdown(src: string): string {
  return `![](${src})`;
}

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

async function handleImagePaste(mctx: Ctx, wctx: WysiwygContext, file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const src = await resolveImageSrc(bytes, file.type || "image/png", wctx);
  if (src) insert(imageMarkdown(src))(mctx);
}

/** A `$prose` plugin wiring smart paste into the editor. */
export function smartPastePlugin(wctx: WysiwygContext) {
  return $prose(
    (mctx: Ctx) =>
      new Plugin({
        key: smartPasteKey,
        props: {
          handlePaste: (view: EditorView, event: ClipboardEvent): boolean => {
            const dt = event.clipboardData;
            if (!dt) return false;
            const action = resolvePaste(snapshotFromDataTransfer(dt));
            switch (action.kind) {
              case "image":
                event.preventDefault();
                void handleImagePaste(mctx, wctx, action.file);
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
