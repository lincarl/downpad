// Fence info after the language. Docusaurus, MkDocs, Hugo, VitePress and Quarto
// read the rest of a fence's info line for file titles, highlighted lines and
// options, as in ```js title="server.js"```. Milkdown's code block keeps only the
// language, so any save dropped the rest. This schema keeps it in a `meta`
// attribute and writes it back after the language. remark gives the info as
// CommonMark reads it, so backslash escapes and character references in it may
// be written back spelled differently, as in `title="a\"b"` saved as
// `title="a"b"`. Keeping the exact bytes would need the source text of the line.
//
// Crepe's LaTeX feature reads a `$$` math block as a code block in the LaTeX
// language and writes every LaTeX code block back as math. That also turned a
// ```latex fence, which shows LaTeX source, into a `$$` formula. The `fenced`
// attribute marks a block read from a fence in the file, so it is written back
// as a fence. Math blocks and blocks made in the editor are not marked.

import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";

/** The code block schema with the fence info after the language kept in `meta`
 *  and fences kept apart from math blocks. Use it after Crepe's LaTeX feature
 *  so this node spec replaces Crepe's. */
export const codeBlockMetaSchema = codeBlockSchema.extendSchema((prev) => (ctx) => {
  const schema = prev(ctx);
  return {
    ...schema,
    attrs: {
      ...schema.attrs,
      meta: { default: "", validate: "string" },
      fenced: { default: false, validate: "boolean" },
    },
    // Copy and paste inside the editor goes through the DOM, so the info and
    // the fence mark travel there in data attributes.
    parseDOM: schema.parseDOM?.map((rule) => ({
      ...rule,
      getAttrs: (dom: HTMLElement) => {
        const attrs = rule.getAttrs ? rule.getAttrs(dom) : null;
        return attrs === false ? false : { ...attrs, meta: dom.dataset.meta ?? "", fenced: dom.dataset.fenced === "true" };
      },
    })),
    toDOM: (node) => [
      "pre",
      {
        "data-language": node.attrs.language || undefined,
        "data-meta": node.attrs.meta || undefined,
        "data-fenced": node.attrs.fenced ? "true" : undefined,
      },
      ["code", 0],
    ],
    parseMarkdown: {
      match: schema.parseMarkdown.match,
      runner: (state, node, type) => {
        state.openNode(type, {
          language: (node.lang as string | null | undefined) ?? "",
          meta: (node.meta as string | null | undefined) ?? "",
          // Crepe builds the code node for a `$$` block itself, without a source
          // position. A code block read from the file has one.
          fenced: node.position !== undefined,
        });
        if (node.value) state.addText(node.value as string);
        state.closeNode();
      },
    },
    toMarkdown: {
      match: schema.toMarkdown.match,
      runner: (state, node) => {
        const text = node.content.firstChild?.text ?? "";
        const language = node.attrs.language as string;
        // Crepe's LaTeX feature stores a `$$` block as a LaTeX code block. This
        // spec replaces Crepe's, so it writes that block back as math the same
        // way, unless the block came from a fence.
        if (!node.attrs.fenced && language.toLowerCase() === "latex") state.addNode("math", undefined, text);
        else state.addNode("code", undefined, text, { lang: language, meta: (node.attrs.meta as string) || null });
      },
    },
  };
});
