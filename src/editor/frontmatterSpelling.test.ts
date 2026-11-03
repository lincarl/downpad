import { describe, expect, it } from "vitest";
import { frontmatterSpellingWords } from "./frontmatterSpelling";

describe("metadata spelling values", () => {
  it("checks string values with exact source offsets and skips keys, comments and typed scalars", () => {
    const block = ["---", "typpokey: speling # ignorecomment", 'description: "Café speling"', "nested:", "  caption: readable",
      "flag: false", "number: 2.5e3", "hex: 0xFF", "nullvalue: null", "date: 2026-11-03", "timestamp: 2026-11-03T12:00:00Z", "---\n"].join("\n");
    const words = frontmatterSpellingWords(block);
    expect(words.map(({ word }) => word)).toEqual(["speling", "Café", "speling", "readable"]);
    for (const word of words) expect(block.slice(word.from, word.to)).toBe(word.word);
    expect(words[0].cell).toEqual({ line: 0, part: "value", from: 0, to: 7 });
    expect(words[1].cell).toEqual({ line: 1, part: "value", from: 1, to: 5 });
  });

  it("excludes unsupported YAML structures, incomplete quotes and invalid escapes", () => {
    const block = ["---", "list: [speling, words]", "multiline: |", "  speling", 'broken: "speling', 'escape: "\\q speling"',
      "tag: !custom speling", "alias: *speling", "mapping:", "  nested:", "    key: speling", "---\n"].join("\n");
    expect(frontmatterSpellingWords(block)).toEqual([]);
  });

  it("keeps quoted strings eligible and does not check escape notation", () => {
    const block = '---\ntitle: "speling\\nword"\nstring: "false"\n---\n';
    expect(frontmatterSpellingWords(block).map(({ word }) => word)).toEqual(["speling", "word", "false"]);
  });
});
