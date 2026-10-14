import type {} from "../ipc/bridge";

const WINDOWS_PATH = /^(?:[a-z]:[\\/]|\\\\)/i;

/** Preserve case on POSIX filesystems while accepting Windows path variants. */
export function sameFilePath(left: string, right: string, platform?: string): boolean {
  const runtimePlatform = platform ?? (typeof window === "undefined" ? undefined : window.mdEasy?.platform);
  const windows = runtimePlatform === "win32" || WINDOWS_PATH.test(left) || WINDOWS_PATH.test(right);
  if (!windows) return left === right;
  return left.replace(/\\/g, "/").toLowerCase() === right.replace(/\\/g, "/").toLowerCase();
}
