import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discardChanges, getLatest, gitStatus, keepDiscardedCopy, linkedPaths, mergeText, previewCombine, pushWasOutrun, upload } from "./git";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const originalChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");

let root: string;
/** The remote that both clones upload to. */
let remote: string;
/** Downpad's clone. */
let mine: string;
/** Someone else's clone. */
let theirs: string;

/** Run git in `cwd` for the test's own setup, as a person would. */
function run(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

async function clone(name: string, author: string): Promise<string> {
  const folder = join(root, name);
  run(root, "clone", "--quiet", remote, folder);
  run(folder, "config", "user.name", author);
  run(folder, "config", "user.email", `${author.toLowerCase().replace(/\s/g, ".")}@example.com`);
  run(folder, "config", "commit.gpgsign", "false");
  return folder;
}

/** Commit `files` in `folder` and push them, as another Git user would. */
async function pushFrom(folder: string, files: Record<string, string>, message = "Change"): Promise<void> {
  run(folder, "pull", "--quiet", "--ff-only");
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(folder, name, ".."), { recursive: true });
    await writeFile(join(folder, name), text);
  }
  execFileSync("git", ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
    cwd: folder,
    input: `${Object.keys(files).join("\0")}\0`,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" },
  });
  run(folder, "commit", "--quiet", "-m", message);
  run(folder, "push", "--quiet");
}

/** A file's text with line feeds only. Git for Windows checks files out with
 *  CRLF line endings by default. */
async function text(path: string): Promise<string> {
  return (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
}

const NOTES = "# Notes\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "downpad-git-test-"));
  remote = join(root, "remote.git");
  run(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  const seed = await clone("seed", "Seed");
  await writeFile(join(seed, "notes.md"), NOTES);
  await writeFile(join(seed, "other.md"), "Other\n");
  await writeFile(join(seed, ".gitignore"), "ignored.md\n");
  run(seed, "add", ".");
  run(seed, "commit", "--quiet", "-m", "Start");
  run(seed, "push", "--quiet", "origin", "HEAD:main");
  mine = await clone("mine", "Me");
  theirs = await clone("theirs", "Anna Berg");
}, 30_000);

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(childProcess.spawn).mockReset();
  await rm(root, { recursive: true, force: true });
});

/** Enforce Windows' command size limit while running actual Git commands. */
function limitGitCommandLength(): void {
  vi.mocked(childProcess.spawn).mockImplementation((command, args, options) => {
    if (command === "git" && args && args.join(" ").length > 30_000) {
      throw Object.assign(new Error("spawn ENAMETOOLONG"), { code: "ENAMETOOLONG" });
    }
    return originalChildProcess.spawn(command, args, options);
  });
}

/** Enough real file paths to exceed Windows' command size limit in one call. */
function manyPaths(): string[] {
  return Array.from({ length: 400 }, (_, index) => `attachments/${index.toString().padStart(4, "0")}-${"a".repeat(90)}.png`);
}

const notes = () => join(mine, "notes.md");
const open = (unsaved = false) => [{ path: notes(), unsaved }];

describe("gitStatus", () => {
  it("offers nothing outside a repository, for ignored files or without a remote branch", async () => {
    const loose = join(root, "loose.md");
    await writeFile(loose, "Loose\n");
    expect(await gitStatus(loose, { fetch: false })).toBeNull();
    await writeFile(join(mine, "ignored.md"), "Ignored\n");
    expect(await gitStatus(join(mine, "ignored.md"), { fetch: false })).toBeNull();
    const local = join(root, "local");
    run(root, "init", "--quiet", local);
    await writeFile(join(local, "a.md"), "A\n");
    expect(await gitStatus(join(local, "a.md"), { fetch: false })).toBeNull();
  });

  it("reports local changes and who changed the document on the remote", async () => {
    const clean = await gitStatus(notes(), { fetch: true });
    expect(clean).toMatchObject({ branch: "main", changed: false, ahead: 0, behind: 0, remoteChange: null, fetchError: null });

    await pushFrom(theirs, { "notes.md": NOTES.replace("First", "1st") });
    await writeFile(notes(), NOTES.replace("Third", "3rd"));
    const status = await gitStatus(notes(), { fetch: true });
    expect(status).toMatchObject({ changed: true, behind: 1, remoteChange: { author: "Anna Berg" } });
  });

  it("reports a failed fetch without failing", async () => {
    run(mine, "remote", "set-url", "origin", join(root, "missing.git"));
    const status = await gitStatus(notes(), { fetch: true });
    expect(status?.fetchError).toMatch(/Git reported|cannot reach/);
  });
});

describe("getLatest", () => {
  it("checks every path before getting a large remote update", async () => {
    const paths = manyPaths();
    await pushFrom(theirs, Object.fromEntries(paths.map((path) => [path, "Remote\n"])));
    const blocked = paths.at(-1)!;
    await mkdir(join(mine, "attachments"));
    await writeFile(join(mine, blocked), "Mine\n");
    const head = run(mine, "rev-parse", "HEAD");
    limitGitCommandLength();

    expect(await getLatest(notes(), open(), false)).toEqual({
      kind: "blocked",
      files: [await realpath(join(mine, blocked))],
      changedOpenFiles: [],
    });
    expect(run(mine, "rev-parse", "HEAD")).toBe(head);
    expect(await text(join(mine, blocked))).toBe("Mine\n");

    await rm(join(mine, blocked));
    expect(await getLatest(notes(), open(), false)).toMatchObject({ kind: "done" });
    expect(await text(join(mine, paths[0]!))).toBe("Remote\n");
    expect(await text(join(mine, blocked))).toBe("Remote\n");
  }, 30_000);

  it("explains an operating system failure and retains its diagnostics", async () => {
    await pushFrom(theirs, { "other.md": "Theirs\n" });
    vi.mocked(childProcess.spawn).mockImplementation((command, args, options) => {
      if (args?.includes("status")) throw Object.assign(new Error("spawn ENAMETOOLONG"), { code: "ENAMETOOLONG" });
      return originalChildProcess.spawn(command, args, options);
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await getLatest(notes(), open(), false);
    expect(result).toMatchObject({ kind: "failed", message: expect.stringContaining("file path or command was too long") });
    expect(logged).toHaveBeenCalledWith("Downpad Git action failed", expect.objectContaining({ code: "ENAMETOOLONG" }));
    expect(await text(join(mine, "other.md"))).toBe("Other\n");
  });

  it("fast-forwards and names the open documents that changed", async () => {
    await pushFrom(theirs, { "notes.md": NOTES.replace("First", "1st") });
    const result = await getLatest(notes(), open(), false);
    expect(result).toEqual({ kind: "done", uploaded: false, changedOpenFiles: [notes()], combinedWith: null });
    expect(await readFile(notes(), "utf8")).toContain("1st paragraph");
  });

  it("never replaces an open document with unsaved changes", async () => {
    await pushFrom(theirs, { "notes.md": NOTES.replace("First", "1st") });
    const result = await getLatest(notes(), open(true), false);
    expect(result).toEqual({ kind: "blocked", files: [notes()], changedOpenFiles: [] });
    expect(await text(notes())).toBe(NOTES);
  });

  it("never replaces another file's changes that are not uploaded", async () => {
    await pushFrom(theirs, { "other.md": "Changed\n" });
    await writeFile(join(mine, "other.md"), "Mine\n");
    const result = await getLatest(notes(), open(), false);
    // Git names the file by its real path, which on Windows can be the long
    // form of a short temporary folder name.
    expect(result).toEqual({ kind: "blocked", files: [await realpath(join(mine, "other.md"))], changedOpenFiles: [] });
    expect(await text(join(mine, "other.md"))).toBe("Mine\n");
  });

  it("combines saved changes to other lines with the remote's", async () => {
    await pushFrom(theirs, { "notes.md": NOTES.replace("First", "1st") });
    await writeFile(notes(), NOTES.replace("Third", "3rd").replace(/\n/g, "\r\n"));
    const result = await getLatest(notes(), open(), true);
    expect(result).toMatchObject({ kind: "done", combinedWith: "Anna Berg" });
    // The combined text keeps the file's line endings.
    expect(await readFile(notes(), "utf8")).toBe(NOTES.replace("First", "1st").replace("Third", "3rd").replace(/\n/g, "\r\n"));
    expect(run(mine, "rev-parse", "HEAD")).toBe(run(mine, "rev-parse", "origin/main"));
  });

  it("reports a conflict for changes to the same lines and changes nothing", async () => {
    await pushFrom(theirs, { "notes.md": NOTES.replace("First paragraph", "Their paragraph") });
    const mineText = NOTES.replace("First paragraph", "My paragraph");
    await writeFile(notes(), mineText);
    const head = run(mine, "rev-parse", "HEAD");
    // The preview compares with the remote's version from the last fetch.
    await gitStatus(notes(), { fetch: true });
    expect(await previewCombine(notes(), mineText)).toEqual({ clean: false });
    expect(await previewCombine(notes(), NOTES.replace("Third", "3rd"))).toEqual({ clean: true });
    const result = await getLatest(notes(), open(), true);
    expect(result).toMatchObject({ kind: "conflict", author: "Anna Berg" });
    expect(await text(notes())).toBe(mineText);
    expect(run(mine, "rev-parse", "HEAD")).toBe(head);
  });

  it("says when there is nothing new", async () => {
    expect(await getLatest(notes(), open(), false)).toEqual({ kind: "up-to-date", changedOpenFiles: [] });
  });
});

describe("upload", () => {
  it("uploads many linked files in one commit and preserves unrelated staged changes", async () => {
    const paths = [...manyPaths(), "attachments/[literal].png"];
    await mkdir(join(mine, "attachments"));
    for (const path of paths) await writeFile(join(mine, path), "png");
    await writeFile(join(mine, "attachments", "l.png"), "Not linked\n");
    await writeFile(join(mine, "other.md"), "Staged change\n");
    run(mine, "add", "--", "other.md");
    await writeFile(notes(), `${NOTES}\n${paths.map((path) => `![](${path})`).join("\n")}\n`);
    const head = run(mine, "rev-parse", "HEAD");
    run(mine, "config", "remote.origin.pushurl", join(root, "missing.git"));
    limitGitCommandLength();

    expect(await upload(notes(), open())).toMatchObject({ kind: "failed" });
    expect(run(mine, "rev-parse", "HEAD")).toBe(head);
    expect(run(mine, "diff", "--cached", "--name-only")).toBe("other.md\n");
    expect(await text(join(mine, paths.at(-1)!))).toBe("png");

    run(mine, "config", "--unset", "remote.origin.pushurl");
    expect(await upload(notes(), open())).toMatchObject({ kind: "done", uploaded: true });
    expect(run(remote, "rev-list", "--count", "main").trim()).toBe("2");
    expect(run(mine, "diff", "--cached", "--name-only")).toBe("other.md\n");
    run(theirs, "pull", "--quiet", "--ff-only");
    expect(await text(join(theirs, paths.at(-1)!))).toBe("png");
    expect(run(theirs, "ls-files", "attachments").trim().split("\n")).toHaveLength(paths.length);
  }, 30_000);

  it("commits and pushes only the document and the new files it links to", async () => {
    await mkdir(join(mine, "attachments"));
    await writeFile(join(mine, "attachments", "a b.png"), "png");
    await writeFile(join(mine, "unrelated.txt"), "Not linked\n");
    await writeFile(join(mine, "credentials.json"), "secret");
    await writeFile(join(mine, "other.md"), "Other, not uploaded\n");
    await mkdir(join(mine, "docs"));
    await writeFile(join(mine, "docs", "private.txt"), "Private\n");
    // A file named in the text or in code is no link, and a link to a
    // folder sends nothing in it.
    await writeFile(notes(), `${NOTES}\nNever upload credentials.json.\n\n\`[x](unrelated.txt)\` [Docs](docs/)\n\n![](attachments/a%20b.png)\n`);

    expect(await upload(notes(), open())).toEqual({ kind: "done", uploaded: true, changedOpenFiles: [], combinedWith: null });
    run(theirs, "pull", "--quiet", "--ff-only");
    expect(await readFile(join(theirs, "notes.md"), "utf8")).toContain("a%20b.png");
    expect(await text(join(theirs, "attachments", "a b.png"))).toBe("png");
    expect(run(theirs, "log", "-1", "--format=%s%n%an")).toBe("Update notes.md\nMe\n");
    expect(run(mine, "status", "--porcelain")).toBe(" M other.md\n?? credentials.json\n?? docs/\n?? unrelated.txt\n");
    expect(await gitStatus(notes(), { fetch: false })).toMatchObject({ changed: false, ahead: 0, behind: 0 });
  });

  it("adds a new document", async () => {
    const fresh = join(mine, "docs", "new.md");
    await mkdir(join(mine, "docs"));
    await writeFile(fresh, "New\n");
    expect(await upload(fresh, [{ path: fresh, unsaved: false }])).toMatchObject({ kind: "done", uploaded: true });
    expect(run(remote, "log", "-1", "--format=%s", "main")).toBe("Add docs/new.md\n");
  });

  it("gets the latest version first and combines the document", async () => {
    await pushFrom(theirs, { "notes.md": NOTES.replace("First", "1st"), "other.md": "Theirs\n" });
    await writeFile(notes(), NOTES.replace("Third", "3rd"));
    const result = await upload(notes(), open());
    expect(result).toEqual({ kind: "done", uploaded: true, changedOpenFiles: [notes()], combinedWith: "Anna Berg" });
    run(theirs, "pull", "--quiet", "--ff-only");
    expect(await text(join(theirs, "notes.md"))).toBe(NOTES.replace("First", "1st").replace("Third", "3rd"));
  });

  it("reports a conflict without committing or pushing", async () => {
    await pushFrom(theirs, { "notes.md": NOTES.replace("Second paragraph", "Their second") });
    const mineText = NOTES.replace("Second paragraph", "My second");
    await writeFile(notes(), mineText);
    const head = run(mine, "rev-parse", "HEAD");
    expect(await upload(notes(), open())).toMatchObject({ kind: "conflict", author: "Anna Berg" });
    expect(run(mine, "rev-parse", "HEAD")).toBe(head);
    expect(await text(notes())).toBe(mineText);
  });

  it("starts again when someone uploads between the check and the push", async () => {
    // The pre-push hook uploads someone else's change once, while Downpad's
    // push waits, so the remote rejects that push.
    const hook = join(mine, ".git", "hooks", "pre-push");
    const marker = join(root, "raced");
    await writeFile(hook, [
      "#!/bin/sh",
      `if [ ! -e '${marker}' ]; then`,
      `  touch '${marker}'`,
      `  cd '${theirs}' && git pull -q --ff-only && echo Theirs > other.md && git commit -qam Race && git push -q`,
      "  exit 0",
      "fi",
    ].join("\n"));
    await chmod(hook, 0o755);
    await writeFile(notes(), NOTES.replace("Third", "3rd"));

    const result = await upload(notes(), open());
    expect(result, JSON.stringify(result)).toMatchObject({ kind: "done", uploaded: true });
    run(mine, "fetch", "--quiet");
    expect(run(mine, "log", "--format=%s", "origin/main", "-3")).toBe("Update notes.md\nRace\nStart\n");
    expect(await text(join(mine, "other.md"))).toBe("Theirs\n");
  }, 30_000);

  it("takes its commit back when the push fails", async () => {
    await writeFile(notes(), NOTES.replace("Third", "3rd"));
    const head = run(mine, "rev-parse", "HEAD");
    // Fetching still works, but the push is refused.
    run(mine, "config", "remote.origin.pushurl", join(root, "missing.git"));
    const result = await upload(notes(), open());
    expect(result.kind).toBe("failed");
    expect(run(mine, "rev-parse", "HEAD")).toBe(head);
    expect(run(mine, "status", "--porcelain")).toBe(" M notes.md\n");
  });

  it("names the open documents it got changes for, also when the push then fails", async () => {
    await pushFrom(theirs, { "other.md": "Theirs\n" });
    await writeFile(notes(), NOTES.replace("Third", "3rd"));
    run(mine, "config", "remote.origin.pushurl", join(root, "missing.git"));
    const other = join(mine, "other.md");
    const result = await upload(notes(), [...open(), { path: other, unsaved: false }]);
    expect(result).toMatchObject({ kind: "failed", changedOpenFiles: [other] });
    expect(await text(other)).toBe("Theirs\n");
  });

  it("says when there is nothing to upload", async () => {
    expect(await upload(notes(), open())).toEqual({ kind: "up-to-date", changedOpenFiles: [] });
  });
});

describe("discardChanges", () => {
  it("puts the remote's version in place of the document", async () => {
    await pushFrom(theirs, { "notes.md": NOTES.replace("First paragraph", "Their paragraph") });
    await writeFile(notes(), NOTES.replace("First paragraph", "My paragraph"));
    const result = await discardChanges(notes(), open(true));
    expect(result).toMatchObject({ kind: "done" });
    expect(await text(notes())).toBe(NOTES.replace("First paragraph", "Their paragraph"));
    expect(run(mine, "status", "--porcelain")).toBe("");
  });
});

describe("discardChanges with commits that are not uploaded", () => {
  it("leaves changes in another Git program's commits alone", async () => {
    await pushFrom(theirs, { "notes.md": NOTES.replace("First paragraph", "Their paragraph") });
    await writeFile(notes(), NOTES.replace("First paragraph", "My paragraph"));
    run(mine, "commit", "--quiet", "-am", "Mine, not uploaded");
    const result = await discardChanges(notes(), open());
    expect(result).toMatchObject({ kind: "failed", changedOpenFiles: [] });
    expect(await readFile(notes(), "utf8")).toContain("My paragraph");
  });
});

describe("linkedPaths", () => {
  it("finds the paths of links, images, link definitions and HTML, and nothing in prose or code", () => {
    const text = [
      "Never upload credentials.json or [notes](https://example.com/a.png).",
      "",
      "![a](attachments/a%20b.png \"Title\") [b](<docs/my file.pdf>) [c](#top) [d](/abs.png) [e](notes.md#part)",
      "",
      "[ref]: ./ref.png",
      "",
      "`![code](code.png)`",
      "",
      "```",
      "![fenced](fenced.png)",
      "```",
      "",
      '<img src="html.png"> <a href=\'page.html?x=1\'>x</a> <https://example.com/auto.png>',
      "",
      '<div title="src=../credentials.json">Text</div> <img alt="a > b" src=late.png> <!-- <img src="comment.png"> -->',
    ].join("\n");
    expect(linkedPaths(text, "/work")).toEqual(
      ["/work/attachments/a b.png", "/work/docs/my file.pdf", "/work/notes.md", "/work/ref.png", "/work/html.png", "/work/page.html", "/work/late.png"]
        .map((path) => resolve(path)),
    );
  });
});

describe("mergeText", () => {
  it("combines changes to different lines and refuses changes to the same line", async () => {
    const base = "a\n\nb\n\nc\n";
    expect(await mergeText(base, "A\n\nb\n\nc\n", "a\n\nb\n\nC\n")).toBe("A\n\nb\n\nC\n");
    expect(await mergeText(base, "A\n\nb\n\nc\n", "a2\n\nb\n\nc\n")).toBeNull();
    expect(await mergeText(base, base, "x\n")).toBe("x\n");
  });
});

describe("pushWasOutrun", () => {
  it("recognizes a push that someone else's upload beat", () => {
    expect(pushWasOutrun("To github.com:a/b.git\n!\tHEAD:refs/heads/main\t[rejected] (fetch first)\nDone\n")).toBe(true);
    expect(pushWasOutrun("!\tHEAD:refs/heads/main\t[rejected] (non-fast-forward)\n")).toBe(true);
    expect(pushWasOutrun("!\tHEAD:refs/heads/main\t[remote rejected] (incorrect old value provided)\n")).toBe(true);
    expect(pushWasOutrun("!\tHEAD:refs/heads/main\t[remote rejected] (protected branch hook declined)\n")).toBe(false);
    expect(pushWasOutrun("fatal: Authentication failed for 'https://github.com/a/b.git/'\n")).toBe(false);
  });
});

describe("keepDiscardedCopy", () => {
  it("keeps a copy and deletes copies older than 30 days", async () => {
    const data = join(root, "profile");
    const old = join(data, "discarded-changes", "old notes.md");
    await mkdir(join(data, "discarded-changes"), { recursive: true });
    await writeFile(old, "Old\n");
    const past = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await utimes(old, past, past);
    const copy = await keepDiscardedCopy(data, notes(), "Mine\n");
    expect(await readFile(copy, "utf8")).toBe("Mine\n");
    expect(await readdir(join(data, "discarded-changes"))).toEqual([copy.split(/[\\/]/).pop()]);
  });
});
