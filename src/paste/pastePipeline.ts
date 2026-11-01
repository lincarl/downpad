// Smart-paste format resolution (spec §5.4). The clipboard is reduced to a
// `ClipboardSnapshot`, then `resolvePaste` picks an action by the spec's
// priority order: markdown-looking plain text > HTML > plain text > image.
// An image goes in only when the clipboard holds no text or HTML.
//
// The DOM extraction (`snapshotFromDataTransfer`) and the pure decision
// (`resolvePaste`) are split so the priority logic is unit-testable without a
// real DataTransfer; the HTML→markdown converter is injected for the same reason.

import { looksLikeMarkdown } from "./markdownHeuristic";
import { htmlToMarkdown as defaultHtmlToMarkdown } from "./htmlToMarkdown";

export type PasteAction =
  | { kind: "image"; file: File }
  | { kind: "markdown"; md: string }
  | { kind: "text"; text: string }
  | { kind: "empty" };

export interface ClipboardSnapshot {
  /** text/html payload, or "" if absent. */
  html: string;
  /** text/plain payload, or "" if absent. */
  text: string;
  /** First image/* file on the clipboard, or null. */
  imageFile: File | null;
}

/** True if `html` contains at least one real element tag (not just text). */
function isRealHtml(html: string): boolean {
  return /<[a-z][\s\S]*>/i.test(html);
}

/**
 * Pick a paste action by the §5.4 priority order. `htmlToMarkdown` is injectable
 * (defaults to the Turndown-backed converter) so this stays unit-testable.
 */
export function resolvePaste(
  s: ClipboardSnapshot,
  htmlToMarkdown: (html: string) => string = defaultHtmlToMarkdown,
): PasteAction {
  // 1. Markdown source wins over a code editor's syntax-highlighted HTML.
  if (s.text && looksLikeMarkdown(s.text)) return { kind: "markdown", md: s.text };

  // 2. Rich HTML → markdown (the Excel / Sheets / Notion table path).
  if (s.html && isRealHtml(s.html)) {
    const md = htmlToMarkdown(s.html);
    if (md) return { kind: "markdown", md };
  }

  // 3. Plain text → literal paragraph.
  if (s.text) return { kind: "text", text: s.text };

  // 4. An image, such as a screenshot, alone on the clipboard. Text or HTML
  // copied with it, as from a web page, goes in instead.
  if (s.imageFile && !s.html) return { kind: "image", file: s.imageFile };

  return { kind: "empty" };
}

/** Build a snapshot from a paste/drop DataTransfer (runtime; not unit-tested). */
export function snapshotFromDataTransfer(dt: DataTransfer): ClipboardSnapshot {
  return {
    html: dt.getData("text/html") ?? "",
    text: dt.getData("text/plain") ?? "",
    imageFile: firstImageFile(dt),
  };
}

/** First image/* file from a DataTransfer's files or items, else null. */
export function firstImageFile(dt: DataTransfer): File | null {
  for (const file of Array.from(dt.files ?? [])) {
    if (file.type.startsWith("image/")) return file;
  }
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}
