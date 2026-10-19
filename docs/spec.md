# md-easy product specification

md-easy is a desktop Markdown editor for Windows and Linux. It is designed for people who want to read and edit Markdown as a formatted document while retaining direct access to the source when needed.

## Core experience

- Edit Markdown in a clean WYSIWYG document view.
- Switch between Document, Markdown, and side-by-side Split views. If the Document view cannot show a file, for example one with thousands of nested quotes, that tab opens in the Markdown view and the notice bar under the tabs says why. Try again shows the Document view once the text allows it, for example after a fix in the Markdown view. Other tabs keep the chosen view, and printing such a file prints its Markdown.
- Keep the rendered document and Markdown source synchronized, including edits made in the Markdown view while the Document view opens.
- Work with multiple documents in tabs.
- Open, create, save, and print Markdown files using familiar desktop controls and shortcuts. Printed Markdown source continues a line too long for one page on the next page.
- Find and replace text within the active document from a find card that opens over the bottom right of the page. In the document view this includes the keys and values in the frontmatter table. YAML that the table shows read-only, such as a list, is found but not replaced. One undo takes back a Replace all in both the table and the document. Find scrolls each match it moves to into view, clear of the card.

## Markdown support

The editor supports common Markdown and GitHub Flavored Markdown features, including:

- Headings, paragraphs, emphasis, links, and block quotes.
- Ordered, unordered, and task lists.
- Tables, horizontal rules, inline code, and fenced code blocks. A fence keeps the options after its language, such as `title="server.js"`, and a `latex` fence stays a fence rather than becoming a math block.
- Syntax highlighting for code blocks, and VS Code's Markdown colors in the Markdown view.
- Inline and block math rendered with KaTeX.
- Mermaid diagrams rendered from fenced `mermaid` blocks.
- YAML frontmatter, editable from the document view or as source. In the document view, edits in the frontmatter table and in the document share one undo history, so undo and redo go through them in the order they were made.

## Files and attachments

Markdown files can be opened through the file picker, recent-files view, drag and drop, command-line paths, or desktop file associations. The app preserves the document's line-ending style and warns before unsaved work is lost. Opening, copying or saving a file without edits keeps its exact text. A document counts as unsaved while its text differs from the file, so undoing every edit marks it saved again. While a save is still being written, and for a recovered snapshot until it is saved, the document stays unsaved.

Images can be pasted or dropped into a document. They may be embedded as base64 data or stored in an attachments folder beside the Markdown file. Other dropped files are copied to the attachments folder and inserted as links. Find and replace cannot damage an embedded image. The document view does not search image sources, and the Markdown view skips the base64 data of every `data:` URI, including one written as text in a code sample.

An image keeps its alt text and title when the document is saved. An image on its own line can be resized in the document view, but plain Markdown has no place for the size, so the size is not saved.

When the document view cannot load an image, such as a local file that was moved or deleted, it shows the image's path in its place. An image on its own line becomes a placeholder that reads "Missing image. Click to locate it." above the path. An image inside a line of text becomes a small chip with the path, and its hover text reads the same words. A click on either opens a file dialog, and the image's path in the Markdown becomes the chosen file's path. A file chosen at the path the image already has, such as one that was put back, shows without a change to the Markdown, the undo history or the unsaved mark. Only a plain click locates the file. Ctrl or Cmd+click on a chip inside a link opens the link instead, Shift+click on a chip extends the selection to it, and other clicks with Ctrl, Cmd, Shift or Alt held open nothing. The placeholder and the chip never change the Markdown or the saved file. Print shows a missing image's alt text.

Local Markdown links can open their targets in another tab. External links open in the default browser. Ctrl or Cmd+click on an image inside a line of text opens the image's own link, and a double-click opens it when it points to a Markdown file. Both halves of the image count, so a link right after the image never opens instead, and an image without a link opens nothing.

## Paste behavior

md-easy adapts pasted content to the document:

- Images are inserted and stored according to the image settings.
- Rich HTML from browsers and compatible applications is converted to Markdown.
- Markdown-looking plain text is inserted as Markdown.
- Pasting a URL over selected text creates a link.

## Keyboard

In the document view, Tab and Shift+Tab indent and outdent list items, move between table cells, and indent and outdent code in code blocks. In a list or table they stay in the document even where there is nothing to indent or no next cell. Elsewhere they move focus to the next or previous control outside the document, as in the Markdown view, and never type spaces. They also stay in the document while the block menu that "/" opens is showing. Esc closes that menu, and so does moving focus elsewhere in the window, such as with a click on the toolbar. Esc, then Tab or Shift+Tab within two seconds, leaves the document from anywhere in it. In a code block, Esc then Tab first moves to the block's language and Copy buttons, and Tab from the last of them leaves the document.

In the document view, End moves the caret to the end of a line that starts with an image, in a paragraph, a list item, a heading or a table cell and after a line break, and Shift+End selects to there. After a line break that selection also takes in the line break, since Chromium extends any selection that starts right after a line break and before an image over the break.

## Recent files and recovery

The Recent view lists previously opened documents, with starred favorites pinned at the top. Its search field finds documents by file name, by content, or both.

The app periodically stores recovery snapshots for unsaved work and offers to restore them after an interrupted session. Optional autosave can save changes to files that already have a path.

## Appearance and preferences

The interface shares the look of Mervin PDF. Users can choose light, dark, or system themes; adjust the accent color, document width, font, and text size; select the default editor view; and configure image storage, Markdown serialization, spell checking, recovery, and autosave behavior.

Settings are stored locally in `settings.toml` and can be changed from the app or by editing the settings file.

If the file contains invalid TOML, the app uses defaults for the session and preserves the original file. Settings changes apply in memory, but saving them requires repairing the file's syntax first.

## Platform and scope

md-easy is a local, single-user Electron application for Windows and Linux. Documents remain ordinary Markdown files on disk. The app does not provide cloud sync, real-time collaboration, mobile clients, or a plugin system.
