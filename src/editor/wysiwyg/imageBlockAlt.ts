// Alt text for standalone images. Crepe's image block reuses the Markdown alt
// slot for its resize ratio. It reads `![Diagram](notes.png)` as ratio 1 and
// writes it back as `![1.00](notes.png)`, so any edit and save replaced the alt
// text with a number. This schema gives the block a real `alt` attribute that
// round-trips unchanged. The title stays the block's caption, as in Crepe.
//
// The resize ratio becomes a display setting for the open editor. Plain Markdown
// has no place to store it, so it is not saved and a reopened image starts at its
// fitted size.

import { imageBlockSchema } from "@milkdown/kit/component/image-block";

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
