// Lucide component icons shared by the React context-menu rows. Each row owns
// the accessible label, so the glyphs render aria-hidden in ContextMenu. The
// menu draws them at 16px with Mervin's 1px stroke.
import {
  ClipboardPaste,
  ClipboardType,
  Copy,
  FileCode2,
  ImageUp,
  Link,
  PencilLine,
  Printer,
  Scissors,
  TextSelect,
  Trash2,
} from "lucide-react";
import { FileCopyIcon } from "@/components/icons";

export const MENU_ICONS = {
  cut: Scissors,
  copy: Copy,
  paste: ClipboardPaste,
  pastePlain: ClipboardType,
  selectAll: TextSelect,
  link: Link,
  markdown: FileCode2,
  print: Printer,
  /** Mervin's badged "copy path" glyph: a file with a copy badge. */
  copyPath: FileCopyIcon,
  replaceImage: ImageUp,
  edit: PencilLine,
  delete: Trash2,
} as const;
