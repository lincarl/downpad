import { describe, expect, it } from "vitest";
import { sameFilePath } from "./pathIdentity";

describe("desktop file identity", () => {
  it("accepts Windows separator and letter-case variants", () => {
    expect(sameFilePath("C:\\Docs\\Notes.md", "c:/docs/notes.md", "win32")).toBe(true);
    expect(sameFilePath("C:\\Docs\\Notes.md", "C:/Docs/Other.md", "win32")).toBe(false);
  });

  it("keeps distinct POSIX filenames separate", () => {
    expect(sameFilePath("/docs/Notes.md", "/docs/notes.md", "linux")).toBe(false);
    expect(sameFilePath("/docs/notes.md", "/docs/notes.md", "linux")).toBe(true);
    expect(sameFilePath("/docs/a\\b.md", "/docs/a/b.md", "linux")).toBe(false);
  });
});
