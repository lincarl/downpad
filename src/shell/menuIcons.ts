// Lucide component icons shared by the React context-menu rows. Each row owns
// the accessible label, so the glyphs render aria-hidden in ContextMenu.
import {
  ClipboardPaste,
  ClipboardType,
  Copy,
  FileCode2,
  Link,
  Printer,
  Scissors,
  TextSelect,
} from "lucide-react";

export const MENU_ICONS = {
  cut: Scissors,
  copy: Copy,
  paste: ClipboardPaste,
  pastePlain: ClipboardType,
  selectAll: TextSelect,
  link: Link,
  markdown: FileCode2,
  print: Printer,
} as const;
