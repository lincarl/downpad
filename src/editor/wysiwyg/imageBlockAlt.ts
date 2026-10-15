// Alt text for standalone images. Crepe's image block reuses the Markdown alt
// slot for its resize ratio. It reads `![Diagram](notes.png)` as ratio 1 and
// writes it back as `![1.00](notes.png)`, so any edit and save replaced the alt
// text with a number. This schema gives the block a real `alt` attribute that
// round-trips unchanged. The title stays the block's caption, as in Crepe.
//
// The resize ratio becomes a display setting for the open editor. Plain Markdown
// has no place to store it, so it is not saved and a reopened image starts at its
// fitted size.
//
// Crepe's image view also fills the <img> alt from the caption, so a screen reader
// announced the caption, or nothing for an image without one. `imageBlockAltView`
// puts the alt text there instead.

import { imageBlockSchema } from "@milkdown/kit/component/image-block";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

/** Crepe's image-block schema with the Markdown alt text kept in `alt`. Use it
 *  after Crepe's ImageBlock feature so it replaces the original node spec. */
export const imageBlockAltSchema = imageBlockSchema.extendSchema((prev) => (ctx) => {
  const schema = prev(ctx);
  return {
    ...schema,
    attrs: { ...schema.attrs, alt: { default: "", validate: "string" } },
    // Copy and paste inside the editor goes through the DOM, where toDOM already
    // writes every attribute onto the <img>.
    parseDOM: schema.parseDOM?.map((rule) => ({
      ...rule,
      getAttrs: (dom: HTMLElement) => {
        const attrs = rule.getAttrs ? rule.getAttrs(dom) : null;
        return attrs === false ? false : { ...attrs, alt: dom.getAttribute("alt") ?? "" };
      },
    })),
    parseMarkdown: {
      match: schema.parseMarkdown.match,
      runner: (state, node, type) => {
        state.addNode(type, {
          src: (node.url as string | undefined) ?? "",
          caption: (node.title as string | null | undefined) ?? "",
          alt: (node.alt as string | null | undefined) ?? "",
        });
      },
    },
    toMarkdown: {
      match: schema.toMarkdown.match,
      runner: (state, node) => {
        state.openNode("paragraph");
        state.addNode("image", undefined, undefined, {
          title: node.attrs.caption,
          url: node.attrs.src,
          alt: node.attrs.alt,
        });
        state.closeNode();
      },
    },
  };
});

/** What a screen reader should hear for a standalone image: its alt text, or
 *  its caption when it has none. */
function spokenText(node: ProseNode): string {
  return (node.attrs.alt as string) || (node.attrs.caption as string);
}

/** Write each standalone image's spoken text onto its rendered <img>. */
function labelImages(view: EditorView): void {
  view.state.doc.descendants((node, pos) => {
    // Image blocks sit between blocks, never inside paragraph text.
    if (node.type.name !== "image-block") return !node.isTextblock;
    const img = (view.nodeDOM(pos) as HTMLElement | null)?.querySelector("img");
    const text = spokenText(node);
    if (img && img.getAttribute("alt") !== text) img.setAttribute("alt", text);
    return false;
  });
}

const holdsImage = (node: Node): boolean =>
  node instanceof Element && (node.tagName === "IMG" || node.querySelector("img") !== null);

/** Gives standalone images their alt text in the editor, where screen readers
 *  read it. Crepe's image view sets `alt` to the caption, again whenever the
 *  caption changes, and draws a new <img> once an empty image gets a source, so
 *  the plugin relabels on each of those and after every document change. */
export const imageBlockAltView = $prose(
  () =>
    new Plugin({
      view: (view) => {
        const observer = new MutationObserver((records) => {
          const touched = records.some(
            (record) => record.type === "attributes" || [...record.addedNodes].some(holdsImage),
          );
          if (touched) labelImages(view);
        });
        observer.observe(view.dom, { subtree: true, childList: true, attributes: true, attributeFilter: ["alt"] });
        labelImages(view);
        return {
          update: (updated, previous) => {
            if (updated.state.doc !== previous.doc) labelImages(updated);
          },
          destroy: () => observer.disconnect(),
        };
      },
    }),
);
