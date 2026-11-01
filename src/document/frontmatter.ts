// YAML frontmatter split/join (spec §5.17).
//
// Only a `---` delimited block at the very START of the document is treated as
// frontmatter; a `---` anywhere else stays a horizontal rule. The split is
// byte-lossless: joinFrontmatter(splitFrontmatter(md)) === md, so round-tripping
// through the frontmatter table never alters the file. The blank lines between
// the block and the body are split off too, because the document view drops
// leading blank lines from the body it is given.
//
// Operates on LF-normalized text (the canonical in-memory form).

export interface FrontmatterSplit {
  /** The full leading block INCLUDING both `---` delimiters and the newline
   *  after the closing delimiter (missing only when the block ends the file), or
   *  null when there is no frontmatter. */
  frontmatter: string | null;
  /** The blank or whitespace-only lines right after the block, kept verbatim.
   *  Always "" when there is no frontmatter. */
  separator: string;
  /** Everything after the separator (the document body). */
  body: string;
}

// Opening `---` line, optional YAML content, then a closing `---` or `...` line.
// The closing delimiter is always anchored to a line start because the preceding
// segment ends in a newline. Lazy matching picks the FIRST closing delimiter.
const FRONTMATTER_RE = /^---[ \t]*\n([\s\S]*?\n)?(---|\.\.\.)[ \t]*(\n|$)/;
// Whole blank lines only, so an indented first body line keeps its indent.
const SEPARATOR_RE = /^(?:[ \t]*\n)*/;

/** Split a leading frontmatter block and the blank lines after it from the body. */
export function splitFrontmatter(markdown: string): FrontmatterSplit {
  const match = FRONTMATTER_RE.exec(markdown);
  if (!match) return { frontmatter: null, separator: "", body: markdown };
  const frontmatter = match[0];
  const rest = markdown.slice(frontmatter.length);
  const separator = SEPARATOR_RE.exec(rest)![0];
  return { frontmatter, separator, body: rest.slice(separator.length) };
}

/** Rebuild the document from its parts. A block that ends the file may have no
 *  newline after its closing line. Text added after it later then starts a new
 *  line instead of running onto that line and breaking the frontmatter. */
export function joinFrontmatter({ frontmatter, separator, body }: FrontmatterSplit): string {
  if (frontmatter == null) return body;
  const rest = separator + body;
  const newline = rest !== "" && !frontmatter.endsWith("\n") ? "\n" : "";
  return frontmatter + newline + rest;
}
