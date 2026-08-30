# md-easy — Product Specification

md-easy is a lightweight desktop Markdown editor for Windows. It is designed for people who want to read and edit Markdown as a formatted document while retaining direct access to the source when needed.

## Core experience

- Edit Markdown in a clean WYSIWYG document view.
- Switch between Document, Markdown, and side-by-side Split views.
- Keep the rendered document and Markdown source synchronized.
- Work with multiple documents in tabs.
- Open, create, save, and print Markdown files using familiar desktop controls and shortcuts.
- Find and replace text within the active document.

## Markdown support

The editor supports common Markdown and GitHub Flavored Markdown features, including:

- Headings, paragraphs, emphasis, links, and block quotes.
- Ordered, unordered, and task lists.
- Tables, horizontal rules, inline code, and fenced code blocks.
- Syntax highlighting for code blocks.
- Inline and block math rendered with KaTeX.
- Mermaid diagrams rendered from fenced `mermaid` blocks.
- YAML frontmatter, editable from the document view or as source.

## Files and attachments

Markdown files can be opened through the file picker, recent-files view, drag and drop, or Windows file association. The app preserves the document's line-ending style and warns before unsaved work is lost.

Images can be pasted or dropped into a document. They may be embedded as base64 data or stored in an attachments folder beside the Markdown file. Other dropped files are copied to the attachments folder and inserted as links.

Local Markdown links can open their targets in another tab. External links open in the default browser.

## Paste behavior

md-easy adapts pasted content to the document:

- Images are inserted and stored according to the image settings.
- Rich HTML from browsers and compatible applications is converted to Markdown.
- Markdown-looking plain text is inserted as Markdown.
- Pasting a URL over selected text creates a link.

## Recent files and recovery

The Recent view provides quick access to previously opened documents and favorites. It supports filtering by filename and searching within recent documents.

The app periodically stores recovery snapshots for unsaved work and offers to restore them after an interrupted session. Optional autosave can save changes to files that already have a path.

## Appearance and preferences

Users can choose light, dark, or system themes; adjust the accent color, document width, font, and text size; select the default editor view; and configure image storage, Markdown serialization, spell checking, recovery, and autosave behavior.

Settings are stored locally and can be changed from the app or by editing the settings file.

## Platform and scope

md-easy is a local, single-user Windows 11 application. Documents remain ordinary Markdown files on disk. The app does not provide cloud sync, real-time collaboration, mobile clients, or a plugin system.
