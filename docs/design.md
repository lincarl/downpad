# md-easy — Design Overview

This document describes the main design of md-easy. It intentionally omits internal API listings, historical migration notes, and development plans.

## Technology

md-easy is a Tauri 2 desktop application:

- The frontend uses React and TypeScript.
- Milkdown Crepe provides the WYSIWYG Markdown editor.
- CodeMirror provides the Markdown source editor.
- The Rust backend handles native file access, settings, recovery data, printing, and Windows integration.
- Local application data is stored in human-readable or standard formats such as Markdown, TOML, and JSON.

This structure keeps the installer and runtime lightweight while supporting native desktop behavior.

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

The Rust backend provides operations that require native access. File reads and writes, attachment storage, recovery snapshots, recent-file data, and settings persistence are kept outside the webview.

## Data and persistence

User documents remain standard Markdown files. md-easy does not use a proprietary document format.

Application preferences are stored in `settings.toml`. Recent-file history and recovery snapshots are stored separately in the application's local data directory. File writes are performed atomically where practical to reduce the chance of corruption.

Images can either live inside Markdown as data URIs or as files in a configurable attachments directory. Relative paths are used for attachment links so a document and its attachments can be moved together.

## Desktop integration

The Tauri shell provides native windows and access to Windows features. md-easy supports file associations, single-instance behavior, native open/save dialogs, opening links and folders, system appearance settings, and printing.

The frontend can also run in a browser-backed development environment with platform operations represented by adapters. This allows most interface and editing behavior to be tested independently of the desktop shell.

## Design priorities

- Keep Markdown portable and directly editable.
- Make the formatted document view the default without hiding the source.
- Avoid content loss when switching views, tabs, or application sessions.
- Keep native capabilities behind focused backend services.
- Prefer a small, responsive desktop application over a broad workspace platform.
