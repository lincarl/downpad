// Attachment filename generation (spec §5.5, §5.7). Pasted/embedded images that
// go to the attachments folder are named `img-{timestamp}.{ext}`. The timestamp
// is ISO-8601 with the colons replaced by dashes — colons are illegal in Windows
// filenames — and the fractional milliseconds dropped for readability.

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/x-icon": "ico",
};

/** File extension (no dot) for an image MIME type; falls back to the subtype. */
export function extForMime(mime: string): string {
  const known = MIME_TO_EXT[mime.toLowerCase()];
  if (known) return known;
  const subtype = mime.split("/")[1]?.split("+")[0]?.trim();
  return subtype && /^[a-z0-9]+$/i.test(subtype) ? subtype.toLowerCase() : "bin";
}

/** Path-safe timestamp: `2026-05-31T15:42:11.000Z` → `2026-05-31T15-42-11Z`. */
export function sanitizeTimestamp(iso: string): string {
  return iso.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

/**
 * Attachment file name for an image, e.g. `img-2026-05-31T15-42-11Z.png`.
 * `isoTimestamp` defaults to now; pass one explicitly in tests for determinism.
 */
export function attachmentFileName(mime: string, isoTimestamp: string = new Date().toISOString()): string {
  return `img-${sanitizeTimestamp(isoTimestamp)}.${extForMime(mime)}`;
}
