// The network-free half of the updater: reading GitHub's latest release,
// comparing versions, choosing the file that matches how this copy was
// installed, and recognizing those installations. Kept pure so tests pin it
// down without a network or an installed app.

/** How this copy of Downpad was installed, which decides the release file that
 *  replaces it and how that file is installed. Copies of any other kind, such
 *  as development runs and unpacked builds, never update themselves. The names
 *  are stored as folder names under the updates folder, so never rename one. */
export type PackageKind = "msi" | "appimage" | "deb";

export const RELEASE_API_URL = "https://api.github.com/repos/lincarl/downpad/releases/latest";
export const RELEASES_PAGE_URL = "https://github.com/lincarl/downpad/releases/latest";

/** Automatic checks run on a start at least this long after the last one. */
export const CHECK_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ReleaseAsset {
  name: string;
  /** The `browser_download_url`. */
  url: string;
  /** Lowercase hex from GitHub's `sha256:<hex>` digest, or empty without one. */
  sha256: string;
}

export interface Release {
  /** Such as `v1.2.3`. */
  tag: string;
  /** Such as `1.2.3`, the tag without its `v`. */
  version: string;
  pageUrl: string;
  assets: ReleaseAsset[];
}

/** What an answer to the latest-release request says. `understood` is false for
 *  anything but a JSON object with a string `tag_name`, such as a network
 *  filter's page sent with HTTP 200. `release` is null for a draft, a
 *  prerelease or a tag that is not a stable version. */
export interface ReleaseAnswer {
  understood: boolean;
  release: Release | null;
}

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const installedVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc[1-9]\d*)?$/;

function numbers(match: RegExpExecArray): [number, number, number] {
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether `candidate`, a stable version such as `1.2.3`, should replace the
 *  installed `installed`. Updates stay on stable releases: a stable release
 *  replaces an older version and a release candidate of its own version, such as
 *  `1.2.3-rc2`, but never a newer version. An installed version of any other
 *  form never updates. */
export function isNewerStable(candidate: string, installed: string): boolean {
  const next = stableVersion.exec(candidate);
  const current = installedVersion.exec(installed);
  if (!next || !current) return false;
  const [a, b] = [numbers(next), numbers(current)];
  const order = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  return order > 0 || (order === 0 && current[4] !== undefined);
}

export function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** Read GitHub's answer to the latest-release request. */
export function parseRelease(text: string): ReleaseAnswer {
  let root: unknown;
  try { root = JSON.parse(text); } catch { return { understood: false, release: null }; }
  if (!root || typeof root !== "object" || Array.isArray(root)) return { understood: false, release: null };
  const data = root as Record<string, unknown>;
  if (typeof data.tag_name !== "string") return { understood: false, release: null };
  const tag = data.tag_name;
  const version = tag.startsWith("v") ? tag.slice(1) : "";
  if (data.draft === true || data.prerelease === true || !stableVersion.test(version)) return { understood: true, release: null };
  const assets: ReleaseAsset[] = [];
  for (const value of Array.isArray(data.assets) ? data.assets : []) {
    if (!value || typeof value !== "object") continue;
    const asset = value as Record<string, unknown>;
    if (typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") continue;
    const digest = typeof asset.digest === "string" && asset.digest.startsWith("sha256:") ? asset.digest.slice(7).toLowerCase() : "";
    assets.push({ name: asset.name, url: asset.browser_download_url, sha256: digest });
  }
  return { understood: true, release: { tag, version, pageUrl: typeof data.html_url === "string" ? data.html_url : RELEASES_PAGE_URL, assets } };
}

/** The file name under which the release workflow publishes `kind` for
 *  `version`, as in .github/workflows/build-installers.yml. */
export function assetName(kind: PackageKind, version: string): string {
  switch (kind) {
    case "appimage": return `Downpad-${version}-linux-x86_64.AppImage`;
    case "deb": return `Downpad-${version}-linux-amd64.deb`;
    case "msi": return `Downpad-${version}-win-x64.msi`;
  }
}

/** The release's file for `kind`, if it has one with a SHA-256 digest that
 *  downloads over HTTPS. `allowLoopbackHttp` admits plain HTTP from this
 *  computer, for the tests' release server. */
export function assetFor(release: Release, kind: PackageKind, allowLoopbackHttp = false): ReleaseAsset | null {
  const name = assetName(kind, release.version);
  const asset = release.assets.find((item) => item.name === name);
  if (!asset || !isSha256(asset.sha256)) return null;
  return allowedUrl(asset.url, allowLoopbackHttp) ? asset : null;
}

/** HTTPS, or with `allowLoopbackHttp`, HTTP to this computer. */
export function allowedUrl(value: string, allowLoopbackHttp = false): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return url.protocol === "https:" ||
      (allowLoopbackHttp && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  } catch { return false; }
}

/** Whether an automatic check is due: never checked, a check date in the
 *  future, or the last check at least 30 days ago. */
export function checkDue(lastCheckMs: number | null, nowMs: number): boolean {
  return lastCheckMs === null || lastCheckMs > nowMs || nowMs - lastCheckMs >= CHECK_INTERVAL_MS;
}

/** Classify a Linux copy. `appImage` and `appDir` are $APPIMAGE and $APPDIR,
 *  which the AppImage runtime exports. A program started from inside any
 *  AppImage inherits them, so only an executable inside `appDir` is that image.
 *  `debFiles` lists the files of the installed `downpad` package, from dpkg's
 *  database, or is null without one. A copy in that list came from the DEB. */
export function linuxPackageKind(execPath: string, appImage: string | undefined, appDir: string | undefined,
  debFiles: readonly string[] | null): PackageKind | null {
  if (appImage && appDir && execPath.startsWith(`${appDir.replace(/\/+$/, "")}/`)) return "appimage";
  if (debFiles?.includes(execPath)) return "deb";
  return null;
}

/** Whether a Windows copy runs from the folder that the MSI registered for
 *  this user, so it is that installation. Build folders and copies of the
 *  installation folder never update themselves. */
export function isMsiInstallation(execPath: string, registeredFolder: string): boolean {
  if (!registeredFolder) return false;
  const clean = (path: string): string => path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  const executable = clean(execPath);
  return executable.slice(0, executable.lastIndexOf("\\")) === clean(registeredFolder);
}
