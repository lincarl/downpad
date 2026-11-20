import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  write: vi.fn(async (_items: unknown[]) => {}),
  /** Called before the look at a file, to hold it back. */
  beforeStat: vi.fn(async (_path: string) => {}),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (path: string) => {
      await native.beforeStat(path);
      return actual.stat(path);
    },
  };
});

vi.mock("electron", () => ({
  clipboard: { write: native.write },
  ClipboardItem: class {
    constructor(readonly entries: Record<string, string>) {}
  },
}));

const { copyFileToClipboard, fileClipboardEntries } = await import("./fileClipboard");

describe("fileClipboardEntries", () => {
  it("lists the file as a file URL, which Electron writes as the system's copied files", () => {
    expect(fileClipboardEntries("C:\\Users\\sam\\Notes\\plan b.md", "win32")).toEqual({ "text/uri-list": "file:///C:/Users/sam/Notes/plan%20b.md" });
    expect(fileClipboardEntries("\\\\server\\share\\plan.md", "win32")).toEqual({ "text/uri-list": "file://server/share/plan.md" });
    expect(fileClipboardEntries("/Users/sam/plan b.md", "darwin")).toEqual({ "text/uri-list": "file:///Users/sam/plan%20b.md" });
  });

  it("adds the GTK file managers' copied-files list on Linux", () => {
    expect(fileClipboardEntries("/home/sam/Notes/plan b.md", "linux")).toEqual({
      "text/uri-list": "file:///home/sam/Notes/plan%20b.md",
      'electron application/osclipboard;format="x-special/gnome-copied-files"': "copy\nfile:///home/sam/Notes/plan%20b.md",
    });
  });

  it("escapes characters a URL would otherwise read as its own", () => {
    expect(fileClipboardEntries("/tmp/#1 100%?.md", "darwin")["text/uri-list"]).toBe("file:///tmp/%231%20100%25%3F.md");
  });
});

describe("copyFileToClipboard", () => {
  let folder = "";
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "downpad-copy-file-"));
    await writeFile(join(folder, "note.md"), "# Note\n");
  });
  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("writes the file's entries to the clipboard in one write", async () => {
    native.write.mockClear();
    await copyFileToClipboard(join(folder, "note.md"));
    expect(native.write).toHaveBeenCalledOnce();
    const [items] = native.write.mock.calls[0];
    expect(items).toEqual([{ entries: fileClipboardEntries(join(folder, "note.md"), process.platform) }]);
  });

  it("writes copies in the order they were asked for, also when the look at an earlier file is slow", async () => {
    native.write.mockClear();
    await writeFile(join(folder, "later.md"), "# Later\n");
    let release!: () => void;
    native.beforeStat.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const slow = copyFileToClipboard(join(folder, "note.md"));
    const later = copyFileToClipboard(join(folder, "later.md"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(native.write).not.toHaveBeenCalled();
    release();
    await Promise.all([slow, later]);
    expect(native.write.mock.calls.map(([items]) => items)).toEqual([
      [{ entries: fileClipboardEntries(join(folder, "note.md"), process.platform) }],
      [{ entries: fileClipboardEntries(join(folder, "later.md"), process.platform) }],
    ]);
  });

  it("copies a file after a copy that failed", async () => {
    native.write.mockClear();
    await expect(copyFileToClipboard(join(folder, "missing.md"))).rejects.toThrow();
    await copyFileToClipboard(join(folder, "note.md"));
    expect(native.write).toHaveBeenCalledOnce();
  });

  it("refuses a folder or a missing file and leaves the clipboard alone", async () => {
    native.write.mockClear();
    await expect(copyFileToClipboard(folder)).rejects.toThrow("Only a file can be copied.");
    await expect(copyFileToClipboard(join(folder, "missing.md"))).rejects.toThrow();
    expect(native.write).not.toHaveBeenCalled();
  });
});
