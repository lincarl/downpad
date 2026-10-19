// Classifies a file dropped from the desktop (spec §5.4). Electron's preload
// resolves dropped File objects to paths, so classification is by extension:
//   - markdown → open it
//   - image    → embed (base64 or attachment, per imageStore)
//   - other    → copy into the attachments folder and link
//
// The actual handling lives in FileDropCoordinator (it needs the editor and
// the file service); this module is just the pure extension-based decision.

export type DropKind = "md" | "image" | "other";

const MD_EXTS = new Set(["md", "markdown", "mdown", "mkd", "txt"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"]);

/** Lower-case extension without the dot, or "" if none. */
export function extOf(path: string): string {
  const base = path.replace(/[\\/]+$/, "");
  const dot = base.lastIndexOf(".");
  const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  if (dot <= slash) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Classify a dropped path by extension (spec §5.4). */
export function classifyDrop(path: string): DropKind {
  const ext = extOf(path);
  if (MD_EXTS.has(ext)) return "md";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "other";
}

/** Last path segment (file name with extension). */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}
