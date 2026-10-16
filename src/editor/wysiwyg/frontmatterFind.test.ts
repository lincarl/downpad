// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { FindOptions } from "./findEngine";
import { FrontmatterPanel } from "./FrontmatterPanel";
import { findInFrontmatter, matchRange, replaceInFrontmatter } from "./frontmatterFind";

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
    expect(replaceInFrontmatter(block, found, "a: b")).toBe("---\nname: a: b\n---\n");
    expect(replaceInFrontmatter(block, found, "")).toBe("---\nname: \n---\n");
  });

  it("replaces only the matches it is given", () => {
    const [, second] = findInFrontmatter(BLOCK, "draft", opts());
    expect(replaceInFrontmatter(BLOCK, [second], "first")).toBe(BLOCK.replace("draft-of", "first-of"));
  });
});
