import { parseFrontmatterTable, type FmScalar } from "../document/frontmatterTable";
import { proseWords, type SpellingWord } from "./spelling";

/** A scalar word with source offsets and its location in the metadata table. */
export interface FrontmatterSpellingWord extends SpellingWord {
  cell: { line: number; part: "value"; from: number; to: number };
}

/** Find a conservative string scalar, excluding comments and YAML typed values. */
function stringScalar(value: string): { from: number; text: string } | null {
  let from = 0;
  let to = value.length;
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    let closed = false;
    for (let i = 1; i < value.length; i++) {
      if (quote === '"' && value[i] === "\\") i++;
      else if (quote === "'" && value[i] === "'" && value[i + 1] === "'") i++;
      else if (value[i] === quote) { to = i; closed = true; break; }
    }
    if (!closed || !/^\s*(?:#.*)?$/.test(value.slice(to + 1))) return null;
    from = 1;
  } else {
    to = /(?:^|\s)#/.exec(value)?.index ?? value.length;
    const scalar = value.slice(0, to).trim();
    if (!scalar || /^[\[\]{}&*!|>'"%@`]/.test(scalar) || /:\s/.test(scalar)) return null;
    if (/^(?:null|~|true|false|yes|no|on|off|[-+]?\.(?:inf|nan))$/i.test(scalar)) return null;
    if (/^[-+]?(?:0[xob][\da-f_]+|[\d_]+(?:\.[\d_]*)?(?:e[-+]?[\d_]+)?|\.[\d_]+(?:e[-+]?[\d_]+)?)$/i.test(scalar)) return null;
    if (/^\d{4}-\d{1,2}-\d{1,2}(?:[Tt\s].*)?$/.test(scalar)) return null;
  }
  let text = value.slice(from, to);
  // Keep offsets in the original YAML while excluding escape notation.
  if (quote === '"') text = text.replace(/\\(?:[0abtnvfre "\/\\N_LP\t]|x[\da-fA-F]{2}|u[\da-fA-F]{4}|U[\da-fA-F]{8})/g, (escape) => " ".repeat(escape.length));
  if (quote === '"' && text.includes("\\")) return null;
  return { from, text };
}

/** Check editable string values consistently in source and Document views.
 *  Opaque YAML lists, multiline values and invalid scalar shapes stay excluded. */
export function frontmatterSpellingWords(block: string): FrontmatterSpellingWord[] {
  const table = parseFrontmatterTable(block);
  const starts: number[] = [];
  let offset = table.openLine.length + 1;
  for (const line of table.lines) { starts.push(offset); offset += line.length + 1; }
  const result: FrontmatterSpellingWord[] = [];
  const collect = (field: FmScalar): void => {
    const scalar = stringScalar(field.value);
    if (!scalar) return;
    const valueStart = table.lines[field.lineIndex].length - field.value.length;
    for (const word of proseWords(scalar.text)) {
      const from = scalar.from + word.from;
      const to = scalar.from + word.to;
      result.push({
        word: word.word,
        from: starts[field.lineIndex] + valueStart + from,
        to: starts[field.lineIndex] + valueStart + to,
        cell: { line: field.lineIndex, part: "value", from, to },
      });
    }
  };
  for (const field of table.fields) {
    if (field.kind === "scalar") collect(field);
    else if (field.kind === "group") field.children.forEach(collect);
  }
  return result;
}
