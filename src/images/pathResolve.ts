// Resolving a markdown `src`/`href` to an absolute filesystem path (spec §5.5,
// §5.6, §5.7). Used to (a) display linked/relative images via the Electron asset
// protocol, (b) read image bytes for "Copy image", and (c) decide whether a
// double-clicked link points at a local markdown file to open in a tab
// (resolveMarkdownLinkTarget). Pure string logic so it's testable; the actual
// asset-URL conversion / byte reads / tab-opening live with the callers.

/** A `data:`, `http(s):`, `blob:`, `asset:`, or `file:` URL — not a local path to resolve. */
export function isRemoteOrData(url: string): boolean {
  return /^(data:|https?:|blob:|asset:|file:)/i.test(url) || url.startsWith("http://asset.");
}

/** Absolute filesystem path: Windows drive (`C:\`/`C:/`), POSIX `/`, or UNC `\\`. */
export function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
}

/** Directory portion of a path (handles both slash styles), without trailing slash. */
export function dirName(filePath: string): string {
  const norm = filePath.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return idx >= 0 ? norm.slice(0, idx) : "";
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Two slashes of either kind start a UNC or Windows device path. */
const NETWORK_PREFIX = /^[\\/]{2}/;

function namesServer(value: string): boolean {
  // Chromium's URL parser drops tabs and line breaks and strips leading spaces
  // and control characters, so ` //server/share` reaches the server too.
  const trimmed = value.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+/, "");
  if (NETWORK_PREFIX.test(trimmed)) return true;
  if (!/^file:/i.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return url.host !== "" || NETWORK_PREFIX.test(safeDecode(url.pathname));
  } catch {
    return true;
  }
}

/**
 * Whether an image `src` or link `href` written in a document names a file on
 * another computer: a UNC or Windows device path (`//server/share`,
 * `\\server\share`, `\\?\…`, `\\.\…`, in any mix of slashes), or a `file:`
 * URL with a server name, also once percent-decoded. Downpad never resolves or
 * loads such a src or href, because opening it makes Windows connect to the
 * server over SMB and can send it the user's credentials. A relative path in a
 * document saved on a share is not one of these and still resolves.
 */
export function isNetworkPath(value: string): boolean {
  return namesServer(value) || namesServer(safeDecode(value));
}

/**
 * Resolve an image `src` to an absolute path, or null when it can't / shouldn't
 * be resolved (remote/data URL, a network path (isNetworkPath), or a relative
 * path with no saved document to anchor to). Relative paths are joined to the
 * document's directory (§5.7), also when that is on a network share.
 */
export function resolveImagePath(src: string, docPath: string | null): string | null {
  if (!src || isRemoteOrData(src) || isNetworkPath(src)) return null;
  const decoded = safeDecode(src);
  if (isAbsolutePath(decoded)) return decoded;
  if (!docPath) return null;
  const dir = dirName(docPath);
  if (!dir) return null;
  return `${dir}/${decoded}`;
}

/** Markdown file extensions a link can target to open in a tab (matches the
 *  open-dialog filters, §5.1; excludes `.txt`). */
const MARKDOWN_LINK_EXT = /\.(?:md|markdown|mdown|mkd)$/i;

/**
 * Collapse `.`/`..`/empty segments in a joined path so a relative link resolves
 * to one canonical spelling — keeping tab dedup (§5.19) and the Recent list tidy
 * when a link uses `./` or `../`. Drive-letter and POSIX paths are returned with
 * forward slashes (Windows accepts `C:/…`) and a `..` never escapes the
 * drive/root. UNC paths (`\\server\share\…`) are left exactly as-is: they are
 * rare here and reshaping their prefix risks breaking share resolution.
 */
export function collapseDotSegments(joined: string): string {
  if (/^[\\/]{2}/.test(joined)) return joined; // UNC — leave untouched
  const unified = joined.replace(/\\/g, "/");
  const leadingSlash = unified.startsWith("/");
  const out: string[] = [];
  for (const seg of unified.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      const top = out[out.length - 1];
      if (out.length && top !== ".." && !/^[A-Za-z]:$/.test(top)) out.pop();
      else if (top === "..") out.push("..");
      continue;
    }
    out.push(seg);
  }
  const result = out.join("/");
  return leadingSlash ? `/${result}` : result;
}

/**
 * Resolve a link `href` to the absolute path of a *local markdown file*, or null
 * when it isn't one we open in a tab (spec §5.6): a web/protocol link (http(s),
 * mailto, data, file, …), a protocol-relative URL or other network path
 * (isNetworkPath), an in-document anchor (`#heading`), a non-markdown file, or
 * a relative link with no saved document to anchor it. Any query/fragment is
 * stripped, so `notes.md#section` still targets `notes.md`; a relative result
 * has its `./`/`..` segments collapsed so it dedupes against the same file
 * opened by other means (§5.19).
 */
export function resolveMarkdownLinkTarget(href: string, docPath: string | null): string | null {
  if (!href) return null;
  // A URL scheme (http:, mailto:, file:, …) is never a local path to resolve.
  // A Windows drive letter (`C:\`) also matches `scheme:`, so exclude it.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) && !/^[A-Za-z]:[\\/]/.test(href)) return null;
  // `//host/path` is a protocol-relative web URL and, like `\\host\path` or
  // `%2F%2Fhost/path`, a UNC path once decoded. Never a local file we open.
  // Reject before the isAbsolutePath check, which would otherwise accept it.
  // Check the part that opens, because a malformed escape in the query or
  // fragment, as in `%2F%2Fhost/a.md#%`, keeps the whole href from decoding.
  const target = href.split(/[?#]/, 1)[0];
  if (isNetworkPath(href) || isNetworkPath(target)) return null;
  const path = safeDecode(target);
  if (!path || !MARKDOWN_LINK_EXT.test(path)) return null;
  if (isAbsolutePath(path)) return path;
  if (!docPath) return null;
  const dir = dirName(docPath);
  if (!dir) return null;
  return collapseDotSegments(`${dir}/${path}`);
}
