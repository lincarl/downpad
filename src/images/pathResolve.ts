// Resolving a markdown `src`/`href` to an absolute filesystem path (spec §5.5,
// §5.6, §5.7). Used to (a) display linked/relative images via the Electron asset
// protocol, (b) read image bytes for "Copy image", (c) decide whether a
// double-clicked link points at a local markdown file to open in a tab
// (resolveMarkdownLinkTarget), and (d) link a dropped file from the folder its
// document was saved in while the file was written (rebaseLink, §5.4). Pure
// string logic so it's testable; the actual asset-URL conversion / byte reads /
// tab-opening live with the callers.

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

/**
 * Resolve an image `src` to an absolute path, or null when it can't / shouldn't
 * be resolved (remote/data URL, or a relative path with no saved document to
 * anchor to). Relative paths are joined to the document's directory (§5.7).
 */
export function resolveImagePath(src: string, docPath: string | null): string | null {
  if (!src || isRemoteOrData(src)) return null;
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

/** A path's root, such as `C:`, `//server/share`, or "" for a POSIX path,
 *  and the names below it, with `.` and `..` worked out. */
function pathParts(path: string): { root: string; names: string[] } {
  const unified = path.replace(/\\/g, "/");
  const root = /^\/\/[^/]+\/[^/]+|^[A-Za-z]:/.exec(unified)?.[0] ?? "";
  const names: string[] = [];
  for (const name of unified.slice(root.length).split("/")) {
    if (name === "..") names.pop();
    else if (name !== "" && name !== ".") names.push(name);
  }
  return { root, names };
}

/**
 * The link from a document at `docPath` to the file that the relative `link`
 * names from a document at `linkedFrom`. That is the link to an attachment
 * from where its document is now, after the document was saved in another
 * folder. The result is relative, with forward slashes, such as
 * `../notes/attachments/data.csv`, or the file's absolute path when it is on
 * another drive or share. A link between documents in the same folder stays
 * as it is, and so does one that is not a relative path, such as a data URI.
 */
export function rebaseLink(link: string, linkedFrom: string, docPath: string): string {
  const from = dirName(linkedFrom);
  const to = dirName(docPath);
  if (from === to || isRemoteOrData(link) || isAbsolutePath(link)) return link;
  const target = pathParts(`${from}/${link}`);
  const base = pathParts(to);
  // Windows paths start with a drive or a share, and their names ignore case.
  const windows = target.root !== "" || base.root !== "";
  const same = (a: string, b: string): boolean => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!same(target.root, base.root)) return `${target.root}/${target.names.join("/")}`;
  let shared = 0;
  const most = Math.min(base.names.length, target.names.length);
  while (shared < most && same(base.names[shared], target.names[shared])) shared++;
  return [...base.names.slice(shared).map(() => ".."), ...target.names.slice(shared)].join("/");
}

/**
 * Resolve a link `href` to the absolute path of a *local markdown file*, or null
 * when it isn't one we open in a tab (spec §5.6): a web/protocol link (http(s),
 * mailto, data, file, …), a protocol-relative URL (`//host/…`), an in-document
 * anchor (`#heading`), a non-markdown file, or a relative link with no saved
 * document to anchor it. Any query/fragment is stripped, so `notes.md#section`
 * still targets `notes.md`; a relative result has its `./`/`..` segments
 * collapsed so it dedupes against the same file opened by other means (§5.19).
 */
export function resolveMarkdownLinkTarget(href: string, docPath: string | null): string | null {
  if (!href) return null;
  // A URL scheme (http:, mailto:, file:, …) is never a local path to resolve.
  // A Windows drive letter (`C:\`) also matches `scheme:`, so exclude it.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) && !/^[A-Za-z]:[\\/]/.test(href)) return null;
  // `//host/path` is a protocol-relative web URL (it also looks like a
  // forward-slash UNC path) — never a local file we open. Reject before the
  // isAbsolutePath check, which would otherwise accept it via its leading slash.
  if (href.startsWith("//")) return null;
  const path = safeDecode(href.split(/[?#]/, 1)[0]);
  if (!path || !MARKDOWN_LINK_EXT.test(path)) return null;
  if (isAbsolutePath(path)) return path;
  if (!docPath) return null;
  const dir = dirName(docPath);
  if (!dir) return null;
  return collapseDotSegments(`${dir}/${path}`);
}
