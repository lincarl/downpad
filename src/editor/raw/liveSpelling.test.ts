import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdownSource } from "./markdownSource";
import { sourceSpellingWords } from "./liveSpelling";

/** Collect from the same configured parser used by the Markdown editor. */
function words(markdown: string) {
  return sourceSpellingWords(EditorState.create({ doc: markdown, extensions: [markdownSource()] }));
}

describe("full Markdown spelling model", () => {
  it("excludes code and link targets, keeps link labels and combines emphasis", async () => {
    const result = await words("sp**el**ing [readable](https://typpo.invalid/path) `inlinecode`\n\n~~~js\nfencedcode\n~~~\n\n    indentedcode\n\nlastword");
    expect(result.map(({ word }) => word)).toEqual(["speling", "readable", "lastword"]);
    expect(result[0].parts).toEqual([{ from: 0, to: 2 }, { from: 4, to: 6 }, { from: 8, to: 11 }]);
  });

  it("parses beyond the initial viewport and respects unclosed fences", async () => {
    const source = "correct paragraph\n\n".repeat(3_000) + "offscreenword\n\n```\nhiddencode\n";
    const result = await words(source);
    expect(result).toHaveLength(6_001);
    expect(result.at(-1)).toMatchObject({ word: "offscreenword", from: source.indexOf("offscreenword") });
  });

  it("checks only metadata string values before checking body prose", async () => {
    const source = '---\ntyppokey: speling # commenttyppo\nflag: false\ndate: 2026-11-03\nlist: [opaquetyppo]\nnested:\n  title: "speling"\n---\n\nbodyword';
    const result = await words(source);
    expect(result.map(({ word }) => word)).toEqual(["speling", "speling", "bodyword"]);
    for (const word of result) expect(source.slice(word.from, word.to)).toBe(word.word);
  });
});
