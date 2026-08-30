import { describe, it, expect } from "vitest";
import { splitFrontmatter, joinFrontmatter, frontmatterInnerYaml } from "./frontmatter";

const roundTrips = (md: string) => {
  const { frontmatter, body } = splitFrontmatter(md);
  expect(joinFrontmatter(frontmatter, body)).toBe(md);
};

describe("splitFrontmatter", () => {
  it("splits a standard frontmatter block", () => {
    const md = "---\ntitle: Hello\ntags: [a, b]\n---\n\n# Body\n";
    const { frontmatter, body } = splitFrontmatter(md);
    expect(frontmatter).toBe("---\ntitle: Hello\ntags: [a, b]\n---\n");
    expect(body).toBe("\n# Body\n");
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

  it("is byte-lossless when the file is only frontmatter", () => {
    const md = "---\na: 1\n---\n";
    const { frontmatter, body } = splitFrontmatter(md);
    expect(frontmatter).toBe(md);
    expect(body).toBe("");
    roundTrips(md);
  });
});

describe("frontmatterInnerYaml", () => {
  it("extracts the YAML body without delimiters", () => {
    const { frontmatter } = splitFrontmatter("---\ntitle: Hi\nn: 2\n---\nbody");
    expect(frontmatterInnerYaml(frontmatter!)).toBe("title: Hi\nn: 2\n");
  });
});
