// YAML frontmatter split/join (spec §5.17).
//
// Only a `---` delimited block at the very START of the document is treated as
// frontmatter; a `---` anywhere else stays a horizontal rule. The split is
// byte-lossless: joinFrontmatter(splitFrontmatter(md)) === md, so round-tripping
// through the collapsible WYSIWYG block never alters the file.
//
// Operates on LF-normalized text (the canonical in-memory form).

export interface FrontmatterSplit {
  /** The full leading block INCLUDING both `---` delimiters and the trailing
   *  newline after the closing delimiter, or null when there is no frontmatter. */
  frontmatter: string | null;
  /** Everything after the frontmatter block (the document body). */
  body: string;
}

// Opening `---` line, optional YAML content, then a closing `---` or `...` line.
// The closing delimiter is always anchored to a line start because the preceding
// segment ends in a newline. Lazy matching picks the FIRST closing delimiter.
const FRONTMATTER_RE = /^---[ \t]*\n([\s\S]*?\n)?(---|\.\.\.)[ \t]*(\n|$)/;

export function splitFrontmatter(markdown: string): FrontmatterSplit {
  const match = FRONTMATTER_RE.exec(markdown);
  if (!match) return { frontmatter: null, body: markdown };
  const frontmatter = match[0];
  return { frontmatter, body: markdown.slice(frontmatter.length) };
}

export function joinFrontmatter(frontmatter: string | null, body: string): string {
  return frontmatter == null ? body : frontmatter + body;
}

/** Extract just the inner YAML (without delimiters), for editing as raw text. */
export function frontmatterInnerYaml(frontmatter: string): string {
  // Drop the opening `---\n` and the closing delimiter line (+ its newline).
  const withoutOpen = frontmatter.replace(/^---[ \t]*\n/, "");
  return withoutOpen.replace(/(---|\.\.\.)[ \t]*(\n|$)$/, "");
}
