import { describe, it, expect } from "vitest";
import {
  isRemoteOrData,
  isAbsolutePath,
  dirName,
  resolveImagePath,
  resolveMarkdownLinkTarget,
} from "./pathResolve";

describe("isRemoteOrData", () => {
  it("flags data/http/blob/asset URLs", () => {
    expect(isRemoteOrData("data:image/png;base64,AAAA")).toBe(true);
    expect(isRemoteOrData("https://example.com/a.png")).toBe(true);
    expect(isRemoteOrData("blob:abc")).toBe(true);
    expect(isRemoteOrData("asset://localhost/x")).toBe(true);
  });
  it("does not flag local paths", () => {
    expect(isRemoteOrData("attachments/a.png")).toBe(false);
    expect(isRemoteOrData("C:/notes/a.png")).toBe(false);
  });
});

describe("isAbsolutePath", () => {
  it("recognizes Windows, POSIX, and UNC absolutes", () => {
    expect(isAbsolutePath("C:\\notes\\a.png")).toBe(true);
    expect(isAbsolutePath("C:/notes/a.png")).toBe(true);
    expect(isAbsolutePath("/home/me/a.png")).toBe(true);
    expect(isAbsolutePath("\\\\server\\share\\a.png")).toBe(true);
  });
  it("rejects relative paths", () => {
    expect(isAbsolutePath("attachments/a.png")).toBe(false);
    expect(isAbsolutePath("./a.png")).toBe(false);
  });
});

describe("dirName", () => {
  it("returns the directory for both slash styles", () => {
    expect(dirName("C:\\notes\\doc.md")).toBe("C:\\notes");
    expect(dirName("/home/me/doc.md")).toBe("/home/me");
    expect(dirName("doc.md")).toBe("");
  });
});

describe("resolveImagePath", () => {
  it("returns null for remote/data URLs", () => {
    expect(resolveImagePath("data:image/png;base64,AA", "C:/n/doc.md")).toBeNull();
    expect(resolveImagePath("https://x/y.png", "C:/n/doc.md")).toBeNull();
  });
  it("passes absolute paths through", () => {
    expect(resolveImagePath("C:/img/a.png", null)).toBe("C:/img/a.png");
  });
  it("joins relative paths to the document directory", () => {
    expect(resolveImagePath("attachments/a.png", "C:/notes/doc.md")).toBe("C:/notes/attachments/a.png");
    expect(resolveImagePath("attachments/my%20pic.png", "C:/notes/doc.md")).toBe(
      "C:/notes/attachments/my pic.png",
    );
  });
  it("returns null for a relative path with no document anchor", () => {
    expect(resolveImagePath("attachments/a.png", null)).toBeNull();
  });
});

describe("resolveMarkdownLinkTarget", () => {
  const doc = "C:/notes/index.md";

  it("joins a relative .md link to the document directory", () => {
    expect(resolveMarkdownLinkTarget("chapter1.md", doc)).toBe("C:/notes/chapter1.md");
    expect(resolveMarkdownLinkTarget("sub/c.markdown", doc)).toBe("C:/notes/sub/c.markdown");
  });

  it("collapses ./ and ../ segments so the path dedupes (§5.19)", () => {
    expect(resolveMarkdownLinkTarget("./chapter1.md", doc)).toBe("C:/notes/chapter1.md");
    expect(resolveMarkdownLinkTarget("../sibling/d.mkd", doc)).toBe("C:/sibling/d.mkd");
    expect(resolveMarkdownLinkTarget("a/./b/../c.md", doc)).toBe("C:/notes/a/c.md");
    // A `..` cannot escape the drive root.
    expect(resolveMarkdownLinkTarget("../../../x.md", doc)).toBe("C:/x.md");
  });

  it("normalizes a backslash document directory to forward slashes", () => {
    expect(resolveMarkdownLinkTarget("chapter1.md", "C:\\notes\\index.md")).toBe(
      "C:/notes/chapter1.md",
    );
  });

  it("passes absolute .md paths through (both slash styles + UNC)", () => {
    expect(resolveMarkdownLinkTarget("C:/other/a.md", null)).toBe("C:/other/a.md");
    expect(resolveMarkdownLinkTarget("C:\\other\\a.md", null)).toBe("C:\\other\\a.md");
    expect(resolveMarkdownLinkTarget("/home/me/a.md", null)).toBe("/home/me/a.md");
    expect(resolveMarkdownLinkTarget("\\\\srv\\share\\a.md", null)).toBe("\\\\srv\\share\\a.md");
  });

  it("recognizes every markdown extension, case-insensitively", () => {
    for (const ext of ["md", "MD", "markdown", "mdown", "mkd"]) {
      expect(resolveMarkdownLinkTarget(`a.${ext}`, doc)).toBe(`C:/notes/a.${ext}`);
    }
  });

  it("strips a fragment or query before resolving", () => {
    expect(resolveMarkdownLinkTarget("chapter1.md#intro", doc)).toBe("C:/notes/chapter1.md");
    expect(resolveMarkdownLinkTarget("chapter1.md?v=2", doc)).toBe("C:/notes/chapter1.md");
  });

  it("decodes percent-escapes in the path", () => {
    expect(resolveMarkdownLinkTarget("my%20notes.md", doc)).toBe("C:/notes/my notes.md");
  });

  it("returns null for web/protocol links", () => {
    expect(resolveMarkdownLinkTarget("https://example.com/a.md", doc)).toBeNull();
    expect(resolveMarkdownLinkTarget("http://example.com/a.md", doc)).toBeNull();
    expect(resolveMarkdownLinkTarget("mailto:x@y.md", doc)).toBeNull();
    expect(resolveMarkdownLinkTarget("file:///C:/a.md", doc)).toBeNull();
    // Protocol-relative URL — a web link (and a forward-slash UNC path); never
    // a local file, and would otherwise trigger an outbound SMB connection.
    expect(resolveMarkdownLinkTarget("//evil.com/a.md", doc)).toBeNull();
  });

  it("returns null for in-document anchors and non-markdown targets", () => {
    expect(resolveMarkdownLinkTarget("#heading", doc)).toBeNull();
    expect(resolveMarkdownLinkTarget("notes.txt", doc)).toBeNull();
    expect(resolveMarkdownLinkTarget("photo.png", doc)).toBeNull();
    expect(resolveMarkdownLinkTarget("", doc)).toBeNull();
  });

  it("returns null for a relative .md link with no document to anchor it", () => {
    expect(resolveMarkdownLinkTarget("chapter1.md", null)).toBeNull();
  });
});
