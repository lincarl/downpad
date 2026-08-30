// Converts pasted `text/html` to markdown (spec §5.4, step 2). This is the path
// that makes Excel / Google Sheets / Notion tables paste as GFM tables: those
// apps put a structured `<table>` on the clipboard, and Turndown + the GFM
// plugin turn it into `| … | … |` with a separator row.
//
// Uses @joplin/turndown-plugin-gfm (the maintained fork; the original
// turndown-plugin-gfm is abandoned — design.md §1.3).

import TurndownService from "turndown";
import { gfm } from "@joplin/turndown-plugin-gfm";

// One shared service; configured to match our serializer defaults (spec §5.16):
// ATX headings, `-` bullets, `**` bold, `*` italic, fenced code.
function createService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  service.use(gfm);
  return service;
}

let service: TurndownService | null = null;

/** Convert an HTML fragment to markdown. Returns "" for empty/whitespace input. */
export function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return "";
  service ??= createService();
  return service.turndown(html).trim();
}
