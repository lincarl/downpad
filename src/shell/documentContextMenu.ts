// The custom right-click menu that replaced the native WebView one (spec §5.14,
// §6.1). One window-level listener serves the whole app: over editable text it
// offers the editing commands (Cut / Copy / Paste / Paste as plain text / Insert
// link / Select all) plus the document actions, and everywhere else in the app
// chrome just the document actions.
//
// Two things deliberately still reach the native menu:
//   • Shift+right-click anywhere. Chromium's spell-check suggestions exist only
//     in its built-in menu and no API exposes them to the page (spec §5.14), so
//     holding Shift is the escape hatch that gets them back.
//   • Any right-click a more specific in-app menu already handled — the image
//     menu (§5.5), the tab strip and the Recent rows all call preventDefault and
//     open their own popup before this bubble-phase listener runs.

import { closeContextMenu, showContextMenu, type MenuItem } from "./contextMenu";
import { MENU_ICONS } from "./menuIcons";
import {
  copy,
  cut,
  editableAt,
  hasSelection,
  paste,
  selectAll,
  selectedText,
  type EditableTarget,
} from "./editorActions";
import { openTextPrompt } from "../components/TextPromptDialog";

export interface DocumentMenuActions {
  /** Whether a document is open — Print / Copy as Markdown are document-scoped. */
  hasDocument: () => boolean;
  /** Open the print workspace (spec §5.21). */
  print: () => void;
  /** Copy the whole document's markdown to the clipboard (§5.10). */
  copyMarkdown: () => void;
  /** Wrap the current document selection in a link, or null when the document
   *  editor isn't the surface being right-clicked. */
  insertLink: (href: string) => boolean;
}

/** Install the app-wide right-click menu and return its effect cleanup. */
export function installDocumentContextMenu(actions: DocumentMenuActions): () => void {
  const onContextMenu = (e: MouseEvent): void => {
    // A more specific in-app menu already handled this click.
    if (e.defaultPrevented) return;
    // Spell-check escape hatch: let the native menu through (§5.14).
    if (e.shiftKey) return;
    e.preventDefault();
    const target = editableAt(e.target as Node | null);
    // Over text the menu holds the editing commands, elsewhere only document actions.
    showContextMenu(e.clientX, e.clientY, buildItems(target, actions), target ? "Edit" : "Document");
  };
  window.addEventListener("contextmenu", onContextMenu);
  return () => {
    window.removeEventListener("contextmenu", onContextMenu);
    closeContextMenu();
  };
}

/** The menu for a right-click at `target` (null = app chrome, no editable). */
export function buildItems(
  target: EditableTarget | null,
  actions: DocumentMenuActions,
): MenuItem[] {
  const hasDoc = actions.hasDocument();
  const documentItems: MenuItem[] = [
    {
      label: "Copy as Markdown",
      icon: MENU_ICONS.markdown,
      disabled: !hasDoc,
      separatorBefore: target !== null,
      run: () => actions.copyMarkdown(),
    },
    {
      label: "Print…",
      icon: MENU_ICONS.print,
      shortcut: "Ctrl+P",
      disabled: !hasDoc,
      run: () => actions.print(),
    },
  ];
  if (!target) return documentItems;

  const selected = hasSelection(target);
  return [
    {
      label: "Cut",
      icon: MENU_ICONS.cut,
      shortcut: "Ctrl+X",
      disabled: !selected,
      run: () => cut(target),
    },
    {
      label: "Copy",
      icon: MENU_ICONS.copy,
      shortcut: "Ctrl+C",
      disabled: !selected,
      run: () => copy(target),
    },
    // Paste stays enabled unconditionally: reading the clipboard to find out
    // whether it holds anything is async, and the menu is built synchronously.
    {
      label: "Paste",
      icon: MENU_ICONS.paste,
      shortcut: "Ctrl+V",
      run: () => paste(target, false),
    },
    {
      label: "Paste as plain text",
      icon: MENU_ICONS.pastePlain,
      shortcut: "Ctrl+Shift+V",
      run: () => paste(target, true),
    },
    {
      label: "Insert link…",
      icon: MENU_ICONS.link,
      separatorBefore: true,
      // Only meaningful over the document editor and only with text selected —
      // the link wraps the selection (§5.6).
      disabled: target.kind !== "wysiwyg" || !selected,
      run: () => promptForLink(target, actions),
    },
    {
      label: "Select all",
      icon: MENU_ICONS.selectAll,
      shortcut: "Ctrl+A",
      run: () => selectAll(target),
    },
    ...documentItems,
  ];
}

/** Ask for a URL and wrap the selection in it. Mirrors the alt-text prompt used
 *  by the image menu (§5.5) rather than introducing a second dialog style. */
async function promptForLink(target: EditableTarget, actions: DocumentMenuActions): Promise<void> {
  const selected = selectedText(target).trim();
  const href = await openTextPrompt({
    title: "Insert link",
    label: selected ? `Link URL for "${selected}"` : "Link URL",
    initialValue: "https://",
    confirmLabel: "Insert",
  });
  if (href === null) return;
  const trimmed = href.trim();
  if (trimmed) actions.insertLink(trimmed);
}
