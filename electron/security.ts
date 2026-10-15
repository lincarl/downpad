import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { absolutePath, imageMime } from "./io";

/** Packaged apps use bundled content. Development entries must stay on loopback. */
export function developmentEntryUrl(value: string | undefined, isPackaged: boolean): string | undefined {
  if (isPackaged || !value) return undefined;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password) {
    throw new Error("The development URL must use HTTP or HTTPS on localhost, 127.0.0.1, or [::1], without credentials.");
  }
  return url.href;
}

export function externalUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("A link is required.");
  const url = new URL(value);
  if (!["https:", "http:", "mailto:"].includes(url.protocol)) throw new Error("This link type is not supported.");
  return url.href;
}

export function trustedPage(url: string, entryUrl: string): boolean {
  try {
    const actual = new URL(url);
    const entry = new URL(entryUrl);
    if (entry.protocol === "file:") return actual.protocol === "file:" && actual.pathname === entry.pathname && actual.host === entry.host;
    return actual.origin === entry.origin && actual.pathname === entry.pathname;
  } catch { return false; }
}

/** Clipboard actions belong to the trusted editor document, including image copy/paste. */
export function clipboardPermission(permission: string, requestingUrl: string, entryUrl: string, isMainFrame: boolean): boolean {
  return isMainFrame && (permission === "clipboard-read" || permission === "clipboard-sanitized-write") && trustedPage(requestingUrl, entryUrl);
}

/** realpath() codes for a path that does not lead to a file. */
const MISSING_PATH_ERRORS = new Set(["ENOENT", "ENOTDIR"]);

/** Local image URLs grant access to one image explicitly requested by the trusted renderer. */
export class ImageAccess {
  private readonly pathsByToken = new Map<string, string>();
  private readonly tokensByPath = new Map<string, string>();

  /** Authorize one local image and return its URL, or null when the file does not exist.
   *  A missing image is a normal document state that the renderer shows as a placeholder,
   *  so it must not reject and make Electron log a handler error. */
  async imageUrl(value: unknown): Promise<string | null> {
    let path: string;
    try {
      path = await realpath(absolutePath(value));
    } catch (error) {
      if (error instanceof Error && "code" in error && typeof error.code === "string"
        && MISSING_PATH_ERRORS.has(error.code)) return null;
      throw error;
    }
    if (!imageMime(path)) throw new Error("Only local images can be loaded.");
    let token = this.tokensByPath.get(path);
    if (!token) {
      token = randomUUID();
      this.tokensByPath.set(path, token);
      this.pathsByToken.set(token, path);
    }
    return `md-easy-file://local/image?token=${encodeURIComponent(token)}`;
  }

  async resolveImage(token: string): Promise<string> {
    const path = this.pathsByToken.get(token);
    if (!path) throw new Error("This image URL has not been authorized.");
    // Reject a path whose symlink target changed since the URL was authorized.
    if (await realpath(path) !== path) throw new Error("This image path changed after authorization.");
    return path;
  }
}
