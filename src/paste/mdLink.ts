// Build CommonMark links/images whose text and destination survive special
// characters. Filenames with spaces or parentheses (e.g. "Q3 report (final).pdf")
// would otherwise break a bare `[text](url)` — the space ends the destination and
// an unescaped `)` closes the link early (spec §5.5/§5.7 link/image insertion).

/** Escape `[`, `]`, and `\` so they don't break the link-text span. */
export function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

/**
 * Render a destination safely. `data:` URIs are emitted bare (they never contain
 * spaces/parens). Anything containing characters that would break a bare
 * destination is wrapped in an angle-bracket destination `<...>`, with any
 * literal `<`/`>` escaped.
 */
export function encodeLinkUrl(url: string): string {
  if (url.startsWith("data:")) return url;
  if (/[ ()<>]/.test(url)) return `<${url.replace(/[<>]/g, (c) => `\\${c}`)}>`;
  return url;
}

export function mdLink(text: string, url: string): string {
  return `[${escapeLinkText(text)}](${encodeLinkUrl(url)})`;
}

/** An image, with a double-quoted title when `title` is set. */
export function mdImage(alt: string, url: string, title = ""): string {
  const quoted = title ? ` "${title.replace(/["\\]/g, (c) => `\\${c}`)}"` : "";
  return `![${escapeLinkText(alt)}](${encodeLinkUrl(url)}${quoted})`;
}
