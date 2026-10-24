# External dependencies

The October 24, 2026 update uses the latest stable direct npm dependencies,
Node.js 26.12.1, pnpm 12.15.0, and released GitHub Actions pinned to commit
hashes. CI uses Ubuntu 26.04 and Windows Server 2025. Node's version is recorded
in `.node-version`; pnpm's version is recorded in `package.json`.
The CI installer pins GitHub CLI 2.103.2 and verifies its official release
checksum. The CI helper requests GitHub REST API version 2026-03-10.

Transitive npm dependencies follow their parent packages' compatible ranges.
The lockfile records the resolved versions. `pnpm audit` checks npm advisories;
it does not audit the operating system or binaries downloaded by packaging tools.

## Overrides and patches

- KaTeX is overridden to 0.19.1 throughout the dependency tree. The math parser
  still requests the older 0.16 line, which has a known trust restriction bypass.
- ProseMirror View is overridden to 1.42.8 so all consumers use the release
  targeted by the local selection and input fixes. Its upstream `posAtDOM` fix
  replaces the corresponding part of the old patch.
- Milkdown 7.22.3 remains current. Its component patch still fixes link preview
  targeting, link edit ranges, and deferred list selection restoration.
- Version-specific release-age exceptions permit the reviewed recent KaTeX,
  ProseMirror, and jsdom selector releases. The general pnpm release-age policy
  remains enabled.

Review the overrides and patches when upgrading their parent libraries. Refresh
Playwright's browser download and run `install-electron` after runtime upgrades.
The pnpm 12 lockfile contains multiple YAML documents, which dependency tooling
must read together.

## Bundled software exceptions

Electron 45.0.0 supplies Chromium 156.0.8078.48 and Node.js 24.22.0. These are
Electron's tested runtimes. The desktop bundle targets Node 24 even though
development and CI use Node 26. Playwright 1.64.1 similarly selects its own
Chromium build and supporting binaries.

The project retains electron-builder 26.18.0's supported packaging bundles.
Some are older than the standalone tools' latest releases. Replacing them
independently requires a separate packaging migration and installer testing.
The defaults relevant to the Linux and Windows targets are listed below.

| Tool | Bundle selected by electron-builder |
| --- | --- |
| 7-Zip | `7zip@1.0.0` |
| FPM | `fpm@2.1.4`, containing FPM 1.17.0 and Ruby 3.4.3 |
| WiX | `wix-4.0.0.5512.2` |
| AppImage | `appimage-12.0.1` |
| Windows resource and signing tools | `winCodeSign-2.6.0` |

These are builder bundle identifiers, which can differ from upstream tool
versions. Their downloads and checksums come from electron-builder's published
implementation and [binary releases](https://github.com/electron-userland/electron-builder-binaries/releases).
Hosted runner images supply other system utilities and libraries through their
supported operating system packages. A successful build on Ubuntu 26.04 does
not establish compatibility with every older Linux distribution.
