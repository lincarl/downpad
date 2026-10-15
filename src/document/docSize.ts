// File and document sizes (spec §6.1). The status bar's on-disk size is the
// UTF-8 byte length of the canonical markdown (the form written to disk, §5.18),
// so embedded base64 images are counted. Every size in the app uses formatSize,
// so the status bar, Recent and the Markdown view read the same way.

/** UTF-8 byte length of a string (matches what gets written to disk). */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

const SIZE_UNITS = ["KB", "MB", "GB"] as const;

/**
 * A size with KB as the smallest unit: "0.4 KB", "12 KB", "1.5 MB". One decimal
 * under 10 of a unit, whole numbers above. A size that is not empty never reads
 * as 0, and an invalid size gives "".
 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes === 0) return "0 KB";
  let value = Math.max(bytes / 1024, 0.1);
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value < 10 ? value.toFixed(1) : Math.round(value).toLocaleString();
  return `${digits} ${SIZE_UNITS[unit]}`;
}
