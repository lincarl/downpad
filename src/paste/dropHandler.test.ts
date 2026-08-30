import { describe, it, expect } from "vitest";
import { classifyDrop, extOf, baseName } from "./dropHandler";

describe("extOf", () => {
  it("extracts lowercase extensions", () => {
    expect(extOf("C:/notes/Draft.MD")).toBe("md");
    expect(extOf("/home/me/pic.PNG")).toBe("png");
  });
  it("returns empty for no extension or dotfiles in a parent dir", () => {
    expect(extOf("C:/notes/README")).toBe("");
    expect(extOf("C:/my.dir/file")).toBe("");
  });
});

describe("classifyDrop", () => {
  it("classifies markdown files", () => {
    expect(classifyDrop("C:/notes/draft.md")).toBe("md");
    expect(classifyDrop("notes.markdown")).toBe("md");
    expect(classifyDrop("readme.txt")).toBe("md");
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
  });
});

describe("baseName", () => {
  it("returns the final segment for both slash styles", () => {
    expect(baseName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(baseName("/home/me/report.pdf")).toBe("report.pdf");
    expect(baseName("plain.txt")).toBe("plain.txt");
  });
});
