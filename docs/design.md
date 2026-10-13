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
- Markdown view exposes the source directly.
- Split view shows both and synchronizes changes between them.

Each tab owns its own document state, including its path, content, save status, and line-ending style. The active tab is bound to the visible editor views.

Milkdown and CodeMirror manage their own editor DOM and lifecycles. React owns the surrounding application interface, including tabs, toolbars, dialogs, settings, recent files, and print views.

## Application structure

The frontend is organized around a small observable application store and service modules for the major responsibilities:

- Document and tab state.
- File operations and external-change handling.
- WYSIWYG and source-editor integration.
- Paste, image, attachment, and link handling.
- Recent files, search, settings, and recovery.
- Printing and platform integration.

The Electron main process provides operations that require native access. File reads and writes, attachment storage, recovery snapshots, recent-file data, and settings persistence stay outside the renderer. A bundled preload exposes typed operations through Electron's context bridge. The renderer uses context isolation and sandboxing without Node.js access.

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
