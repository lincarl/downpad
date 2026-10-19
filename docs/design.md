# md-easy design

This document describes the main design of md-easy. It intentionally omits internal API listings, historical migration notes, and development plans.

## Technology

md-easy is an Electron desktop application:

- The frontend uses React and TypeScript.
- Milkdown Crepe provides the WYSIWYG Markdown editor.
- CodeMirror provides the Markdown source editor.
- The TypeScript main process handles native file access, settings, recovery data, printing, and desktop integration.
- Local application data is stored in human-readable or standard formats such as Markdown, TOML, and JSON.
- pnpm applies the fixes in `patches/` to dependencies on install. Each patch explains itself in a comment. The ProseMirror patch keeps a caret key such as End, pressed right after a click into the document view, from being undone on a busy machine. The Milkdown components patch keeps text typed right after Tab, Shift+Tab, Enter, undo or redo in a list where it was typed. Each of these redraws a list item, which puts back the caret it saw then once the next frame comes. On a busy machine that frame can come after keys typed meanwhile, and the caret jumped back into them, so a key, click or edit before the frame now cancels it.

Electron packages Chromium and Node.js with the app. This gives development and installed builds the same browser runtime at the cost of a larger installer.

## Editing model

Each open document has one canonical Markdown string. The document and source editors are two views of that same content:

- Document view renders and edits formatted Markdown.
- Markdown view exposes the source directly. It parses GitHub Flavored Markdown with a leading YAML frontmatter block, and colors it with VS Code's default Markdown and YAML token colors (Light+ and Dark+).
- Split view shows both and synchronizes changes between them.

If the document view cannot be built for a tab, because Milkdown's create fails (for example when the parser overflows its stack on deeply nested quotes), the tab records the error and shows its Markdown view alone, whatever the window's layout. The layout control shows Markdown while that tab is active, and the window's layout and the `defaultView` setting stay as they are. The notice bar under the tabs explains the fallback and offers Try again. Any other banner, such as a file changed on disk, takes the bar first. Try again, choosing Document or Split, or reloading the file builds the document view again from the tab's current text. A failed create still ends, because md-easy skips Milkdown's destroy for an editor that is still creating. That destroy would otherwise try again every 50 ms forever. The print workspace prints the Markdown version of a document it cannot render.

Building the document view can take a moment, for example while local images are looked up, and the Markdown view on screen stays editable meanwhile. If the text or a document setting changes during the build, md-easy builds the view again from the current text and settings before it shows it. So the document view never shows older text, and its edits always reach the tab. If the text changes during each of five builds in a row, md-easy stops and shows the tab's Markdown view with the notice, as for a failed create.

Reloading a file from disk, or opening a file in place of an empty Untitled tab, replaces the tab's text. While the document view is built for the new text, the Markdown view on screen still holds the old text, so md-easy ignores typing there until that view is built again too. That typing would otherwise write the old text back over the new. Each view is built again from the new text when it is next shown. Its undo history starts there, and the document view looks its images up again, so an image that has appeared on disk shows. md-easy drops a split mirror of an edit made before the new text arrived. That mirror would copy the new text into a view built before it and count that view as up to date, with its undo history and image answers from before.

md-easy changes the views one step at a time, such as a tab switch, a layout switch or a reload. A tab switch, an open, a reload or a layout choice that comes while another step still builds a view waits for that step, and md-easy then shows the active tab again, in the layout the layout control shows. So the window never keeps showing another tab's Markdown view, where typing would be ignored, and a view built from the text before a reload is built again from the new text. A layout or a tab chosen while a layout switch, Try again or a tab switch still runs is ignored, and the layout control and the tabs stay as they were. A layout switch or a tab switch that waits for another step counts as running until md-easy shows the active tab. So once a layout is chosen during a reload, another layout or a tab chosen before the document shows is ignored.

Opening a document never changes its text. The document view reports the exact source it was given until the user edits the body there. An edit there writes only the top-level blocks it changed in Milkdown's Markdown style. Every other block keeps its source text. Two blocks that were neighbours in the source keep the blank lines between them. A new join, next to a changed or removed block, keeps the source's line break when the text still reads as the same blocks, and otherwise gets a blank line. Link reference definitions, which the document view does not show, stay while a block that keeps its source text uses them. A definition that nothing in the source used stays as long as any block keeps its source text.

The document view pairs its blocks with the source's blocks. Blocks the user did not touch are the same ProseMirror nodes as when the source was parsed, and the rest pair by how Milkdown writes them. The positions of the source's blocks come from the parse that opened it. Every new join is checked before the text is used. Rules that follow from how the parser ends each kind of block settle most joins without reading anything back, for example a blank line after a paragraph or a closed fence. The other joins are read back with Crepe's parser, in a window that starts where the text above cannot change how it reads and ends with the first lines of the block below. The window must read as exactly its blocks. A block that keeps its source text must read as the same kind of node over the same text and open the same blocks on its first line, such as a quote with a list in it. A changed block must read as the document's block in Milkdown's form, or as that form reads on its own. Each block's text ends on its last line, and the line break after it stays with the blank lines below it. In a file with no line break at its end, a kept block that becomes the last one keeps the line break that followed it, because a tag alone on the last line of a list, quote or footnote reads as part of it only with a line break after it. Where a window reads otherwise, the join at fault gets a blank line and the window is read again. The document view writes the whole body in Milkdown's style when a window still reads otherwise (a new list right below a list, for example), when a changed block held a definition, when a new footnote could turn text in a kept block into a reference, when raw HTML in a changed block holds a line that could be a definition and a kept block has bracketed text it could turn into a link or footnote, when a definition the file keeps could turn bracketed text in a changed block into a link, when indented code could end in another place than in the source, as it can right below a list or quote, when text follows a block that read as it did only at the very end of the file, when the text below a list or footnote that ends in a fence, math block or HTML block the file left open, such as a comment with no `-->` or a `<pre>` with no `</pre>`, would change what that block holds, when the source's blocks do not map one for one onto the document's, or when reading the windows back would take longer than writing the whole body. The same document always gets the same text, whatever was written before it. A split mirror sync makes the synced text the new source and records that with the body in the undo history, so undoing a sync writes the body from before it with that body's own source.

The document view shows the YAML frontmatter in an editable table above the editor. The table writes back only the lines it changes. Each change to the block is a step in the editor's undo history, so undo and redo move through table and body edits in one order. A split mirror sync records the block and the blank lines after it with the body, so its undo restores all three.

Crepe's table view turns a click on a cell's text, or in the space right of it, into a selection of the cell's whole paragraph a frame later, unless the caret is already in that cell. The next keystroke then replaced the cell's text. md-easy replaces that view with a subclass that leaves a press inside the cells to ProseMirror, as in any paragraph, and to prosemirror-tables, which selects cells on a drag across them or out of the table. Crepe's row and column handles sit outside the cells and keep Crepe's handling.

Crepe's view also had ProseMirror draw a table again, with new cells, whenever only the selection or highlights in it changed. In the split, a click in the document pane right after a Markdown edit first brings that pane up to date, which ends a cell selection there. The click then landed on a cell that was gone, placed no caret, and left the focus in neither pane. The subclass updates a table whose content is unchanged in place. It also closes a row or column menu once the selection it acts on is gone, which the redraw used to do.

Each tab owns its own document state, including its path, content, save status, and line-ending style. The save status compares the content with the text last read from or written to the file, or with the starting text of a document that has no file. A recovered snapshot counts as unsaved until it is saved, because the file may have changed since. While a save is being written, any edit counts as unsaved, because the file may hold either text. When the save finishes, the document stays unsaved if its text or line-ending style changed while it was written, and a change on disk recorded in the meantime with a later time stays the file's text. The active tab is bound to the visible editor views.

Milkdown and CodeMirror manage their own editor DOM and lifecycles. React owns the surrounding application interface, including tabs, toolbars, dialogs, settings, recent files, and print views.

The document view marks an image that fails to load on the image's element, and CSS draws the missing-image placeholder or chip from that mark, so it never reaches the document or its Markdown. Crepe reports load errors only for images on their own line, so md-easy catches the errors of inline images itself. After each change to the document a missing image shows its node's current path, and it shows as an image again once one loads there. Crepe's image views look a file up only when ProseMirror passes them their node again, so after the user locates the path an image already has, a node decoration that lasts one transaction makes ProseMirror do that without a change to the document. Chromium paints no text selection over a chip, so a ProseMirror decoration marks the inline images a selection covers and CSS tints those chips.

Chromium's End does not move the caret from before an image or a formula that starts a line. On End the document view first moves the caret past the inline atoms there, such as images and formulas, and Chromium's End goes on from the text after them. Chromium cannot keep the anchor of a selection right after a line break and before such an atom. Each time Shift and a key that moves the caret, such as End or an arrow key, extend the selection there, Chromium moves the anchor before the line break. The document view puts the anchor back when ProseMirror reads the extended selection, and has ProseMirror read it before the next frame, so the line break never shows as selected. It types over a selection that starts or ends there itself instead of leaving the typing to Chromium. It takes the text from the beforeinput event, which carries all of it, such as both halves of an emoji, and which also comes for text put in without a key press. An input method's composition cannot be cancelled, so when one starts over such a selection, the document view first removes the selection and the composition goes on from the caret that leaves. It does that in the capture phase, before Milkdown's own handling of a composition at a caret between two inline nodes, which works only when the caret is there as the composition starts.

## Interface design

The interface follows the look of [Mervin PDF](https://github.com/lincarl/mervin-pdf). Dark mode uses Mervin's "Nord" chrome and light mode its "Cool slate" chrome.

- `src/styles/app.css` defines the chrome tokens (surfaces from the input well to the floating popover, inks, translucent edges and washes, the accent) for both themes and exposes them to Tailwind as colors such as `bg-well`, `text-ink-soft` and `border-line-push`.
- The primitives in `src/components/ui` (buttons, fields, check boxes, dialogs, menus, tooltips) carry Mervin's control styles, so surfaces compose them instead of restyling controls.
- Chrome icons are Lucide icons drawn at a 1px line weight.
- The document page keeps Crepe's 120px side padding while the text column can stay at least 400px wide. In a narrower editor, such as the Split view's document pane in an 800px window or the Document view in a 600px window, the padding gives way, down to 58px on each side. With the 24px the page or the pane adds around the editor, that still holds the block handle, which is 66px wide and sits 16px left of the text. CSS works the padding out from the editor's own width, so it follows the window, the split divider and the page width setting. With the default page width the Document view looks as before in windows 1000px and wider. A fixed page width below 688px narrows the padding in every window, so a 600px page has a 400px text column where it had 312px.
- The document surface has its own light and dark palette, independent of the chrome theme. Find highlights use the same classes in the Document and Markdown views. The frontmatter table is outside the document editor, so its matches are CSS custom highlights with the same names and colors.
- The find card floats over the bottom right of the editor area and grows upward when its replace row opens. Each find step scrolls the current match into view clear of the card, centring it in the part of the page above the card when it was hidden or covered. When the end of a document stops the page short of that, the page gets room below its last line, as tall as the card reaches up into the page plus 12px, until the card closes. Find measures a match that wraps onto more lines by the box around all of its lines, not by its two ends alone.

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

The print workspace mounts a rendered copy of the document in the app window. Electron prints that document using the selected printer or writes a PDF. Printing waits for the workspace to finish rendering before starting the job. md-easy lays out the sheets itself and breaks pages between blocks. A block taller than a page continues on the next page. A paragraph or heading, and a line of the Markdown version, split between the lines they wrap onto, and inline formatting such as bold text or a link carries on across the break. A quote, a footnote, or a list item splits between the blocks it holds, and a table, list, or code block between its rows, items, or lines. What cannot be split, such as an image or a single table row taller than a page, is scaled down to fit the page instead of being cut off.

The frontend can also run in a browser-backed development environment with platform operations represented by adapters. This allows most interface and editing behavior to be tested independently of the desktop shell.

## Design priorities

- Keep Markdown portable and directly editable.
- Make the formatted document view the default without hiding the source.
- Avoid content loss when switching views, tabs, or application sessions.
- Keep native capabilities behind focused backend services.
- Prefer a small, responsive desktop application over a broad workspace platform.
