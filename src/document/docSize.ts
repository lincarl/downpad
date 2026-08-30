// Document size for the status bar (spec §6.1). The on-disk size is the UTF-8
// byte length of the canonical markdown (the form written to disk, §5.18), so
// embedded base64 images are counted. Reported in KB per the status-bar spec.

/** UTF-8 byte length of a string (matches what gets written to disk). */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Size in KB for the status bar: one decimal under 10 KB, whole number above. */
export function formatKB(bytes: number): string {
  const kb = bytes / 1024;
  const value = kb < 10 ? kb.toFixed(1) : Math.round(kb).toLocaleString();
  return `${value} KB`;
}
