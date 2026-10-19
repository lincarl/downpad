// Replace text inside an autolink. Markdown makes a link from bare text in
// three shapes, and its target repeats the text:
// - <https://example.com/help> and a bare https://example.com/help link to the text.
// - <support@example.com> and a bare email address link to mailto: plus the text.
// - A bare www.example.com links to http:// plus the text.
// The document view keeps the target in the link mark's href, so a find and
// replace that only edited the text left a link whose visible URL and real
// target differed. Every other link keeps its target, even one that repeats its
// text, such as [CONTRIBUTING.md](CONTRIBUTING.md) or [example.com](http://example.com).

import type { Mark, Node as ProseNode } from "@milkdown/kit/prose/model";
import type { Transaction } from "@milkdown/kit/prose/state";

/** A URI scheme as CommonMark autolinks require it, such as https: or mailto:. */
const SCHEME = /^[a-z][a-z0-9+.-]{1,31}:/i;

/**
 * What `href` adds in front of `text` when Markdown made the link from the
 * text alone, or null when the link has a target of its own.
 */
function autolinkPrefix(text: string, href: string): string | null {
  if (href === text && SCHEME.test(text)) return "";
  if (href === `mailto:${text}` && text.includes("@")) return "mailto:";
  if (href === `http://${text}` && /^www\./i.test(text)) return "http://";
  return null;
}

interface Autolink {
  from: number;
  to: number;
  mark: Mark;
  prefix: string;
}

/** The autolink whose text holds all of `from`..`to`, or null. */
function autolinkAround(doc: ProseNode, from: number, to: number): Autolink | null {
  const linkType = doc.type.schema.marks.link;
  const $from = doc.resolve(from);
  const parent = $from.parent;
  let start = $from.index();
  const mark = linkType?.isInSet(parent.maybeChild(start)?.marks ?? []);
  if (!mark) return null;
  let end = start + 1;
  while (start > 0 && mark.isInSet(parent.child(start - 1).marks)) start--;
  while (end < parent.childCount && mark.isInSet(parent.child(end).marks)) end++;
  const link = { from: $from.posAtIndex(start), to: $from.posAtIndex(end) };
  if (to > link.to) return null;
  const prefix = autolinkPrefix(doc.textBetween(link.from, link.to), String(mark.attrs.href));
  return prefix === null ? null : { ...link, mark, prefix };
}

/**
 * Replace `from`..`to` with `text` in `tr`, as `insertText` does, with the
 * marks of the replaced text. Marks stored for text put in at the caret, as
 * at a link's edge (linkEdges.ts), never reach it. When the range is inside
 * an autolink, the link's target changes along with its text.
 */
export function replaceText(tr: Transaction, from: number, to: number, text: string): Transaction {
  const link = autolinkAround(tr.doc, from, to);
  const steps = tr.steps.length;
  if (tr.storedMarks) tr.setStoredMarks(null);
  tr.insertText(text, from, to);
  if (!link) return tr;
  const mapping = tr.mapping.slice(steps);
  const linkFrom = mapping.map(link.from);
  const linkTo = mapping.map(link.to);
  const href = link.prefix + tr.doc.textBetween(linkFrom, linkTo);
  return tr.addMark(linkFrom, linkTo, link.mark.type.create({ ...link.mark.attrs, href }));
}
