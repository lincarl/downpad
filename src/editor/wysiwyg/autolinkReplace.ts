// Replace text inside an autolink. In Markdown, the text of an autolink such as
// <https://example.com/help> or <support@example.com> is also its target. The
// document view keeps the target in the link mark's href, so a find and replace
// that only edited the text left a link whose visible URL and real target
// differed. Links whose text differs from their target keep it.

import type { Mark, Node as ProseNode } from "@milkdown/kit/prose/model";
import type { Transaction } from "@milkdown/kit/prose/state";

/** What a link's target may add in front of its text when the text is the
 *  target. <https://…> adds nothing, an email address adds mailto: and a bare
 *  www. link adds http://. */
const TARGET_PREFIXES = ["", "mailto:", "http://"];

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
  const text = doc.textBetween(link.from, link.to);
  const prefix = TARGET_PREFIXES.find((p) => mark.attrs.href === p + text);
  return prefix === undefined ? null : { ...link, mark, prefix };
}

/**
 * Replace `from`..`to` with `text` in `tr`, as `insertText` does. When the
 * range is inside an autolink, the link's target changes along with its text.
 */
export function replaceText(tr: Transaction, from: number, to: number, text: string): Transaction {
  const link = autolinkAround(tr.doc, from, to);
  const steps = tr.steps.length;
  tr.insertText(text, from, to);
  if (!link) return tr;
  const mapping = tr.mapping.slice(steps);
  const linkFrom = mapping.map(link.from);
  const linkTo = mapping.map(link.to);
  const href = link.prefix + tr.doc.textBetween(linkFrom, linkTo);
  return tr.addMark(linkFrom, linkTo, link.mark.type.create({ ...link.mark.attrs, href }));
}
