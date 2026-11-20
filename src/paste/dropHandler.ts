// Classifies a file dropped from the desktop (spec §5.4). Electron's preload
// resolves dropped File objects to paths, so classification is by extension:
//   - document → open it: a Markdown or text file, or a JSON or YAML file
//   - image    → embed (base64 or attachment, per imageStore)
//   - other    → copy into the attachments folder and link
//
// The actual handling lives in FileDropCoordinator (it needs the editor and
// the file service); this module is just the pure extension-based decision.

import { DOCUMENT_EXTENSIONS, extensionOf } from "../files/documentLanguage";

export type DropKind = "document" | "image" | "other";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"]);

/** Classify a dropped path by extension (spec §5.4). */
export function classifyDrop(path: string): DropKind {
  const ext = extensionOf(path);
  if (DOCUMENT_EXTENSIONS.includes(ext)) return "document";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "other";
}

/** Last path segment (file name with extension). */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}
