import { Crepe } from "@milkdown/crepe";
import { parserCtx, schemaCtx } from "@milkdown/kit/core";
import { DOMSerializer } from "@milkdown/kit/prose/model";
import { splitFrontmatter } from "../document/frontmatter";
import { oneLineDisplayMath, pandocInlineMath } from "../editor/wysiwyg/mathDelimiters";

export interface FormattedDocument {
  html: string;
  text: string;
}

/** Parse the complete source into portable HTML, without editor controls or
 *  viewport limits. Metadata, formulas and diagram source stay readable text. */
export async function formatDocument(markdown: string): Promise<FormattedDocument> {
  // Crepe supplies the document's CommonMark, GFM and math schemas. Keep the
  // empty view detached and disable its UI features. LaTeX requires CodeMirror,
  // but no code editor is mounted because only the parser receives the source.
  const editor = new Crepe({
    root: document.createElement("div"),
    features: Object.fromEntries(Object.values(Crepe.Feature).map((feature) => [
      feature, feature === Crepe.Feature.CodeMirror || feature === Crepe.Feature.Latex,
    ])),
  });
  editor.editor.use([oneLineDisplayMath, pandocInlineMath].flat());
  try {
    await editor.create();
    const { frontmatter, body } = splitFrontmatter(markdown);
    const root = document.createElement("div");
    if (frontmatter) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = frontmatter.trimEnd();
      pre.append(code);
      root.append(pre);
    }
    const parsed = editor.editor.ctx.get(parserCtx)(body);
    if (!parsed) throw new Error("Could not format the document.");
    const schema = editor.editor.ctx.get(schemaCtx);
    const serializer = new DOMSerializer({
      ...DOMSerializer.nodesFromSchema(schema),
      // KaTeX's rendered HTML needs fonts and CSS the receiving app does not
      // have. Keep the formula intact instead of copying broken visual math.
      math_inline: (node) => ["code", {}, `$${String(node.attrs.value)}$`],
    }, DOMSerializer.marksFromSchema(schema));
    root.append(serializer.serializeFragment(parsed.content));

    // Task state lives in Milkdown attributes and otherwise disappears when
    // another app pastes the list without Downpad's styles or node views.
    for (const item of root.querySelectorAll("li[data-checked]")) {
      const label = item.getAttribute("data-checked") === "true" ? "☑ " : "☐ ";
      (item.querySelector("p") ?? item).prepend(document.createTextNode(label));
    }
    for (const element of root.querySelectorAll("[href], [src]")) {
      for (const name of ["href", "src"]) {
        const value = element.getAttribute(name);
        if (value !== null && (!value || !portableUrl(value, name === "src"))) element.removeAttribute(name);
      }
    }
    return { html: root.innerHTML, text: plainText(root).trimEnd() };
  } finally {
    await editor.destroy();
  }
}

/** Write both clipboard formats, rejecting if rich copying is unavailable. */
export async function copyFormattedDocument(markdown: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Formatted clipboard access is unavailable.");
  }
  const { html, text } = await formatDocument(markdown);
  await navigator.clipboard.write([new ClipboardItem({
    "text/html": new Blob([html], { type: "text/html" }),
    "text/plain": new Blob([text], { type: "text/plain" }),
  })]);
}

/** Keep ordinary links and image sources, excluding executable URL schemes. */
function portableUrl(value: string, image: boolean): boolean {
  try {
    const url = new URL(value, "https://downpad.invalid/");
    if (["https:", "http:", "file:"].includes(url.protocol)) return true;
    if (!image) return ["mailto:", "tel:", "ftp:"].includes(url.protocol);
    return /^data:image\/(?:png|jpeg|gif|webp|avif);/i.test(value);
  } catch {
    return false;
  }
}

/** Retain paragraph breaks, list markers and table columns in plain pastes. */
function plainText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element)) return "";
  const children = () => [...node.childNodes].map(plainText).join("");
  switch (node.tagName) {
    case "BR": return "\n";
    case "HR": return "---\n\n";
    case "IMG": return node.getAttribute("alt") ?? "";
    case "PRE": return `${node.textContent ?? ""}\n\n`;
    case "UL":
    case "OL": {
      const start = Number(node.getAttribute("start") ?? 1);
      return [...node.children].map((item, index) => {
        const marker = node.tagName === "OL" ? `${start + index}. ` : "• ";
        const text = plainText(item).trimEnd().replace(/\n/g, "\n  ");
        return `${marker}${text}\n`;
      }).join("") + "\n";
    }
    case "TR": return [...node.children].map((cell) => plainText(cell).trim()).join("\t") + "\n";
    case "P":
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
    case "BLOCKQUOTE":
    case "TABLE": return `${children().trimEnd()}\n\n`;
    default: return children();
  }
}
