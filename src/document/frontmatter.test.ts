import { describe, it, expect } from "vitest";
import { splitFrontmatter, joinFrontmatter } from "./frontmatter";

/** Expect joining the split of `md` to give `md` back. */
const roundTrips = (md: string) => {
  expect(joinFrontmatter(splitFrontmatter(md))).toBe(md);
};

describe("splitFrontmatter", () => {
  it("splits a standard frontmatter block", () => {
    const md = "---\ntitle: Hello\ntags: [a, b]\n---\n\n# Body\n";
    expect(splitFrontmatter(md)).toEqual({
      frontmatter: "---\ntitle: Hello\ntags: [a, b]\n---\n",
      separator: "\n",
      body: "# Body\n",
    });
    roundTrips(md);
  });

  it("returns null when there is no frontmatter", () => {
    const md = "# Just a heading\n\nText.";
    expect(splitFrontmatter(md).frontmatter).toBeNull();
    roundTrips(md);
  });

  it("does NOT treat a mid-document --- as frontmatter", () => {
    const md = "# Heading\n\nSome text\n\n---\n\nMore text\n";
    expect(splitFrontmatter(md).frontmatter).toBeNull();
    roundTrips(md);
  });

  it("treats a thematic break right after content (no opening ---) as body", () => {
    const md = "intro\n---\nnot frontmatter\n";
    expect(splitFrontmatter(md).frontmatter).toBeNull();
  });

  it("handles empty frontmatter", () => {
    const md = "---\n---\nbody\n";
    const { frontmatter, body } = splitFrontmatter(md);
    expect(frontmatter).toBe("---\n---\n");
    expect(body).toBe("body\n");
    roundTrips(md);
  });

  it("handles a closing ... delimiter", () => {
    const md = "---\nkey: val\n...\nbody\n";
    expect(splitFrontmatter(md).frontmatter).toBe("---\nkey: val\n...\n");
    roundTrips(md);
  });

  it("keeps blank and whitespace-only lines after the block as the separator", () => {
    const md = "---\na: 1\n---\n\n  \n\nbody\n";
    expect(splitFrontmatter(md)).toEqual({ frontmatter: "---\na: 1\n---\n", separator: "\n  \n\n", body: "body\n" });
    roundTrips(md);
  });

  it("leaves an indented first body line in the body", () => {
    const md = "---\na: 1\n---\n\n    code\n";
    expect(splitFrontmatter(md)).toEqual({ frontmatter: "---\na: 1\n---\n", separator: "\n", body: "    code\n" });
    roundTrips(md);
  });

  it("leaves leading blank lines in the body when there is no frontmatter", () => {
    expect(splitFrontmatter("\n\nbody\n")).toEqual({ frontmatter: null, separator: "", body: "\n\nbody\n" });
  });

  it("is byte-lossless when the file is only frontmatter", () => {
    const md = "---\na: 1\n---\n";
    const { frontmatter, body } = splitFrontmatter(md);
    expect(frontmatter).toBe(md);
    expect(body).toBe("");
    roundTrips(md);
  });
});

describe("joinFrontmatter", () => {
  it("starts body text on its own line after a block that ends the file", () => {
    expect(joinFrontmatter({ frontmatter: "---\na: 1\n---", separator: "", body: "Hello\n" })).toBe("---\na: 1\n---\nHello\n");
    expect(joinFrontmatter({ frontmatter: "---\na: 1\n---", separator: "", body: "" })).toBe("---\na: 1\n---");
  });
});
