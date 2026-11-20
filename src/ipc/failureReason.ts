/** Plain reasons for the file system errors a user can act on. */
const FILE_SYSTEM_REASONS: Record<string, string> = {
  ENOENT: "The file or folder does not exist.",
  // On Windows these also come from a file that another program holds open.
  EACCES: "Permission was denied, or another program is using the file.",
  EPERM: "Permission was denied, or another program is using the file.",
  EROFS: "The disk is read-only.",
  ENOSPC: "The disk is full.",
  EBUSY: "Another program is using the file.",
};

/** The reason an error gives, to show after a sentence that says what failed.
 *  Electron puts "Error invoking remote method" and the channel before the
 *  text of an error from the main process, which this leaves out. A common
 *  file system error gets a plain reason in place of Node's text, which can
 *  name a temporary file the user never saw. */
export function failureReason(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const reason = text.replace(/^Error invoking remote method(?: '[^']*')?[.:]\s*(?:\w*Error:\s*)?/, "").trim();
  const code = /^(E[A-Z0-9]+): /.exec(reason)?.[1];
  return (code && FILE_SYSTEM_REASONS[code]) || reason;
}
