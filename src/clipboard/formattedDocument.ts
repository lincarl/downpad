import { Crepe } from "@milkdown/crepe";
import { parserCtx, schemaCtx } from "@milkdown/kit/core";
import { DOMSerializer } from "@milkdown/kit/prose/model";
import { splitFrontmatter } from "../document/frontmatter";
import { oneLineDisplayMath, pandocInlineMath } from "../editor/wysiwyg/mathDelimiters";
import { isNetworkPath } from "../images/pathResolve";

export interface FormattedDocument {
  html: string;
  text: string;
}

/** Parse the complete source into portable HTML, without editor controls or
 *  viewport limits. Metadata, formulas and diagram source stay readable text. */
export async function formatDocument(markdown: string, filePath: string | null = null): Promise<FormattedDocument> {
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
    // Build the copy in a document without a window. An <img> made in the page
    // loads its src at once, even outside the page, and the raw src of an image
    // such as `//server/share/a.png` would be read from that file server.
    const inert = document.implementation.createHTMLDocument("");
    const root = inert.createElement("div");
    if (frontmatter) {
      const pre = inert.createElement("pre");
      const code = inert.createElement("code");
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
    }, {
      ...DOMSerializer.marksFromSchema(schema),
      // The editor's link serializer drops file URLs and Windows drive paths.
      // Preserve their source for the same URL checks as images below.
      link: (mark) => ["a", {
        href: String(mark.attrs.href),
        title: mark.attrs.title,
      }, 0],
    });
    root.append(serializer.serializeFragment(parsed.content, { document: inert }));

    // Task state lives in Milkdown attributes and otherwise disappears when
    // another app pastes the list without Downpad's styles or node views.
    for (const item of root.querySelectorAll("li[data-checked]")) {
      const label = item.getAttribute("data-checked") === "true" ? "☑ " : "☐ ";
      (item.querySelector("p") ?? item).prepend(inert.createTextNode(label));
    }
    for (const element of root.querySelectorAll("[href], [src]")) {
      for (const name of ["href", "src"]) {
        const value = element.getAttribute(name);
        if (value === null) continue;
        const url = portableUrl(value, name === "src", filePath);
        if (url) element.setAttribute(name, url);
        else element.removeAttribute(name);
      }
    }
    return { html: root.innerHTML, text: plainText(root).trimEnd() };
  } finally {
    await editor.destroy();
  }
}

/** Write both clipboard formats, rejecting if rich copying is unavailable. */
export async function copyFormattedDocument(markdown: string, filePath: string | null = null): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Formatted clipboard access is unavailable.");
  }
  const { html, text } = await formatDocument(markdown, filePath);
  await navigator.clipboard.write([new ClipboardItem({
    "text/html": new Blob([html], { type: "text/html" }),
    "text/plain": new Blob([text], { type: "text/plain" }),
  })]);
}

/** Resolve local targets against the document, excluding network paths and executable schemes. */
function portableUrl(value: string, image: boolean, filePath: string | null): string | null {
  try {
    let target = value.trim();
    // Check the source before resolving it. A relative target in a document
    // opened from a share is allowed, but a target that names a server is not.
    // A malformed escape in a query or fragment must not hide an encoded path.
    if (!target || isNetworkPath(target) || isNetworkPath(target.split(/[?#]/, 1)[0])) return null;
    if (/^[A-Za-z]:[\\/]/.test(target)) target = `file:///${target.replace(/\\/g, "/")}`;
    else if (target.startsWith("/")) target = `file://${target}`;
    const url = new URL(target, filePath ? fileUrl(filePath) : undefined);
    if (["https:", "http:", "file:"].includes(url.protocol)) return url.href;
    if (!image && ["mailto:", "tel:", "ftp:"].includes(url.protocol)) return url.href;
    if (image && /^data:image\/(?:png|jpeg|gif|webp|avif);/i.test(target)) return target;
    return null;
  } catch {
    return null;
  }
}

/** Encode a filesystem path as a URL without treating its # or ? as URL syntax. */
function fileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const prefix = normalized.startsWith("//") ? "file:" : normalized.startsWith("/") ? "file://" : "file:///";
  return prefix + encodeURI(normalized).replace(/[?#]/g, encodeURIComponent);
}

/** Retain paragraph breaks, list markers and table columns in plain pastes. */
function plainText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element)) return "";
  const children = () => [...node.childNodes].map(plainText).join("");
  if (node.matches('sup[data-type="footnote_reference"]')) return `[${node.textContent ?? ""}]`;
  if (node.matches('dl[data-type="footnote_definition"]')) {
    const body = node.querySelector("dd");
    return `[${node.getAttribute("data-label") ?? ""}] ${body ? plainText(body).trimEnd() : ""}\n\n`;
  }
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
