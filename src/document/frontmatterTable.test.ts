import { describe, it, expect } from "vitest";
import {
  parseFrontmatterTable,
  rebuildFrontmatter,
  rewriteScalar,
  rewriteGroupKey,
  addTopLevelField,
  insertFieldAt,
  deleteField,
  isValidEditableKey,
  type FmGroup,
  type FmScalar,
} from "./frontmatterTable";

// The memory-file example from the spec discussion (matches the VS Code table).
const MEMO =
  "---\n" +
  "name: milestone-autocontinue\n" +
  "description: Don't pause between milestones — finish one, commit/push, immediately start the next\n" +
  "metadata:\n" +
  "  type: feedback\n" +
  "---\n";

const group = (t: ReturnType<typeof parseFrontmatterTable>): FmGroup =>
  t.fields.find((f) => f.kind === "group") as FmGroup;

describe("parseFrontmatterTable", () => {
  it("parses top-level scalars and a nested mapping into editable rows", () => {
    const t = parseFrontmatterTable(MEMO);
    expect(t.fields.map((f) => [f.kind, f.key])).toEqual([
      ["scalar", "name"],
      ["scalar", "description"],
      ["group", "metadata"],
    ]);
    const g = group(t);
    expect(g.children.map((c) => [c.key, c.value])).toEqual([["type", "feedback"]]);
    expect(g.childIndent).toBe("  ");
  });

  it("treats an inline collection as an editable scalar", () => {
    const t = parseFrontmatterTable("---\ntags: [demo, markdown]\n---\n");
    expect(t.fields[0]).toMatchObject({ kind: "scalar", key: "tags", value: "[demo, markdown]" });
  });

  it("shows a block list as read-only raw (not an editable mapping)", () => {
    const t = parseFrontmatterTable("---\ntags:\n  - a\n  - b\n---\n");
    expect(t.fields[0].kind).toBe("raw");
    expect(t.fields[0].key).toBe("tags");
  });

  it("parses a key that legitimately starts with a dash as an editable scalar", () => {
    const t = parseFrontmatterTable("---\n-x: 1\n---\n");
    expect(t.fields[0]).toMatchObject({ kind: "scalar", key: "-x", value: "1" });
  });

  it("keeps a mapping editable when a comment is interleaved with its children", () => {
    const md = "---\nmeta:\n  # note\n  a: 1\n---\n";
    const t = parseFrontmatterTable(md);
    expect(t.fields[0].kind).toBe("group");
    expect(group(t).children.map((c) => c.key)).toEqual(["a"]);
    // The comment line is preserved verbatim on round-trip.
    expect(rebuildFrontmatter(t)).toBe(md);
  });

  it("preserves the closing `...` delimiter and round-trips", () => {
    const t = parseFrontmatterTable("---\nk: v\n...\n");
    expect(t.closeLine).toBe("...");
    expect(rebuildFrontmatter(t)).toBe("---\nk: v\n...\n");
  });
});

describe("round-trip losslessness", () => {
  it("rebuilds an unedited block byte-for-byte", () => {
    expect(rebuildFrontmatter(parseFrontmatterTable(MEMO))).toBe(MEMO);
  });

  it("preserves comments, blank lines, key order, and indentation", () => {
    const md =
      "---\n" +
      "# a leading comment\n" +
      "title:   Spaced Out\n" +
      "\n" +
      "metadata:\n" +
      "  a: 1\n" +
      "  b: 2\n" +
      "tags: [x, y]\n" +
      "...\n";
    expect(rebuildFrontmatter(parseFrontmatterTable(md))).toBe(md);
  });

  it("preserves a block with NO trailing newline", () => {
    const md = "---\ntitle: Old\nauthor: Me\n---";
    const t = parseFrontmatterTable(md);
    expect(rebuildFrontmatter(t)).toBe(md);
  });

  it("preserves trailing whitespace on the delimiter lines", () => {
    const md = "---  \nk: v\n...  \n";
    const t = parseFrontmatterTable(md);
    expect(t.openLine).toBe("---  ");
    expect(t.closeLine).toBe("...  ");
    expect(rebuildFrontmatter(t)).toBe(md);
  });

  it("falls back to raw inner YAML when nothing parses as a key", () => {
    const t = parseFrontmatterTable("---\n- just\n- a\n- list\n---\n");
    expect(t.fields.map((f) => f.kind)).toEqual(["raw"]);
    expect(t.raw).toBe("- just\n- a\n- list\n");
    expect(rebuildFrontmatter(t)).toBe("---\n- just\n- a\n- list\n---\n");
  });
});

describe("editing", () => {
  it("rewrites a top-level scalar value, changing only that line", () => {
    const t = parseFrontmatterTable(MEMO);
    const f = t.fields[0] as FmScalar;
    f.value = "renamed-slug";
    expect(rewriteScalar(t, f)).toBe(
      MEMO.replace("name: milestone-autocontinue", "name: renamed-slug"),
    );
  });

  it("rewrites a NESTED scalar value losslessly", () => {
    const t = parseFrontmatterTable(MEMO);
    const child = group(t).children[0];
    child.value = "preference";
    expect(rewriteScalar(t, child)).toBe(MEMO.replace("  type: feedback", "  type: preference"));
  });

  it("renames a scalar key, preserving indent and separator", () => {
    const t = parseFrontmatterTable("---\ntitle:   Spaced\n---\n");
    const f = t.fields[0] as FmScalar;
    f.key = "heading";
    expect(rewriteScalar(t, f)).toBe("---\nheading:   Spaced\n---\n");
  });

  it("renames a mapping (group) key", () => {
    const t = parseFrontmatterTable(MEMO);
    const g = group(t);
    g.key = "meta";
    expect(rewriteGroupKey(t, g)).toBe(MEMO.replace("metadata:", "meta:"));
  });
});

describe("adding fields", () => {
  it("appends a top-level field before the close delimiter", () => {
    const t = parseFrontmatterTable("---\na: 1\n---\n");
    const { block, lineIndex } = addTopLevelField(t, "b", "2");
    expect(block).toBe("---\na: 1\nb: 2\n---\n");
    expect(lineIndex).toBe(1);
  });

  it("inserts a top-level field AT the top (above the first row)", () => {
    const t = parseFrontmatterTable("---\na: 1\n---\n");
    const { block, lineIndex } = insertFieldAt(t, 0, "", "b", "2");
    expect(block).toBe("---\nb: 2\na: 1\n---\n");
    expect(lineIndex).toBe(0);
  });

  it("inserts a top-level field just above a given row (in the gap before it)", () => {
    const t = parseFrontmatterTable("---\na: 1\nc: 3\n---\n");
    const c = t.fields[1] as FmScalar;
    const { block, lineIndex } = insertFieldAt(t, c.lineIndex, "", "b", "2");
    expect(block).toBe("---\na: 1\nb: 2\nc: 3\n---\n");
    expect(lineIndex).toBe(1);
  });

  it("inserts a child in the gap before a nested row, staying in the mapping", () => {
    const t = parseFrontmatterTable("---\nmeta:\n  a: 1\n  c: 3\n---\n");
    const c = group(t).children[1];
    const { block, lineIndex } = insertFieldAt(t, c.lineIndex, group(t).childIndent, "b", "2");
    expect(block).toBe("---\nmeta:\n  a: 1\n  b: 2\n  c: 3\n---\n");
    expect(lineIndex).toBe(2);
  });

  it("appends to a mapping at its blockEnd, before a trailing top-level key (add-to-group)", () => {
    const t = parseFrontmatterTable("---\nmeta:\n  a: 1\nafter: x\n---\n");
    const g = group(t);
    const { block, lineIndex } = insertFieldAt(t, g.blockEnd, g.childIndent, "b", "2");
    expect(block).toBe("---\nmeta:\n  a: 1\n  b: 2\nafter: x\n---\n");
    expect(lineIndex).toBe(2);
  });

  it("appends a top-level field at the very end when atLineIndex is past the end", () => {
    const t = parseFrontmatterTable("---\na: 1\n---\n");
    const { block, lineIndex } = insertFieldAt(t, t.lines.length + 3, "", "b", "2");
    expect(block).toBe("---\na: 1\nb: 2\n---\n");
    expect(lineIndex).toBe(1);
  });

  it("inserts a top-level field at the top when atLineIndex is before the start", () => {
    const t = parseFrontmatterTable("---\na: 1\nc: 3\n---\n");
    const { block, lineIndex } = insertFieldAt(t, -1, "", "b", "2");
    expect(block).toBe("---\nb: 2\na: 1\nc: 3\n---\n");
    expect(lineIndex).toBe(0);
  });

  it("inserts a top-level field in the gap BEFORE a mapping, not inside it (children stay grouped)", () => {
    // The gap before a group header inserts at headerIndex with indent "" — the new
    // field must land before `meta:`, NOT between the header and its children.
    const t = parseFrontmatterTable("---\nmeta:\n  a: 1\n---\n");
    const g = group(t);
    const { block, lineIndex } = insertFieldAt(t, g.headerIndex, "", "b", "2");
    expect(block).toBe("---\nb: 2\nmeta:\n  a: 1\n---\n");
    expect(lineIndex).toBe(0);
  });
});

describe("deleting fields", () => {
  it("deletes a top-level scalar", () => {
    const t = parseFrontmatterTable("---\na: 1\nb: 2\nc: 3\n---\n");
    expect(deleteField(t, t.fields[1])).toBe("---\na: 1\nc: 3\n---\n");
  });

  it("deletes a nested scalar", () => {
    const t = parseFrontmatterTable("---\nmeta:\n  a: 1\n  b: 2\n---\n");
    expect(deleteField(t, group(t).children[0])).toBe("---\nmeta:\n  b: 2\n---\n");
  });

  it("deletes an entire mapping (header + children)", () => {
    const t = parseFrontmatterTable(MEMO);
    expect(deleteField(t, group(t))).toBe(
      "---\n" +
        "name: milestone-autocontinue\n" +
        "description: Don't pause between milestones — finish one, commit/push, immediately start the next\n" +
        "---\n",
    );
  });

  it("does not strand the blank separator that followed a deleted mapping", () => {
    const t = parseFrontmatterTable("---\nmeta:\n  a: 1\n\nafter: x\n---\n");
    expect(deleteField(t, group(t))).toBe("---\nafter: x\n---\n");
  });

  it("removes trailing blank lines when deleting the last (group) field", () => {
    const t = parseFrontmatterTable("---\nbefore: y\nmeta:\n  a: 1\n\n\n---\n");
    expect(deleteField(t, group(t))).toBe("---\nbefore: y\n---\n");
  });
});

describe("isValidEditableKey", () => {
  it("accepts ordinary keys (with surrounding space trimmed)", () => {
    expect(isValidEditableKey("title")).toBe(true);
    expect(isValidEditableKey("  title  ")).toBe(true);
    expect(isValidEditableKey("my key")).toBe(true); // internal space is fine
    expect(isValidEditableKey("-x")).toBe(true); // dash not followed by space
  });

  it("rejects keys that would corrupt the YAML line", () => {
    expect(isValidEditableKey("")).toBe(false);
    expect(isValidEditableKey("   ")).toBe(false);
    expect(isValidEditableKey("a: b")).toBe(false); // colon splits the line
    expect(isValidEditableKey("# c")).toBe(false); // comment marker
    expect(isValidEditableKey("- item")).toBe(false); // list marker
  });
});
