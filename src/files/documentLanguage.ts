// Which language a document is written in, which its file name tells. A
// Markdown document has the Document, Split and Text views. A text, JSON or
// YAML file shows as its text alone, since the Document view would rewrite it
// as Markdown. A text file is prose with no markup, and a JSON or YAML file is
// data, with its own syntax colours. The main process reads this module too.

import type { FileDialogFilter } from "../ipc/bridge";

/** The file extensions of each language, in lower case and without the dot.
 *  The first is the one a save dialog suggests. A file with any other
 *  extension reads as Markdown. The order is the order of the dialogs'
 *  filters. */
const EXTENSIONS = {
  markdown: ["md", "markdown", "mdown", "mkd"],
  text: ["txt"],
  json: ["json"],
  yaml: ["yaml", "yml"],
} satisfies Record<string, string[]>;

/** The language of a document's text. */
export type DocumentLanguage = keyof typeof EXTENSIONS;

const LANGUAGES = Object.keys(EXTENSIONS) as DocumentLanguage[];

/** What a sentence calls each language, as in "Copy as JSON" or "A text file
 *  takes no dropped files". */
export const LANGUAGE_NAMES: Readonly<Record<DocumentLanguage, string>> = {
  markdown: "Markdown",
  text: "text",
  json: "JSON",
  yaml: "YAML",
};

/** The extensions of the files that open in a tab when they are dropped on the
 *  window or named on the command line. */
export const DOCUMENT_EXTENSIONS: readonly string[] = LANGUAGES.flatMap((language) => EXTENSIONS[language]);

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
  return LANGUAGES.find((language) => EXTENSIONS[language].includes(extension)) ?? "markdown";
}

/** Whether a document in `language` is prose, whose words are counted and
 *  whose spelling is checked. A JSON or YAML file is data. */
export function isProse(language: DocumentLanguage): boolean {
  return language === "markdown" || language === "text";
}

/** The filter of a dialog for the files of `language`, with `first` first in
 *  it when it is one of them. */
function languageFilter(language: DocumentLanguage, first = ""): FileDialogFilter {
  const extensions = EXTENSIONS[language];
  const lead = extensions.includes(first) ? [first] : [];
  const name = LANGUAGE_NAMES[language];
  return { name: name[0].toUpperCase() + name.slice(1), extensions: [...lead, ...extensions.filter((extension) => !lead.includes(extension))] };
}

const allFiles = (): FileDialogFilter => ({ name: "All files", extensions: ["*"] });

/** The filters of a dialog that opens a document. A dialog selects its first
 *  filter, so with `allSupportedFirst` the filter of every supported file
 *  comes first. */
export function openFileFilters(allSupportedFirst: boolean): FileDialogFilter[] {
  const allSupported = { name: "All supported files", extensions: [...DOCUMENT_EXTENSIONS] };
  const kinds = LANGUAGES.map((language) => languageFilter(language));
  return allSupportedFirst ? [allSupported, ...kinds, allFiles()] : [...kinds, allSupported, allFiles()];
}

/** The filters of a save dialog, for the document at `path`, or for a
 *  Markdown document without one. On Windows a save dialog adds the first
 *  extension of its selected filter, which is its first, to a name typed
 *  without one. So the filter of the document's own kind comes first, with
 *  the document's own extension first in it, and `settings.json` is not saved
 *  as `name.md`, nor `compose.yml` as `name.yaml`. The filter of all
 *  supported files is left out, as it would give such a name the extension of
 *  a Markdown file. Other systems return the name as typed
 *  (`FileService.withOwnExtension`). */
export function saveFileFilters(path: string | null = null): FileDialogFilter[] {
  const own = documentLanguage(path);
  const others = LANGUAGES.filter((language) => language !== own).map((language) => languageFilter(language));
  return [languageFilter(own, path ? extensionOf(path) : ""), ...others, allFiles()];
}

/** The error that says why no dropped or pasted file goes into the document
 *  at `path`, or null for a Markdown document, which takes them. A file goes
 *  in as a Markdown image or link, which would break any other file. */
export function takesNoFiles(path: string | null): Error | null {
  const language = documentLanguage(path);
  if (language === "markdown") return null;
  return new Error(`A ${LANGUAGE_NAMES[language]} file takes no dropped files. Drop them on a Markdown document.`);
}
