// Editable key/value view of YAML frontmatter (spec §5.17), modeled on VS Code's
// Markdown-preview frontmatter table but fully editable: one row per key, with
// nested mappings shown as an indented group of sub-rows. Supports editing keys
// and values, adding fields (top-level or under a mapping), and deleting them.
//
// The YAML text stays the source of truth. The opening/closing `---` (or `...`)
// delimiter lines and the trailing-newline state are kept VERBATIM. A value/key
// edit rewrites only that one line; add/delete splice whole lines. So an unedited
// open→save round-trips byte-for-byte, and any edit only touches the line(s) it
// must. To stay safe and lossless, only two shapes are made editable: plain
// scalars (`key: value`, at the top level or one level of nesting) and mappings
// of such scalars. Anything else (block lists, deeper nesting, multi-line
// scalars) is shown read-only as dedented code and preserved untouched.
//
// Operates on the LF-normalized frontmatter block produced by splitFrontmatter.

/** A single editable scalar line: `<indent><key>:<sep><value>`. */
export interface FmScalar {
  kind: "scalar";
  /** 0 = top-level, 1 = nested under a mapping (for indentation). */
  depth: number;
  indent: string;
  key: string;
  sep: string;
  value: string;
  lineIndex: number;
}

/** A mapping header (`key:`) whose children are all editable scalars. */
export interface FmGroup {
  kind: "group";
  depth: 0;
  indent: string;
  key: string;
  sep: string;
  /** Line index of the `key:` header. */
  headerIndex: number;
  /** Exclusive end of the block (header + children, trailing blanks trimmed). */
  blockEnd: number;
  /** Leading whitespace to give a newly added child. */
  childIndent: string;
  children: FmScalar[];
}

/** A read-only block (list / deeper nesting / unparsed) shown as dedented code. */
export interface FmRaw {
  kind: "raw";
  depth: number;
  key: string;
  display: string;
  blockStart: number;
  blockEnd: number;
}

export type FmField = FmScalar | FmGroup | FmRaw;

export interface FrontmatterTable {
  fields: FmField[];
  /** The inner YAML split into lines — the substrate joined back on save. */
  lines: string[];
  openLine: string;
  closeLine: string;
  trailingNewline: boolean;
  /** Raw inner YAML, used as a read-only fallback when no fields are parsed. */
  raw: string;
}

// A key line: first non-space char is not `#` (comment) or `:`. Lazy `*?` so
// `home: http://x` splits at the FIRST colon. A leading `-` IS allowed (e.g. the
// key `-x`); genuine block-list items are excluded separately via LIST_ITEM_RE,
// since a list item is a `-` followed by whitespace/end, not by key text.
const KEY_RE = /^([ \t]*)([^\s#:][^:]*?):([ \t]*)(.*)$/;
const LIST_ITEM_RE = /^[ \t]*-(\s|$)/;

const isBlank = (l: string): boolean => l.trim() === "";
const isComment = (l: string): boolean => /^[ \t]*#/.test(l);
const indentLen = (l: string): number => /^[ \t]*/.exec(l)![0].length;
/** A line that is an editable `key: value` (not a list item). */
const isKeyLine = (l: string): boolean => !LIST_ITEM_RE.test(l) && KEY_RE.test(l);
/** A `key: value` at the top level (no indentation). */
const isTopLevelKey = (l: string): boolean => isKeyLine(l) && indentLen(l) === 0;

/** Whether a key typed into the table can be written back without changing how the
 *  YAML line re-parses: non-empty, no colon (would split the line), and not a
 *  comment/list marker. Leading/trailing whitespace is trimmed off first. */
export function isValidEditableKey(key: string): boolean {
  const k = key.trim();
  return k.length > 0 && !k.includes(":") && !k.startsWith("#") && !LIST_ITEM_RE.test(k);
}

/** Parse a frontmatter block into an editable table model. */
export function parseFrontmatterTable(frontmatter: string): FrontmatterTable {
  const trailingNewline = frontmatter.endsWith("\n");
  const core = trailingNewline ? frontmatter.slice(0, -1) : frontmatter;
  const allLines = core.split("\n");
  const openLine = allLines[0] ?? "---";
  const closeLine = allLines.length > 1 ? allLines[allLines.length - 1] : "---";
  const lines = allLines.slice(1, Math.max(1, allLines.length - 1));
  const raw = lines.length ? `${lines.join("\n")}\n` : "";

  return { fields: parseFields(lines), lines, openLine, closeLine, trailingNewline, raw };
}

function parseFields(lines: string[]): FmField[] {
  const fields: FmField[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line) || isComment(line)) {
      i++;
      continue;
    }
    if (!isTopLevelKey(line)) {
      // A top-level line that isn't a `key:` (e.g. a list item) — collect the
      // contiguous run as a read-only raw block.
      const start = i;
      i++;
      while (i < lines.length && !isBlank(lines[i]) && !isTopLevelKey(lines[i])) {
        i++;
      }
      fields.push(rawField(lines, start, i, ""));
      continue;
    }

    const [, indent, key, sep, value] = KEY_RE.exec(line)!;
    // Find the block: following blank/indented lines, with trailing blanks trimmed.
    let j = i + 1;
    while (j < lines.length && (isBlank(lines[j]) || indentLen(lines[j]) > 0)) j++;
    let blockEnd = j;
    while (blockEnd > i + 1 && isBlank(lines[blockEnd - 1])) blockEnd--;

    // Comment lines inside a block are kept verbatim in `lines` but don't become
    // rows, and (unlike before) don't force the whole mapping to read-only.
    const childIdx: number[] = [];
    for (let k = i + 1; k < blockEnd; k++) {
      if (!isBlank(lines[k]) && !isComment(lines[k])) childIdx.push(k);
    }

    if (childIdx.length === 0) {
      // Plain scalar (value may be empty).
      fields.push({ kind: "scalar", depth: 0, indent, key: key.trim(), sep, value, lineIndex: i });
    } else if (value === "" && childrenAreFlatMapping(lines, childIdx)) {
      // Mapping of editable scalars.
      const children: FmScalar[] = childIdx.map((k) => {
        const cm = KEY_RE.exec(lines[k])!;
        return { kind: "scalar", depth: 1, indent: cm[1], key: cm[2].trim(), sep: cm[3], value: cm[4], lineIndex: k };
      });
      fields.push({
        kind: "group",
        depth: 0,
        indent,
        key: key.trim(),
        sep,
        headerIndex: i,
        blockEnd,
        childIndent: /^[ \t]*/.exec(lines[childIdx[0]])![0],
        children,
      });
    } else {
      // Inline value with children, a list, deeper nesting, etc. — read-only.
      fields.push(rawField(lines, i, blockEnd, key.trim()));
    }
    i = j;
  }
  return fields;
}

/** Children form an editable mapping iff every (comment-free) child is itself a
 *  `key: value` line at one shared indent (no grandchildren / lists). */
function childrenAreFlatMapping(lines: string[], childIdx: number[]): boolean {
  const indents = childIdx.map((k) => indentLen(lines[k]));
  const flat = indents.every((n) => n === indents[0]);
  return flat && childIdx.every((k) => isKeyLine(lines[k]));
}

function rawField(lines: string[], start: number, end: number, key: string): FmRaw {
  const block = lines.slice(start, end);
  return { kind: "raw", depth: 0, key, display: dedent(stripTrailingBlanks(block)).join("\n"), blockStart: start, blockEnd: end };
}

/** Reassemble a frontmatter block from its (possibly edited) inner lines, reusing
 *  the original delimiter lines and trailing-newline state so an unedited
 *  round-trip is byte-identical. */
export function rebuildFrontmatter(table: FrontmatterTable): string {
  const body = table.lines.length ? `${table.lines.join("\n")}\n` : "";
  return `${table.openLine}\n${body}${table.closeLine}${table.trailingNewline ? "\n" : ""}`;
}

/** Rewrite a scalar's line from its current parts (after a key or value change)
 *  and return the rebuilt block. Only that one line changes. */
export function rewriteScalar(table: FrontmatterTable, field: FmScalar): string {
  table.lines[field.lineIndex] = `${field.indent}${field.key}:${field.sep}${field.value}`;
  return rebuildFrontmatter(table);
}

/** Rewrite a mapping header's key line (rename the mapping). */
export function rewriteGroupKey(table: FrontmatterTable, group: FmGroup): string {
  table.lines[group.headerIndex] = `${group.indent}${group.key}:${group.sep}`;
  return rebuildFrontmatter(table);
}

/** Append a new top-level `key: value` line. Returns the block and the index of
 *  the inserted line (for focusing it after a re-render). */
export function addTopLevelField(
  table: FrontmatterTable,
  key: string,
  value: string,
): { block: string; lineIndex: number } {
  table.lines.push(`${key}: ${value}`);
  return { block: rebuildFrontmatter(table), lineIndex: table.lines.length - 1 };
}

/** Insert a new `<indent><key>: <value>` line AT the given inner-line index — the
 *  line currently there (and everything after it) shifts down. Used both for the
 *  between-row inserts (insert at a row's own line index, i.e. just above it) and
 *  for adding to a mapping (insert at the mapping's `blockEnd`). The caller passes
 *  the indent that keeps the new line in scope: "" for a top-level field, or the
 *  mapping's child indent for a field inside a group (so it stays a sibling of that
 *  group's children rather than escaping to the top level). `atLineIndex` past the
 *  end appends. Returns the rebuilt block and the inserted line's index (to focus). */
export function insertFieldAt(
  table: FrontmatterTable,
  atLineIndex: number,
  indent: string,
  key: string,
  value: string,
): { block: string; lineIndex: number } {
  const at = Math.max(0, Math.min(atLineIndex, table.lines.length));
  table.lines.splice(at, 0, `${indent}${key}: ${value}`);
  return { block: rebuildFrontmatter(table), lineIndex: at };
}

/** Remove the line(s) a field occupies and return the rebuilt block. Also drops
 *  the blank separator line(s) that immediately followed the field, so deleting a
 *  block doesn't strand the blank that belonged to it. */
export function deleteField(table: FrontmatterTable, field: FmField): string {
  const [start, end] = fieldLineRange(field);
  table.lines.splice(start, end - start);
  while (start < table.lines.length && isBlank(table.lines[start])) {
    table.lines.splice(start, 1);
  }
  return rebuildFrontmatter(table);
}

function fieldLineRange(field: FmField): [number, number] {
  switch (field.kind) {
    case "scalar":
      return [field.lineIndex, field.lineIndex + 1];
    case "group":
      return [field.headerIndex, field.blockEnd];
    case "raw":
      return [field.blockStart, field.blockEnd];
  }
}

/** Drop trailing blank/whitespace-only lines (e.g. the split's trailing ""). */
function stripTrailingBlanks(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return lines.slice(0, end);
}

/** Remove the common leading-whitespace prefix from non-blank lines, so a nested
 *  block reads cleanly (`  type: feedback` → `type: feedback`). Display-only. */
function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim() !== "").map((l) => indentLen(l));
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min));
}
