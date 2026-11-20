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
 *  or "" when it has none. A dot that starts the name is part of the name, as
 *  in `.prettierrc`, which has no extension. */
export function extensionOf(path: string): string {
  const base = path.replace(/[\\/]+$/, "");
  const name = base.slice(Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The language of the document at `path`, by its extension. An untitled
 *  document, and a file with any other extension, is Markdown. */
export function documentLanguage(path: string | null): DocumentLanguage {
  const extension = path ? extensionOf(path) : "";
  if (EXTENSIONS.json.includes(extension)) return "json";
  if (EXTENSIONS.yaml.includes(extension)) return "yaml";
  return "markdown";
}

/** The filters of an open or save dialog, for the document at `path`, or for
 *  a Markdown document without one. On Windows a save dialog adds the first
 *  extension of its first filter to a name typed without one. So the filter
 *  of the document's own kind comes first, with the document's own extension
 *  first in it, and `settings.json` is not saved as `name.md`, nor
 *  `compose.yml` as `name.yaml`. Other systems return the name as typed
 *  (`FileService.withOwnExtension`). */
export function fileFilters(path: string | null = null): FileDialogFilter[] {
  const language = documentLanguage(path);
  const own = path ? extensionOf(path) : "";
  const of = (name: DocumentLanguage): FileDialogFilter => {
    const extensions = EXTENSIONS[name];
    const first = name === language && extensions.includes(own) ? [own] : [];
    return { name: LANGUAGE_NAMES[name], extensions: [...first, ...extensions.filter((extension) => !first.includes(extension))] };
  };
  const filters = [of("markdown"), { name: "Text", extensions: [...TEXT_EXTENSIONS] }, of("json"), of("yaml")];
  const ownKind = filters.filter((filter) => filter.name === LANGUAGE_NAMES[language]);
  const others = filters.filter((filter) => filter.name !== LANGUAGE_NAMES[language]);
  return [...ownKind, ...others, { name: "All files", extensions: ["*"] }];
}

/** The error that says why no dropped or pasted file goes into the document
 *  at `path`, or null for a Markdown document, which takes them. A file goes
 *  in as a Markdown image or link, which would break a JSON or YAML file. */
export function takesNoFiles(path: string | null): Error | null {
  const language = documentLanguage(path);
  if (language === "markdown") return null;
  return new Error(`A ${LANGUAGE_NAMES[language]} file takes no dropped files. Drop them on a Markdown document.`);
}
