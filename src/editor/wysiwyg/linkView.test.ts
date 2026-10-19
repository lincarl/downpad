// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { Schema, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import { EditorView, type Decoration } from "@milkdown/kit/prose/view";
import { DEFAULT_SETTINGS } from "../../settings/defaults";
import { linkUrlKey, linkUrlPlugin, middleTruncate } from "./linkView";

describe("middleTruncate", () => {
  it("leaves short URLs unchanged", () => {
    expect(middleTruncate("https://anthropic.com")).toBe("https://anthropic.com");
  });

  it("middle-truncates long URLs with an ellipsis", () => {
    const long = "https://example.com/some/very/long/path/that/keeps/going?q=1&r=2#frag";
    const out = middleTruncate(long, 30);
    expect(out.length).toBe(30);
    expect(out).toContain("…");
    expect(out.startsWith("https://")).toBe(true);
    expect(out.endsWith("frag")).toBe(true);
  });

  it("never splits an emoji at the cut", () => {
    const name = `${"a".repeat(19)}😀${"b".repeat(30)}`;
    expect(middleTruncate(name, 40)).toBe(`${"a".repeat(19)}😀…${"b".repeat(19)}`);
    // Two code units, one character: a name of 40 characters is not cut.
    expect(middleTruncate(`😀${"c".repeat(39)}`, 40)).toBe(`😀${"c".repeat(39)}`);
  });

  it("respects an exact-length boundary", () => {
    const url = "x".repeat(42);
    expect(middleTruncate(url, 42)).toBe(url);
    expect(middleTruncate(url + "y", 42)).toContain("…");
  });
});

// A small schema with the node and mark names the link suffixes look at.
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
    blockquote: { group: "block", content: "block+", toDOM: () => ["blockquote", 0] },
    text: { group: "inline" },
    image: { group: "inline", inline: true, atom: true, toDOM: () => ["img"] },
  },
  marks: { link: { attrs: { href: {} }, inclusive: false, toDOM: (mark) => ["a", { href: mark.attrs.href as string }, 0] } },
});

const ctx = { getSettings: () => DEFAULT_SETTINGS, getFilePath: () => null };
const link = (href: string) => schema.marks.link.create({ href });
const p = (...content: ProseNode[]) => schema.nodes.paragraph.create(null, content);
const text = (value: string, href?: string) => schema.text(value, href ? [link(href)] : []);

/** Each suffix as "position key", in document order. */
function suffixes(state: EditorState): string[] {
  const set = linkUrlKey.getState(state)?.decorations;
  const found: Decoration[] = set ? set.find() : [];
  return found.map((d) => `${d.from} ${(d.spec as { key: string }).key}`).sort();
}

/** The suffixes a fresh state over the same document would have. */
function rebuilt(state: EditorState): string[] {
  return suffixes(EditorState.create({ doc: state.doc, plugins: [linkUrlPlugin(ctx)] }));
}

/** A deterministic pseudo-random number generator, so a failing run repeats. */
function random(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

describe("link URL suffixes", () => {
  it("puts one suffix after each run of text that links to one href", () => {
    const doc = schema.nodes.doc.create(null, [
      p(text("see "), text("the ", "https://a.example"), text("guide", "https://a.example"), text(" and "), text("b", "https://b.example")),
      p(text("x", "https://a.example"), schema.nodes.image.create(), text("y", "https://a.example")),
    ]);
    const state = EditorState.create({ doc, plugins: [linkUrlPlugin(ctx)] });
    expect(suffixes(state)).toEqual([
      "14 md-link-url:https://a.example",
      "20 md-link-url:https://b.example",
      "23 md-link-url:https://a.example",
      "25 md-link-url:https://a.example",
    ]);
  });

  it("matches a full rebuild after many random edits", () => {
    const next = random(7);
    const pick = <T,>(items: T[]): T => items[Math.floor(next() * items.length)]!;
    const hrefs = ["https://a.example", "https://b.example", "docs/c.md"];
    let state = EditorState.create({
      doc: schema.nodes.doc.create(null, [
        p(text("Intro "), text("link", hrefs[0])),
        schema.nodes.blockquote.create(null, [p(text("quoted "), text("ref", hrefs[1]))]),
        p(text("tail")),
      ]),
      plugins: [linkUrlPlugin(ctx)],
    });
    const edits: Array<(tr: Transaction, from: number, to: number) => void> = [
      (tr, from) => tr.insertText(pick(["a", "bc ", " "]), from),
      (tr, from) => tr.insert(from, text("new", pick(hrefs))),
      (tr, from, to) => tr.delete(from, to),
      (tr, from, to) => tr.addMark(from, to, link(pick(hrefs))),
      (tr, from, to) => tr.removeMark(from, to, schema.marks.link),
      (tr, from) => tr.split(from),
      (tr, from) => tr.insert(from, schema.nodes.image.create()),
    ];
    for (let i = 0; i < 400; i++) {
      const size = state.doc.content.size;
      let from = 1 + Math.floor(next() * (size - 1));
      let to = Math.min(size - 1, from + Math.floor(next() * 8));
      // Keep both ends in inline content, where typing and marks happen.
      from = TextSelection.between(state.doc.resolve(from), state.doc.resolve(from)).from;
      to = Math.max(from, TextSelection.between(state.doc.resolve(to), state.doc.resolve(to)).to);
      const tr = state.tr;
      try {
        pick(edits)(tr, from, to);
      } catch {
        continue; // an edit that does not fit the schema there
      }
      // Several steps in one transaction, as a paste or Replace all makes.
      if (next() < 0.3) {
        const at = Math.min(tr.doc.content.size - 1, Math.max(1, from));
        if (tr.doc.resolve(at).parent.inlineContent) tr.insertText("z", at);
      }
      state = state.apply(tr);
      expect(suffixes(state), `after edit ${i}`).toEqual(rebuilt(state));
    }
  });

  it("draws each suffix outside the link that comes right after it", () => {
    const doc = schema.nodes.doc.create(null, [p(text("a", "https://a.example"), text("b", "https://b.example"), text(" c"))]);
    const view = new EditorView(document.createElement("div"), { state: EditorState.create({ doc, plugins: [linkUrlPlugin(ctx)] }) });
    // The URL shows through CSS, with no text in the DOM that a click could
    // land in (see linkView.ts).
    const drawn = [...view.dom.querySelectorAll<HTMLElement>(".md-link-url")].map(
      (suffix) => `${suffix.dataset.url} in ${suffix.parentElement?.nodeName}, text ${JSON.stringify(suffix.textContent)}`,
    );
    view.destroy();
    expect(drawn).toEqual(['https://a.example in P, text ""', 'https://b.example in P, text ""']);
  });

  it("keeps the key of a suffix that only moved", () => {
    const doc = schema.nodes.doc.create(null, [p(text("start")), p(text("go ", undefined), text("there", "https://a.example"))]);
    let state = EditorState.create({ doc, plugins: [linkUrlPlugin(ctx)] });
    const before = linkUrlKey.getState(state)!.decorations.find()[0]!;
    state = state.apply(state.tr.insertText("typed ", 1));
    const after = linkUrlKey.getState(state)!.decorations.find()[0]!;
    expect(after.from).toBe(before.from + 6);
    expect(after.spec).toEqual(before.spec);
  });
});
