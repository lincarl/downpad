// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { FindOptions } from "./findEngine";
import { FrontmatterPanel } from "./FrontmatterPanel";
import { changedCell, findInFrontmatter, matchRange, replaceInFrontmatter } from "./frontmatterFind";

const opts = (over: Partial<FindOptions> = {}): FindOptions => ({
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  ...over,
});

// A scalar with a comment, a mapping, a quoted nested value, a comment line the
// table does not show, and a list the table shows read-only.
const BLOCK =
  "---\n" +
  "title: Draft notes # keep\n" +
  "draft-of:   v1\n" +
  "drafts:\n" +
  "  # hidden draft comment\n" +
  '  status: "draft"\n' +
  "tags:\n" +
  "  - draft\n" +
  "---\n";

afterEach(cleanup);

describe("findInFrontmatter", () => {
  it("finds keys and values as the table shows them, top to bottom", () => {
    const found = findInFrontmatter(BLOCK, "draft", opts());
    expect(found.map(({ line, part, from, to }) => [line, part, from, to])).toEqual([
      [0, "value", 0, 5], // title: Draft notes
      [1, "key", 0, 5], // draft-of
      [2, "key", 0, 5], // drafts (mapping)
      [4, "value", 1, 6], // status: "draft"
      [5, "value", 10, 15], // tags, shown read-only as "tags:\n  - draft"
    ]);
  });

  it("applies match case and whole word", () => {
    expect(findInFrontmatter(BLOCK, "Draft", opts({ caseSensitive: true }))).toHaveLength(1);
    expect(findInFrontmatter(BLOCK, "drafts", opts({ wholeWord: true })).map((m) => m.line)).toEqual([2]);
    expect(findInFrontmatter(BLOCK, "", opts())).toEqual([]);
  });

  it("finds text in the read-only view of a block with comments only", () => {
    expect(findInFrontmatter("---\n# draft note\n---\n", "draft", opts())).toEqual([
      { line: 0, part: "value", from: 2, to: 7 },
    ]);
  });

  it("gives offsets that select the match in the drawn table", () => {
    for (const block of [BLOCK, "---\n# draft note\n---\n", "---\n- draft\n- other draft\n---\n"]) {
      const { container } = render(createElement(FrontmatterPanel, { block, focus: null, onBlockChange: () => {} }));
      const found = findInFrontmatter(block, "draft", opts());
      expect(found.length).toBeGreaterThan(0);
      expect(found.map((match) => matchRange(container, match)?.toString().toLowerCase())).toEqual(
        found.map(() => "draft"),
      );
      cleanup();
    }
  });
});

describe("changedCell", () => {
  const block = "---\ntitle: Draft notes\nstatus: draft\n---\n";

  it("gives the first cell with other text and the end of the change in it", () => {
    // Text added at the end, taken back, and added in the middle.
    expect(changedCell(block, block.replace("notes", "notes v2"))).toEqual({ line: 0, part: "value", from: 14 });
    expect(changedCell(block.replace("notes", "notes v2"), block)).toEqual({ line: 0, part: "value", from: 11 });
    expect(changedCell(block, block.replace("Draft", "Draft X"))).toEqual({ line: 0, part: "value", from: 8 });
    // A renamed key and a row added before the status row.
    expect(changedCell(block, block.replace("status", "state"))).toEqual({ line: 1, part: "key", from: 5 });
    expect(changedCell(block, block.replace("status", "key: \nstatus"))).toEqual({ line: 1, part: "key", from: 3 });
  });

  it("gives null when no shown text changed or only the last row went", () => {
    expect(changedCell(block, block)).toBeNull();
    expect(changedCell(block, block.replace("status: draft\n", ""))).toBeNull();
  });
});

describe("replaceInFrontmatter", () => {
  it("rewrites only the lines of replaced keys and values", () => {
    const block = replaceInFrontmatter(BLOCK, findInFrontmatter(BLOCK, "draft", opts()), "final");
    expect(block).toBe(
      "---\n" +
        "title: final notes # keep\n" +
        "final-of:   v1\n" +
        "finals:\n" +
        "  # hidden draft comment\n" +
        '  status: "final"\n' +
        "tags:\n" +
        "  - draft\n" +
        "---\n",
    );
  });

  it("returns the block unchanged when every match is read-only", () => {
    const block = "---\ntags:\n  - draft\n---\n";
    expect(replaceInFrontmatter(block, findInFrontmatter(block, "draft", opts()), "final")).toBe(block);
  });

  it("leaves a key that would stop being a key, and still replaces the value", () => {
    const block = "---\nname: name\n---\n";
    const found = findInFrontmatter(block, "name", opts());
    expect(found.map((m) => m.part)).toEqual(["key", "value"]);
    expect(replaceInFrontmatter(block, found, "full name")).toBe("---\nfull name: full name\n---\n");
    expect(replaceInFrontmatter(block, found, "")).toBe("---\nname: \n---\n");
    expect(replaceInFrontmatter(block, found, "a #b")).toBe(block);
  });

  it("leaves a key that would repeat a sibling's key, also one renamed in the same pass", () => {
    const block = "---\ndraft: a\ndrafts: b\ngroup:\n  ax: 1\n  bx: 2\n---\n";
    const keys = (query: string, over: Partial<FindOptions> = {}) =>
      findInFrontmatter(block, query, opts(over)).filter((m) => m.part === "key");
    expect(replaceInFrontmatter(block, keys("drafts"), "draft")).toBe(block);
    expect(replaceInFrontmatter(block, keys("[ab]x", { regex: true }), "k")).toBe(
      "---\ndraft: a\ndrafts: b\ngroup:\n  k: 1\n  bx: 2\n---\n",
    );
    // The same key may appear at another level.
    expect(replaceInFrontmatter(block, keys("ax"), "draft")).toBe(block.replace("  ax:", "  draft:"));
  });

  it.each([
    ["adds a comment", "title: Draft notes", "notes", "new # note"],
    ["adds a key separator", "title: Draft notes", "notes", "a: b"],
    ["ends the text in a colon", "title: Draft notes", "notes", "x:"],
    ["starts with an indicator", "title: notes", "notes", "*alias"],
    ["moves a comment into the text", "title: Draft notes # keep", "Draft", "A # B"],
    ["closes a quoted value early", 'status: "draft"', "draft", 'a "b'],
    ["closes a single-quoted value early", "status: 'draft'", "draft", "it's"],
    ["escapes the closing quote", 'title: "foo"', "foo", "bar\\"],
    ["drops the quotes", 'title: "null"', '"null"', "null"],
    ["adds an escape YAML does not define", 'title: "foo"', "foo", "a\\q"],
  ])("leaves a value when the replacement %s", (_name, line, query, replacement) => {
    const block = `---\n${line}\n---\n`;
    const found = findInFrontmatter(block, query, opts()).filter((m) => m.part === "value");
    expect(found).not.toEqual([]);
    expect(replaceInFrontmatter(block, found, replacement)).toBe(block);
  });

  it.each([
    ["inside a comment", "title: Draft notes # keep", "keep", "kept", "title: Draft notes # kept"],
    ["inside quotes, with characters plain text cannot hold", 'status: "draft"', "draft", "a: b # c", 'status: "a: b # c"'],
    ["with an escaped quote", 'status: "draft"', "draft", 'say \\"hi\\"', 'status: "say \\"hi\\""'],
    ["with a doubled single quote", "status: 'draft'", "draft", "it''s", "status: 'it''s'"],
    ["with escapes YAML defines", 'status: "draft"', "draft", "a\\tb\\u00e9\\\\", 'status: "a\\tb\\u00e9\\\\"'],
    ["with a hash that starts no comment", "title: notes", "notes", "C#", "title: C#"],
  ])("replaces a value %s", (_name, line, query, replacement, expected) => {
    const block = `---\n${line}\n---\n`;
    const found = findInFrontmatter(block, query, opts()).filter((m) => m.part === "value");
    expect(replaceInFrontmatter(block, found, replacement)).toBe(`---\n${expected}\n---\n`);
  });

  it("replaces only the matches it is given", () => {
    const [, second] = findInFrontmatter(BLOCK, "draft", opts());
    expect(replaceInFrontmatter(BLOCK, [second], "first")).toBe(BLOCK.replace("draft-of", "first-of"));
  });
});
