# md-easy design

This document describes the main design of md-easy. It intentionally omits internal API listings, historical migration notes, and development plans.

## Technology

md-easy is an Electron desktop application:

- The frontend uses React and TypeScript.
- Milkdown Crepe provides the WYSIWYG Markdown editor.
- CodeMirror provides the Markdown source editor.
- The TypeScript main process handles native file access, settings, recovery data, printing, and desktop integration.
- Local application data is stored in human-readable or standard formats such as Markdown, TOML, and JSON.

Electron packages Chromium and Node.js with the app. This gives development and installed builds the same browser runtime at the cost of a larger installer.

## Editing model

Each open document has one canonical Markdown string. The document and source editors are two views of that same content:

- Document view renders and edits formatted Markdown.
- Markdown view exposes the source directly. It parses GitHub Flavored Markdown with a leading YAML frontmatter block, and colors it with VS Code's default Markdown and YAML token colors (Light+ and Dark+).
- Split view shows both and synchronizes changes between them.

Opening a document never changes its text. The document view reports the exact source it was given until the user edits the body there, and an edit there writes the body in Milkdown's Markdown style.

Each tab owns its own document state, including its path, content, save status, and line-ending style. The save status compares the content with the text last read from or written to the file, or with the starting text of a document that has no file. A recovered snapshot counts as unsaved until it is saved, because the file may have changed since. While a save is being written, any edit counts as unsaved, because the file may hold either text. When the save finishes, the document stays unsaved if its text or line-ending style changed while it was written, and a change on disk recorded in the meantime with a later time stays the file's text. The active tab is bound to the visible editor views.

Milkdown and CodeMirror manage their own editor DOM and lifecycles. React owns the surrounding application interface, including tabs, toolbars, dialogs, settings, recent files, and print views.

## Interface design

The interface follows the look of [Mervin PDF](https://github.com/lincarl/mervin-pdf). Dark mode uses Mervin's "Nord" chrome and light mode its "Cool slate" chrome.

- `src/styles/app.css` defines the chrome tokens (surfaces from the input well to the floating popover, inks, translucent edges and washes, the accent) for both themes and exposes them to Tailwind as colors such as `bg-well`, `text-ink-soft` and `border-line-push`.
- The primitives in `src/components/ui` (buttons, fields, check boxes, dialogs, menus, tooltips) carry Mervin's control styles, so surfaces compose them instead of restyling controls.
- Chrome icons are Lucide icons drawn at a 1px line weight.
- The document surface has its own light and dark palette, independent of the chrome theme. Find highlights use the same classes in the Document and Markdown views.

## Application structure

The frontend is organized around a small observable application store and service modules for the major responsibilities:

- Document and tab state.
- File operations and external-change handling.
- WYSIWYG and source-editor integration.
- Paste, image, attachment, and link handling.
- Recent files, search, settings, and recovery.
- Printing and platform integration.

The Electron main process provides operations that require native access. File reads and writes, attachment storage, recovery snapshots, recent-file data, and settings persistence stay outside the renderer. A bundled preload exposes typed operations through Electron's context bridge. The renderer uses context isolation and sandboxing without Node.js access.

Packaged builds always load the bundled frontend and ignore development URL overrides. Unpackaged development launches accept only HTTP or HTTPS URLs on localhost, 127.0.0.1, or ::1, without credentials. Native commands accept only the authorized main frame.

## Data and persistence

User documents remain standard Markdown files. md-easy does not use a proprietary document format.

Application preferences are stored in `settings.toml`. Recent-file history and recovery snapshots are stored separately in the application's local data directory. File writes are performed atomically where practical to reduce the chance of corruption.

Settings saves use TOML syntax-tree ranges to update complete root values and insert missing settings before the first table. Quoted keys, surrounding comments, unknown data, a leading BOM, and existing line endings are preserved. Settings reads reject invalid UTF-8 rather than replacing bytes, and loading failures use defaults without changing the file. Before writing, the app checks that the result parses and contains exactly the requested settings plus the original unknown values. Invalid UTF-8, invalid TOML, or known settings expressed as dotted keys or table declarations remain untouched, and the app reports that saving failed. Known settings must use root key-value assignments.

Images can either live inside Markdown as data URIs or as files in a configurable attachments directory. Relative paths are used for attachment links so a document and its attachments can be moved together.

Attachment writes stage complete bytes in a sibling temporary file before publication. On filesystems with hard links, publication atomically claims a free name. FAT and exFAT use serialized application writes, a fresh name check, and atomic rename instead. That fallback preserves support for these filesystems, but another process creating the same name between the check and rename can have its file replaced.

## Desktop integration

Electron provides native windows, file associations, single-instance behavior, native open/save dialogs, opening links and folders, system appearance settings, and printing. Linux builds provide AppImage and DEB installers. Windows builds provide NSIS and MSI installers.

The print workspace mounts a rendered copy of the document in the app window. Electron prints that document using the selected printer or writes a PDF. Printing waits for the workspace to finish rendering before starting the job.

The frontend can also run in a browser-backed development environment with platform operations represented by adapters. This allows most interface and editing behavior to be tested independently of the desktop shell.

## Design priorities

- Keep Markdown portable and directly editable.
- Make the formatted document view the default without hiding the source.
- Avoid content loss when switching views, tabs, or application sessions.
- Keep native capabilities behind focused backend services.
- Prefer a small, responsive desktop application over a broad workspace platform.
