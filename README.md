# Downpad

Downpad is a desktop Markdown editor built with Electron, React, TypeScript, Milkdown, and CodeMirror. Open Markdown files as formatted documents, edit their source, and print them or export them to PDF.

## Features

- WYSIWYG, split, and raw Markdown editing modes.
- Multiple documents in tabs, with recent files and favorites.
- CommonMark and GitHub Flavored Markdown, including tables, task lists, and strikethrough.
- Syntax-highlighted code blocks, KaTeX math, and Mermaid diagrams.
- Smart paste from HTML, Markdown, URLs, and images.
- Embedded images or file-based attachments.
- Find and replace, frontmatter editing, and configurable Markdown output.
- Autosave, recovery snapshots, external file-change detection, and atomic saves.
- Native file dialogs, Markdown file associations, and print/PDF support.

## Development

Install Node.js 26.12.1 or newer and the pnpm version declared in `package.json`.
The `.node-version` file records the version used in CI.
See [external dependencies](docs/dependencies.md) for overrides and bundled software exceptions.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` compiles the Electron main process and sandboxed preload, starts Vite, and opens the desktop app. Closing Electron also stops Vite. Frontend changes use Vite's hot reload. Restart the command after changing files in `electron/`.

Use `pnpm dev:web` for the browser development environment. Native file access and printing require the Electron app.

## Build and test

```sh
pnpm check
pnpm test
pnpm build
pnpm start
```

`pnpm build` produces the frontend in `dist/` and the Electron main process and preload in `electron-dist/`. `pnpm start` opens that production build. Pass a Markdown path to the app to open it, for example `pnpm start ./notes.md`.

Browser and desktop end-to-end tests run separately.

```sh
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:electron
```

On Linux without a graphical session, run Electron tests with an X server such as Xvfb.

## Installers

```sh
pnpm package
pnpm dist
```

`pnpm package` creates an unpacked desktop app under `release/`. `pnpm dist` creates installers for the host platform, with publishing disabled. Linux builds produce AppImage and DEB files. Windows builds produce MSI installers. macOS has a DMG target configured but is not part of the installer CI matrix.

The app icon and installer images in `build/`, and the glyph paths in `src/components/appGlyph.ts`, are generated from `scripts/icons.mjs`. Run `pnpm icons` after changing the artwork. See [App icon and installer images](docs/design.md#app-icon-and-installer-images).

Build Windows installers on Windows and verify them there. Installer CI builds Linux and Windows packages, retains artifacts for 30 days, and publishes a GitHub release when a stable version tag is pushed. The release tag supplies the app version through `scripts/apply-version-from-tag.mjs`.

Downpad keeps its settings in `settings.toml` in the platform's `Downpad` configuration directory. Downpad was called md-easy before, and on its first launch it moves md-easy's settings, recent files and recovery snapshots there. Markdown files remain ordinary files on disk.

## Maintainer workspace

Maintainer-only agent instructions and personal project material are kept in the private [md-easy-internal](https://github.com/lincarl/md-easy-internal) companion repository. It is optional and is not required to build or use Downpad.

## License

Downpad is open-source software licensed under the [MIT License](LICENSE).
