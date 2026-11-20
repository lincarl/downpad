import { describe, it, expect } from "vitest";
import { classifyDrop, baseName } from "./dropHandler";

describe("classifyDrop", () => {
  it("classifies the files that open in a tab: Markdown, text, JSON and YAML", () => {
    expect(classifyDrop("C:/notes/draft.md")).toBe("document");
    expect(classifyDrop("notes.markdown")).toBe("document");
    expect(classifyDrop("readme.txt")).toBe("document");
    expect(classifyDrop("C:/app/package.JSON")).toBe("document");
    expect(classifyDrop("/srv/compose.yaml")).toBe("document");
    expect(classifyDrop("ci.yml")).toBe("document");
  });
  it("classifies image files", () => {
    expect(classifyDrop("C:/img/shot.png")).toBe("image");
    expect(classifyDrop("photo.JPEG")).toBe("image");
    expect(classifyDrop("diagram.svg")).toBe("image");
  });
  it("classifies everything else as other", () => {
    expect(classifyDrop("report.pdf")).toBe("other");
    expect(classifyDrop("data.csv")).toBe("other");
    expect(classifyDrop("archive")).toBe("other");
    // A name that only ends like one of them is no such file.
    expect(classifyDrop("notes.json.bak")).toBe("other");
    expect(classifyDrop("C:/data.yaml/export")).toBe("other");
  });
});

describe("baseName", () => {
  it("returns the final segment for both slash styles", () => {
    expect(baseName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(baseName("/home/me/report.pdf")).toBe("report.pdf");
    expect(baseName("plain.txt")).toBe("plain.txt");
  });
});
