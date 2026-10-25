import { describe, expect, it } from "vitest";
import {
  assetFor, assetName, CHECK_INTERVAL_MS, checkDue, isMsiInstallation, isNewerStable, linuxPackageKind, parseRelease,
  RELEASES_PAGE_URL, type Release,
} from "./updatePlan";

const digest = "a".repeat(64);

/** A latest-release answer as GitHub's API sends it. */
function answer(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tag_name: "v1.2.3", draft: false, prerelease: false, html_url: "https://github.com/lincarl/downpad/releases/tag/v1.2.3",
    assets: [{ name: "Downpad-1.2.3-linux-x86_64.AppImage", browser_download_url: "https://example.com/a", digest: `sha256:${digest.toUpperCase()}` }],
    ...fields,
  });
}

describe("Update versions", () => {
  it("offers a newer stable version, and the release of an installed candidate's own version", () => {
    expect(isNewerStable("1.2.4", "1.2.3")).toBe(true);
    expect(isNewerStable("1.10.0", "1.9.9")).toBe(true);
    expect(isNewerStable("2.0.0", "1.99.99")).toBe(true);
    expect(isNewerStable("1.2.3", "1.2.3-rc2")).toBe(true);
    expect(isNewerStable("1.2.3", "1.2.2-rc9")).toBe(true);
  });

  it("never offers the same, an older or a non-stable version, nor updates an unknown version", () => {
    expect(isNewerStable("1.2.3", "1.2.3")).toBe(false);
    expect(isNewerStable("1.2.2", "1.2.3")).toBe(false);
    expect(isNewerStable("1.2.3", "1.2.4-rc1")).toBe(false);
    expect(isNewerStable("1.2.4-rc1", "1.2.3")).toBe(false);
    expect(isNewerStable("01.2.4", "1.2.3")).toBe(false);
    expect(isNewerStable("1.2.4", "1.2.3-beta.1")).toBe(false);
    expect(isNewerStable("1.2.4", "dev")).toBe(false);
  });

  it("checks on a start 30 days after the last check, or when the date is missing or in the future", () => {
    const now = Date.UTC(2026, 9, 25);
    expect(checkDue(null, now)).toBe(true);
    expect(checkDue(now - CHECK_INTERVAL_MS, now)).toBe(true);
    expect(checkDue(now - CHECK_INTERVAL_MS + 1, now)).toBe(false);
    expect(checkDue(now, now)).toBe(false);
    expect(checkDue(now + 60_000, now)).toBe(true);
  });
});

describe("Release answers", () => {
  it("reads a stable release with its assets' SHA-256 digests", () => {
    expect(parseRelease(answer())).toEqual({
      understood: true,
      release: {
        tag: "v1.2.3", version: "1.2.3", pageUrl: "https://github.com/lincarl/downpad/releases/tag/v1.2.3",
        assets: [{ name: "Downpad-1.2.3-linux-x86_64.AppImage", url: "https://example.com/a", sha256: digest }],
      },
    });
  });

  it("understands drafts, prereleases and other tags as no stable release", () => {
    for (const fields of [{ draft: true }, { prerelease: true }, { tag_name: "v1.2.3-rc1" }, { tag_name: "1.2.3" }, { tag_name: "nightly" }]) {
      expect(parseRelease(answer(fields))).toEqual({ understood: true, release: null });
    }
  });

  it("does not understand an answer that is not a release, such as a network filter's page", () => {
    for (const text of ["<html>Blocked</html>", "[]", "null", JSON.stringify({ message: "Not Found" }), JSON.stringify({ tag_name: 3 })]) {
      expect(parseRelease(text)).toEqual({ understood: false, release: null });
    }
  });

  it("keeps assets without a digest only as unusable entries and falls back to the releases page", () => {
    const parsed = parseRelease(answer({ html_url: undefined, assets: [{ name: "x", browser_download_url: "https://example.com/x", digest: "md5:1" }, "junk"] }));
    expect(parsed.release?.pageUrl).toBe(RELEASES_PAGE_URL);
    expect(parsed.release?.assets).toEqual([{ name: "x", url: "https://example.com/x", sha256: "" }]);
  });
});

describe("Release files", () => {
  const release = (assets: Release["assets"]): Release => ({ tag: "v1.2.3", version: "1.2.3", pageUrl: RELEASES_PAGE_URL, assets });

  it("names each package as the release workflow publishes it", () => {
    expect(assetName("appimage", "1.2.3")).toBe("Downpad-1.2.3-linux-x86_64.AppImage");
    expect(assetName("deb", "1.2.3")).toBe("Downpad-1.2.3-linux-amd64.deb");
    expect(assetName("msi", "1.2.3")).toBe("Downpad-1.2.3-win-x64.msi");
  });

  it("chooses this kind's package only with a digest and an HTTPS address", () => {
    const deb = { name: "Downpad-1.2.3-linux-amd64.deb", url: "https://example.com/deb", sha256: digest };
    const msi = { name: "Downpad-1.2.3-win-x64.msi", url: "https://example.com/msi", sha256: digest };
    expect(assetFor(release([msi, deb]), "deb")).toEqual(deb);
    expect(assetFor(release([msi, deb]), "appimage")).toBeNull();
    expect(assetFor(release([{ ...deb, sha256: "" }]), "deb")).toBeNull();
    expect(assetFor(release([{ ...deb, url: "http://example.com/deb" }]), "deb")).toBeNull();
    expect(assetFor(release([{ ...deb, url: "https://user:secret@example.com/deb" }]), "deb")).toBeNull();
    expect(assetFor(release([{ ...deb, name: "Downpad-1.2.2-linux-amd64.deb" }]), "deb")).toBeNull();
  });

  it("allows plain HTTP only from this computer, and only for the tests' release server", () => {
    const local = { name: "Downpad-1.2.3-win-x64.msi", url: "http://127.0.0.1:8080/msi", sha256: digest };
    expect(assetFor(release([local]), "msi")).toBeNull();
    expect(assetFor(release([local]), "msi", true)).toEqual(local);
    expect(assetFor(release([{ ...local, url: "http://example.com/msi" }]), "msi", true)).toBeNull();
  });
});

describe("Installed copies", () => {
  it("recognizes the AppImage that runs, and not a program started from inside another AppImage", () => {
    expect(linuxPackageKind("/tmp/.mount_DownpaXYZ/downpad", "/home/a/Downpad.AppImage", "/tmp/.mount_DownpaXYZ", null)).toBe("appimage");
    expect(linuxPackageKind("/tmp/.mount_DownpaXYZ/downpad", "/home/a/Downpad.AppImage", "/tmp/.mount_DownpaXYZ/", null)).toBe("appimage");
    expect(linuxPackageKind("/opt/Downpad/downpad", "/home/a/Other.AppImage", "/tmp/.mount_OtherABC", null)).toBeNull();
    expect(linuxPackageKind("/tmp/.mount_DownpaXYZ2/downpad", "/home/a/Downpad.AppImage", "/tmp/.mount_DownpaXYZ", null)).toBeNull();
  });

  it("recognizes the DEB installation by dpkg's file list", () => {
    const files = ["/.", "/opt", "/opt/Downpad", "/opt/Downpad/downpad", "/usr/share/applications/downpad.desktop"];
    expect(linuxPackageKind("/opt/Downpad/downpad", undefined, undefined, files)).toBe("deb");
    expect(linuxPackageKind("/home/a/build/linux-unpacked/downpad", undefined, undefined, files)).toBeNull();
    expect(linuxPackageKind("/opt/Downpad/downpad", undefined, undefined, null)).toBeNull();
  });

  it("recognizes the MSI installation by the folder it recorded, in any case and with any trailing separator", () => {
    expect(isMsiInstallation("C:\\Users\\a\\AppData\\Local\\Programs\\Downpad\\Downpad.exe", "C:\\Users\\a\\AppData\\Local\\Programs\\Downpad\\")).toBe(true);
    expect(isMsiInstallation("c:/users/a/appdata/local/programs/downpad/Downpad.exe", "C:\\Users\\A\\AppData\\Local\\Programs\\Downpad")).toBe(true);
    expect(isMsiInstallation("D:\\build\\win-unpacked\\Downpad.exe", "C:\\Users\\a\\AppData\\Local\\Programs\\Downpad\\")).toBe(false);
    expect(isMsiInstallation("C:\\Users\\a\\AppData\\Local\\Programs\\Downpad\\sub\\Downpad.exe", "C:\\Users\\a\\AppData\\Local\\Programs\\Downpad\\")).toBe(false);
    expect(isMsiInstallation("C:\\Users\\a\\AppData\\Local\\Programs\\Downpad\\Downpad.exe", "")).toBe(false);
  });
});
