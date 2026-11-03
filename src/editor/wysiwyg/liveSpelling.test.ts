import { describe, expect, it } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import { documentSpellingWords } from "./liveSpelling";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    code_block: { group: "block", content: "text*", code: true },
    text: { group: "inline" },
    hard_break: { inline: true, group: "inline" },
  },
  marks: { strong: {}, inlineCode: { code: true } },
});

describe("Document spelling model", () => {
  it("joins words across formatting and excludes inline and block code", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text("sp"), schema.text("el", [schema.marks.strong.create()]), schema.text("ing "),
        schema.text("inlinecode", [schema.marks.inlineCode.create()]),
        schema.nodes.hard_break.create(), schema.text("blåbær"),
      ]),
      schema.nodes.code_block.create(null, schema.text("fencedcode")),
      schema.nodes.paragraph.create(null, schema.text("lastword")),
    ]);
    const words = documentSpellingWords(doc);
    expect(words.map(({ word }) => word)).toEqual(["speling", "blåbær", "lastword"]);
    for (const word of words) expect(doc.textBetween(word.from, word.to)).toBe(word.word);
  });
});
