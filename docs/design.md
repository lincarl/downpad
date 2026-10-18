# md-easy design

This document describes the main design of md-easy. It intentionally omits internal API listings, historical migration notes, and development plans.

## Technology

md-easy is an Electron desktop application:

- The frontend uses React and TypeScript.
- Milkdown Crepe provides the WYSIWYG Markdown editor.
- CodeMirror provides the Markdown source editor.
- The TypeScript main process handles native file access, settings, recovery data, printing, and desktop integration.
- Local application data is stored in human-readable or standard formats such as Markdown, TOML, and JSON.
- pnpm applies the fixes in `patches/` to dependencies on install. Each patch explains itself in a comment. The ProseMirror patch keeps a caret key such as End, pressed right after a click into the document view, from being undone on a busy machine.

Electron packages Chromium and Node.js with the app. This gives development and installed builds the same browser runtime at the cost of a larger installer.

## Editing model

Each open document has one canonical Markdown string. The document and source editors are two views of that same content:

- Document view renders and edits formatted Markdown.
- Markdown view exposes the source directly. It parses GitHub Flavored Markdown with a leading YAML frontmatter block, and colors it with VS Code's default Markdown and YAML token colors (Light+ and Dark+).
- Split view shows both and synchronizes changes between them.

If the document view cannot be built for a tab, because Milkdown's create fails (for example when the parser overflows its stack on deeply nested quotes), the tab records the error and shows its Markdown view alone, whatever the window's layout. The layout control shows Markdown while that tab is active, and the window's layout and the `defaultView` setting stay as they are. The notice bar under the tabs explains the fallback and offers Try again. Any other banner, such as a file changed on disk, takes the bar first. Try again, choosing Document or Split, or reloading the file builds the document view again from the tab's current text. A failed create still ends, because md-easy skips Milkdown's destroy for an editor that is still creating. That destroy would otherwise try again every 50 ms forever. The print workspace prints the Markdown version of a document it cannot render.

Building the document view can take a moment, for example while local images are looked up, and the Markdown view on screen stays editable meanwhile. If the text or a document setting changes during the build, md-easy builds the view again from the current text and settings before it shows it. So the document view never shows older text, and its edits always reach the tab. If the text changes during each of five builds in a row, md-easy stops and shows the tab's Markdown view with the notice, as for a failed create.

Opening a document never changes its text. The document view reports the exact source it was given until the user edits the body there, and an edit there writes the body in Milkdown's Markdown style.

The document view shows the YAML frontmatter in an editable table above the editor. The table writes back only the lines it changes. Each change to the block is a step in the editor's undo history, so undo and redo move through table and body edits in one order. A split mirror sync records the block and the blank lines after it with the body, so its undo restores all three.

Each tab owns its own document state, including its path, content, save status, and line-ending style. The save status compares the content with the text last read from or written to the file, or with the starting text of a document that has no file. A recovered snapshot counts as unsaved until it is saved, because the file may have changed since. While a save is being written, any edit counts as unsaved, because the file may hold either text. When the save finishes, the document stays unsaved if its text or line-ending style changed while it was written, and a change on disk recorded in the meantime with a later time stays the file's text. The active tab is bound to the visible editor views.

Milkdown and CodeMirror manage their own editor DOM and lifecycles. React owns the surrounding application interface, including tabs, toolbars, dialogs, settings, recent files, and print views.

## Interface design

The interface follows the look of [Mervin PDF](https://github.com/lincarl/mervin-pdf). Dark mode uses Mervin's "Nord" chrome and light mode its "Cool slate" chrome.

- `src/styles/app.css` defines the chrome tokens (surfaces from the input well to the floating popover, inks, translucent edges and washes, the accent) for both themes and exposes them to Tailwind as colors such as `bg-well`, `text-ink-soft` and `border-line-push`.
- The primitives in `src/components/ui` (buttons, fields, check boxes, dialogs, menus, tooltips) carry Mervin's control styles, so surfaces compose them instead of restyling controls.
- Chrome icons are Lucide icons drawn at a 1px line weight.
- The document surface has its own light and dark palette, independent of the chrome theme. Find highlights use the same classes in the Document and Markdown views. The frontmatter table is outside the document editor, so its matches are CSS custom highlights with the same names and colors.

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

The built frontend carries a Content Security Policy, defined in `vite.config.ts`. It blocks inline scripts, eval and scripts from the web, and allows images from the web, data and blob URLs, and local files. The development server goes without it. A feature that needs a new kind of resource, such as a frame or a web font, must add it to the policy.

## Data and persistence

User documents remain standard Markdown files. md-easy does not use a proprietary document format.

Application preferences are stored in `settings.toml`. Recent-file history and recovery snapshots are stored separately in the application's local data directory. File writes are performed atomically where practical to reduce the chance of corruption.

Settings saves use TOML syntax-tree ranges to update complete root values and insert missing settings before the first table. Quoted keys, surrounding comments, unknown data, a leading BOM, and existing line endings are preserved. Settings reads reject invalid UTF-8 rather than replacing bytes, and loading failures use defaults without changing the file. Before writing, the app checks that the result parses and contains exactly the requested settings plus the original unknown values. Invalid UTF-8, invalid TOML, or known settings expressed as dotted keys or table declarations remain untouched, and the app reports that saving failed. Known settings must use root key-value assignments.

Images can either live inside Markdown as data URIs or as files in a configurable attachments directory. Relative paths are used for attachment links so a document and its attachments can be moved together.

Attachment writes stage complete bytes in a sibling temporary file before publication. On filesystems with hard links, publication atomically claims a free name. FAT and exFAT use serialized application writes, a fresh name check, and atomic rename instead. That fallback preserves support for these filesystems, but another process creating the same name between the check and rename can have its file replaced.

## Desktop integration

Electron provides native windows, file associations, single-instance behavior, native open/save dialogs, opening links and folders, system appearance settings, and printing. Linux builds provide AppImage and DEB installers. Windows builds provide NSIS and MSI installers.

Undo and Redo in the native menus (the spell-check menu that Shift+right-click opens, and the macOS Edit menu) go to the renderer, which runs the focused editor's undo history. Chromium's own undo knows nothing of those histories. A plain text field, such as the find card's, keeps Chromium's undo.

The print workspace mounts a rendered copy of the document in the app window. Electron prints that document using the selected printer or writes a PDF. Printing waits for the workspace to finish rendering before starting the job. md-easy lays out the sheets itself and breaks pages between blocks. A table, list, or code block taller than a page continues on the next page, and so does a line of the Markdown version, split between the lines it wraps onto.

The frontend can also run in a browser-backed development environment with platform operations represented by adapters. This allows most interface and editing behavior to be tested independently of the desktop shell.

## Design priorities

- Keep Markdown portable and directly editable.
- Make the formatted document view the default without hiding the source.
- Avoid content loss when switching views, tabs, or application sessions.
- Keep native capabilities behind focused backend services.
- Prefer a small, responsive desktop application over a broad workspace platform.
