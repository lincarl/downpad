// Which language a document is written in, which its file name tells. A
// Markdown document has the Document, Split and Markdown views. A JSON or YAML
// file is data, which the document view would rewrite as Markdown, so it shows
// as its source alone, with its own syntax colours. The main process reads
// this module too.

import type { FileDialogFilter } from "../ipc/bridge";

/** The language of a document's text. */
export type DocumentLanguage = "markdown" | "json" | "yaml";

/** The file extensions of each language, in lower case and without the dot.
 *  The first is the one a save dialog suggests. A text file reads as
 *  Markdown, as does a file with any other extension. */
const EXTENSIONS: Readonly<Record<DocumentLanguage, readonly string[]>> = {
  markdown: ["md", "markdown", "mdown", "mkd"],
  json: ["json"],
  yaml: ["yaml", "yml"],
};

const TEXT_EXTENSIONS: readonly string[] = ["txt"];

/** What the app calls each language. */
export const LANGUAGE_NAMES: Readonly<Record<DocumentLanguage, string>> = {
  markdown: "Markdown",
  json: "JSON",
  yaml: "YAML",
};

/** The extensions of the files that open in a tab when they are dropped on the
 *  window or named on the command line. */
export const DOCUMENT_EXTENSIONS: readonly string[] = [...EXTENSIONS.markdown, ...TEXT_EXTENSIONS, ...EXTENSIONS.json, ...EXTENSIONS.yaml];

/** The extension of a file name or path, in lower case and without the dot,
 *  or "" when it has none. */
export function extensionOf(path: string): string {
  const base = path.replace(/[\\/]+$/, "");
  const dot = base.lastIndexOf(".");
  const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  if (dot <= slash) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** The language of the document at `path`, by its extension. An untitled
 *  document, and a file with any other extension, is Markdown. */
export function documentLanguage(path: string | null): DocumentLanguage {
  const extension = path ? extensionOf(path) : "";
  if (EXTENSIONS.json.includes(extension)) return "json";
  if (EXTENSIONS.yaml.includes(extension)) return "yaml";
  return "markdown";
}

/** The filters of an open or save dialog. A save dialog adds its first
 *  filter's extension to a name typed without one, so the filter of
 *  `language` comes first, and a JSON document is not saved as `name.md`. */
export function fileFilters(language: DocumentLanguage = "markdown"): FileDialogFilter[] {
  const of = (name: DocumentLanguage): FileDialogFilter => ({ name: LANGUAGE_NAMES[name], extensions: [...EXTENSIONS[name]] });
  const filters = [of("markdown"), { name: "Text", extensions: [...TEXT_EXTENSIONS] }, of("json"), of("yaml")];
  const own = filters.filter((filter) => filter.name === LANGUAGE_NAMES[language]);
  const others = filters.filter((filter) => filter.name !== LANGUAGE_NAMES[language]);
  return [...own, ...others, { name: "All files", extensions: ["*"] }];
}
