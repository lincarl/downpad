// Git support for people who do not use Git: Upload (commit and push one
// document) and Get latest (fast-forward to the remote branch). Every command
// runs the system `git` without a shell, one operation at a time for each
// repository, and never forces anything on the remote. See docs/design.md, Git.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { GFM, parser as markdownParser } from "@lezer/markdown";
import type { GitFileStatus, GitOpenFile, GitOutcome, GitSyncResult } from "../src/ipc/contracts";
import { readMarkdown, writeAtomic, writeMarkdown } from "./io";

/** The repository, branch and remote branch of one document. */
interface GitContext {
  /** The work tree's top folder. */
  root: string;
  /** The repository's own folder, such as `<root>/.git`. */
  gitDir: string;
  /** The document's real path, without symbolic links. */
  file: string;
  /** The document's path from `root`, with forward slashes, as Git names it. */
  rel: string;
  branch: string;
  /** The remote that the branch uploads to, such as `origin`. */
  remote: string;
  /** The remote branch, such as `refs/heads/main`. */
  mergeRef: string;
}

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

interface RunOptions {
  cwd: string;
  /** Whether Git may ask the user to sign in, for an action the user started. */
  interactive?: boolean;
  /** Whether repository hooks run. Only Upload's commit and push run them. */
  hooks?: boolean;
  /** Run SSH in batch mode, so a background fetch fails rather than waits for
   *  an answer. Only for repositories with no SSH command of their own. */
  batchSsh?: boolean;
  /** Read paths as plain paths, never as patterns. Off only for commands that
   *  take no pathspecs and reject the setting, such as `check-ignore`. */
  literalPaths?: boolean;
  timeoutMs?: number;
}

/** Git output is small except for a document's text, which Downpad caps far lower. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Uploads that the remote rejects because someone uploaded first are retried this often. */
const UPLOAD_ATTEMPTS = 3;
/** Copies of discarded changes are kept this long. */
const DISCARDED_COPY_DAYS = 30;

let gitMissing = false;
let noHooksDirectory: Promise<string> | undefined;
const repositoryQueues = new Map<string, Promise<unknown>>();

/** An empty folder that `core.hooksPath` points at, so no hook runs. */
function hooklessDirectory(): Promise<string> {
  noHooksDirectory ??= mkdtemp(join(tmpdir(), "downpad-no-hooks-"));
  return noHooksDirectory;
}

/**
 * Run `git` with `args`. Git never prompts on a terminal. A background command
 * also never shows a sign-in window, and on POSIX every command runs in its
 * own session, so SSH cannot wait for a passphrase on the terminal Downpad was
 * started from. The repository's file system monitor never runs, and hooks
 * run only when `hooks` asks for them.
 */
async function git(args: string[], options: RunOptions): Promise<RunResult> {
  if (gitMissing) throw new GitUnavailable();
  const config = ["-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "-c", "color.ui=false"];
  if (!options.hooks) config.push("-c", `core.hooksPath=${await hooklessDirectory()}`);
  if (!options.interactive) config.push("-c", "credential.interactive=never");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    // Hooks run their own Git commands, which must read patterns as usual,
    // so commands that run hooks mark their paths literal one by one.
    GIT_LITERAL_PATHSPECS: options.literalPaths === false || options.hooks ? "0" : "1",
    // Downpad reads Git's messages, so they must not be translated.
    LC_ALL: "C",
    LANGUAGE: "",
  };
  if (!options.interactive) {
    env.GCM_INTERACTIVE = "never";
    env.SSH_ASKPASS_REQUIRE = "never";
    if (options.batchSsh && !env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", [...config, ...args], {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    const stop = (): void => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill();
      } catch {
        // The process has ended already.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs ?? (options.interactive ? 300_000 : 60_000));
    const collect = (target: Buffer[]) => (chunk: Buffer): void => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) stop();
      else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        gitMissing = true;
        reject(new GitUnavailable());
      } else reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const message = Buffer.concat(stderr).toString("utf8");
      if (timedOut) {
        reject(new GitError("Git did not finish in time.", message));
        return;
      }
      resolvePromise({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: message });
    });
  });
}

/** Run `git` and return its output as text, or throw a GitError when it fails. */
async function gitText(args: string[], options: RunOptions): Promise<string> {
  const result = await git(args, options);
  if (result.code !== 0) throw new GitError(explainGitError(result.stderr), result.stderr);
  return result.stdout.toString("utf8");
}

/** Raised when no `git` program can be started. */
class GitUnavailable extends Error {
  constructor() {
    super("Git is not installed.");
  }
}

/** A failed Git command, with a message for the user and Git's own output. */
class GitError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
  }
}

/** Turn Git's error output into a sentence for someone who does not use Git. */
export function explainGitError(stderr: string): string {
  const text = stderr.trim();
  const host = /(?:https?:\/\/(?:[^@/\s]+@)?|@)([a-z0-9.-]+\.[a-z]{2,})/i.exec(text)?.[1];
  const server = host ?? "the server";
  if (/please tell me who you are|unable to auto-detect email address|empty ident name/i.test(text)) {
    return 'Git does not know your name and email yet. Run git config --global user.name "Your Name" and git config --global user.email "you@example.com" in a terminal, then try again.';
  }
  if (/protected branch|GH006|pre-receive hook declined|not allowed to push|permission to .* denied to/i.test(text)) {
    return `${server} does not let you upload to this branch. Ask the repository's owner for access.`;
  }
  if (/authentication failed|could not read (username|password)|terminal prompts disabled|permission denied \(publickey|invalid username or password|HTTP Basic: Access denied|returned error: 40[13]/i.test(text)) {
    return `Git could not sign in to ${server}. Sign in with your Git tool, then try again.`;
  }
  if (/could not resolve host|unable to access|failed to connect|connection timed out|network is unreachable|could not read from remote repository|connection refused|operation timed out|host key verification failed/i.test(text)) {
    return `Downpad cannot reach ${server}. Check the internet connection, then try again.`;
  }
  if (/index\.lock|unable to create .*\.lock/i.test(text)) {
    return "Another Git program is using this repository. Try again in a moment.";
  }
  // Prefer Git's own error lines, then a rejected branch's reason from
  // `push --porcelain`, over progress lines such as "To <remote>".
  const lines = text.split("\n").map((entry) => entry.trim()).filter(Boolean);
  const error = lines.find((entry) => /^(fatal|error):/.test(entry))?.replace(/^(fatal|error):\s*/, "");
  const rejected = lines.find((entry) => entry.startsWith("!"))?.match(/\(([^)]*)\)\s*$/)?.[1];
  const line = error ?? (rejected ? `the upload was rejected (${rejected})` : lines[0]);
  return line ? `Git reported: ${line}` : "Git failed without saying why.";
}

/** Run `operation` after the earlier operations on the same repository. */
function inRepository<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  const previous = repositoryQueues.get(key) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  const settled = next.then(() => {}, () => {});
  repositoryQueues.set(key, settled);
  void settled.then(() => {
    if (repositoryQueues.get(key) === settled) repositoryQueues.delete(key);
  });
  return next;
}

/** Whether a folder or one of its parents holds `.git`. Downpad never starts
 *  Git for a document outside a repository. */
async function insideRepository(folder: string): Promise<boolean> {
  for (let current = folder; ; current = dirname(current)) {
    if (await stat(join(current, ".git")).then(() => true, () => false)) return true;
    if (dirname(current) === current) return false;
  }
}

/**
 * The repository of the document at `path`, or null when Downpad offers no
 * Git actions for it: Git is missing, the document is outside a work tree or
 * ignored, the repository belongs to another user, or the branch has no
 * remote branch to upload to.
 */
async function contextOf(path: string): Promise<GitContext | null> {
  const file = await realpath(path).catch(() => null);
  if (!file || !(await insideRepository(dirname(file)))) return null;
  const folder = dirname(file);
  try {
    const [rootLine, gitDirLine] = (await gitText(["rev-parse", "--show-toplevel", "--absolute-git-dir"], { cwd: folder }))
      .split("\n");
    if (!rootLine || !gitDirLine) return null;
    const root = resolve(rootLine);
    const branch = (await gitText(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root })).trim();
    const remote = (await gitText(["config", "--get", `branch.${branch}.remote`], { cwd: root })).trim();
    const mergeRef = (await gitText(["config", "--get", `branch.${branch}.merge`], { cwd: root })).trim();
    // A branch that tracks another local branch has nothing to upload to.
    if (!remote || remote === "." || !mergeRef.startsWith("refs/heads/")) return null;
    const rel = relative(root, file).split(sep).join("/");
    if (!rel || rel.startsWith("../")) return null;
    // check-ignore exits with 1 for a file that is not ignored.
    const ignored = await git(["check-ignore", "--quiet", "--", rel], { cwd: root, literalPaths: false });
    if (ignored.code !== 1) return null;
    return { root, gitDir: resolve(gitDirLine), file, rel, branch, remote, mergeRef };
  } catch {
    return null;
  }
}

/** Fetch the branch's remote. Returns why it failed, or null. */
async function fetchRemote(context: GitContext, interactive: boolean): Promise<string | null> {
  // An SSH command that the user configured stays in charge of signing in.
  const sshCommand = interactive ? null : await git(["config", "--get", "core.sshCommand"], { cwd: context.root });
  const result = await git(["fetch", "--quiet", "--no-tags", context.remote], {
    cwd: context.root,
    interactive,
    batchSsh: sshCommand?.code !== 0,
    timeoutMs: interactive ? 300_000 : 45_000,
  }).catch((error: unknown) => ({ code: -1, stdout: Buffer.alloc(0), stderr: error instanceof Error ? error.message : String(error) }));
  return result.code === 0 ? null : explainGitError(result.stderr);
}

/** Commits that are here and not on the remote branch, and the reverse. */
async function aheadBehind(context: GitContext): Promise<{ ahead: number; behind: number }> {
  const result = await git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd: context.root });
  // A remote branch that is gone, or not fetched yet, has nothing to get.
  if (result.code !== 0) return { ahead: 0, behind: 0 };
  const [ahead, behind] = result.stdout.toString("utf8").trim().split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}

/** The files, as absolute paths, that the remote branch changed since it and
 *  this branch parted. */
async function remoteChanges(context: GitContext): Promise<string[]> {
  const output = await gitText(["diff", "--name-only", "--no-renames", "-z", "HEAD...@{upstream}"], { cwd: context.root });
  return output.split("\0").filter(Boolean).map((name) => join(context.root, ...name.split("/")));
}

/** Who made the newest remote change to the document, and when. */
async function remoteChangeAuthor(context: GitContext): Promise<{ commit: string; author: string; timeMs: number } | null> {
  const output = await gitText(["log", "-1", "--format=%H%x00%an%x00%ct", "HEAD..@{upstream}", "--", context.rel], { cwd: context.root });
  const [commit, author, time] = output.trim().split("\0");
  if (!commit) return null;
  return { commit, author: author || "Someone", timeMs: Number(time) * 1000 || Date.now() };
}

/** Entries of `git status` for `paths`, or for the whole work tree when
 *  `paths` is null: changed, staged or new files, as absolute paths. */
async function changedFiles(context: GitContext, paths: string[] | null): Promise<string[]> {
  if (paths?.length === 0) return [];
  const output = await gitText(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", ...(paths ? ["--", ...paths] : [])],
    { cwd: context.root },
  );
  const entries = output.split("\0");
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.length < 4) continue;
    files.push(join(context.root, ...entry.slice(3).split("/")));
  }
  return files;
}

/** A root-relative Git path for an absolute path in the work tree. */
function gitPath(context: GitContext, path: string): string {
  return relative(context.root, path).split(sep).join("/");
}

/** Whether the commit `revision` holds the document. */
async function hasFile(context: GitContext, revision: string): Promise<boolean> {
  return (await git(["cat-file", "-e", `${revision}:${context.rel}`], { cwd: context.root })).code === 0;
}

/** The document's text at `revision`, with line feeds only, or "" when the
 *  commit does not hold it. */
async function fileAt(context: GitContext, revision: string): Promise<string> {
  const result = await git(["cat-file", "blob", `${revision}:${context.rel}`], { cwd: context.root });
  if (result.code !== 0) return "";
  return normalizeText(result.stdout);
}

/** Text as Downpad holds it: without a byte order mark, with line feeds only. */
function normalizeText(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  return (text.startsWith("﻿") ? text.slice(1) : text).replace(/\r\n?/g, "\n");
}

/** Whether two absolute paths name the same file here. */
function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** The real paths of the open documents, with the path each was opened by. */
async function realOpenFiles(openFiles: readonly GitOpenFile[]): Promise<Array<GitOpenFile & { real: string }>> {
  return Promise.all(openFiles.map(async (open) => ({ ...open, real: await realpath(open.path).catch(() => resolve(open.path)) })));
}

/**
 * Combine three versions of a text line by line, as Git merges. Returns
 * null when the two sides changed the same or neighbouring lines.
 */
export async function mergeText(base: string, ours: string, theirs: string): Promise<string | null> {
  if (ours === theirs || base === theirs) return ours;
  if (base === ours) return theirs;
  const folder = await mkdtemp(join(tmpdir(), "downpad-merge-"));
  try {
    const [oursFile, baseFile, theirsFile] = ["ours", "base", "theirs"].map((name) => join(folder, name));
    await Promise.all([writeFile(oursFile, ours), writeFile(baseFile, base), writeFile(theirsFile, theirs)]);
    const result = await git(["merge-file", "-p", "-q", oursFile, baseFile, theirsFile], { cwd: folder });
    if (result.code === 0) return result.stdout.toString("utf8");
    if (result.code > 0 && result.code < 128) return null;
    throw new GitError(explainGitError(result.stderr), result.stderr);
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}

/** What Git reports about the document at `path`, or null when Downpad offers
 *  no Git actions for it. `fetch` first asks the remote for new commits. */
export async function gitStatus(path: string, { fetch, interactive = false }: { fetch: boolean; interactive?: boolean }): Promise<GitFileStatus | null> {
  const context = await contextOf(path);
  if (!context) return null;
  return inRepository(context.root, async () => {
    const fetchError = fetch ? await fetchRemote(context, interactive) : null;
    const { ahead, behind } = await aheadBehind(context);
    const changed = (await changedFiles(context, [context.rel])).length > 0;
    const unuploaded = ahead === 0 ? 0 : Number((await gitText(
      ["rev-list", "--count", "@{upstream}..HEAD", "--", context.rel],
      { cwd: context.root },
    )).trim()) || 0;
    const remoteChange = behind > 0 && (await remoteChanges(context)).some((file) => samePath(file, context.file))
      ? await remoteChangeAuthor(context)
      : null;
    return {
      repositoryRoot: context.root,
      branch: context.branch,
      changed,
      unuploadedCommits: unuploaded,
      ahead,
      behind,
      remoteChange,
      fetchError,
      unfinishedOperation: await unfinishedOperation(context),
    };
  });
}

/** Whether a merge, rebase or similar that another Git program started is
 *  still waiting to be finished. */
async function unfinishedOperation(context: GitContext): Promise<boolean> {
  const markers = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"];
  const found = await Promise.all(markers.map((name) => stat(join(context.gitDir, name)).then(() => true, () => false)));
  return found.some(Boolean);
}

/** Whether the document's text combines cleanly with the remote's version.
 *  `ours` is the document as the editor holds it. */
export async function previewCombine(path: string, ours: string): Promise<{ clean: boolean }> {
  const context = await contextOf(path);
  if (!context) return { clean: false };
  return inRepository(context.root, async () => {
    const base = (await gitText(["merge-base", "HEAD", "@{upstream}"], { cwd: context.root })).trim();
    const merged = await mergeText(await fileAt(context, base), ours, await fileAt(context, "@{upstream}"));
    return { clean: merged !== null };
  });
}

/** Results of bringing the branch up to date before the caller goes on. */
type Integration =
  | { kind: "integrated"; changedOpenFiles: string[]; combinedWith: string | null }
  | Exclude<GitOutcome, { kind: "done" | "up-to-date" }>;

/**
 * Bring the branch up to the remote branch, which has `behind` commits that it
 * lacks. Open documents with unsaved changes, and other files with changes
 * that are not uploaded, that the remote changed block it, so nothing that is
 * not uploaded is ever replaced. The document itself, when changed both here
 * and on the remote, is combined line by line, or reported as a conflict
 * without a change.
 */
async function integrate(context: GitContext, ahead: number, openFiles: readonly GitOpenFile[]): Promise<Integration> {
  const changed = await remoteChanges(context);
  const open = await realOpenFiles(openFiles);
  const unsavedOpen = open.filter((file) => file.unsaved && changed.some((path) => samePath(path, file.real)));
  if (unsavedOpen.length > 0) return { kind: "blocked", files: unsavedOpen.map((file) => file.path) };
  const changedHere = await changedFiles(context, changed.map((path) => gitPath(context, path)));
  const documentChanged = changedHere.some((path) => samePath(path, context.file));
  const others = changedHere.filter((path) => !samePath(path, context.file));
  if (others.length > 0) return { kind: "blocked", files: others };
  const changedOpenFiles = open.filter((file) => changed.some((path) => samePath(path, file.real))).map((file) => file.path);

  if (ahead > 0) {
    // Commits that another Git program made here and did not upload are
    // merged, as `git pull` would. Downpad leaves no such commits itself.
    if (documentChanged) return { kind: "failed", message: UNUPLOADED_COMMITS };
    const merged = await git(["merge", "--no-edit", "@{upstream}"], { cwd: context.root });
    if (merged.code !== 0) {
      await git(["merge", "--abort"], { cwd: context.root });
      return { kind: "failed", message: UNUPLOADED_COMMITS };
    }
    return { kind: "integrated", changedOpenFiles, combinedWith: null };
  }

  if (!documentChanged) {
    await gitText(["merge", "--ff-only", "--quiet", "@{upstream}"], { cwd: context.root });
    return { kind: "integrated", changedOpenFiles, combinedWith: null };
  }

  // The document changed here and on the remote: combine the saved text with
  // the remote's, then put the result in place of the remote's version.
  const ours = await readMarkdown(context.file);
  const merged = await mergeText(await fileAt(context, "HEAD"), ours.content, await fileAt(context, "@{upstream}"));
  const change = await remoteChangeAuthor(context);
  if (merged === null || !(await hasFile(context, "@{upstream}"))) {
    return { kind: "conflict", author: change?.author ?? "Someone", timeMs: change?.timeMs ?? Date.now() };
  }
  if (await hasFile(context, "HEAD")) await gitText(["checkout", "HEAD", "--", context.rel], { cwd: context.root });
  else await unlink(context.file);
  const forward = await git(["merge", "--ff-only", "--quiet", "@{upstream}"], { cwd: context.root });
  if (forward.code !== 0) {
    await writeMarkdown(context.file, ours.content, ours.eol);
    throw new GitError(explainGitError(forward.stderr), forward.stderr);
  }
  await writeMarkdown(context.file, merged, ours.eol);
  return { kind: "integrated", changedOpenFiles, combinedWith: merged === ours.content ? null : change?.author ?? "Someone" };
}

/** Why Downpad leaves commits that another Git program made to that program. */
const UNUPLOADED_COMMITS =
  "This repository has commits that another Git program made and did not upload, and Downpad cannot combine them with the latest version. Upload or combine them with that Git program first.";

/** Reject actions while another Git program has left the repository mid-merge. */
async function readyForChanges(context: GitContext): Promise<GitOutcome | null> {
  if (await unfinishedOperation(context)) {
    return { kind: "failed", message: "Another Git program left a merge or rebase unfinished in this repository. Finish it there first." };
  }
  return null;
}

/** Report an unexpected error as a failed result. */
function failure(error: unknown): GitOutcome {
  if (error instanceof GitUnavailable) return { kind: "failed", message: "Git is not installed." };
  return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
}

/** Run a Git action on the document at `path` in its repository's queue.
 *  The action records the open documents whose files it changes in
 *  `changedOpenFiles`, which the result reports however the action ends. */
async function action(
  path: string,
  run: (context: GitContext, changedOpenFiles: string[]) => Promise<GitOutcome>,
): Promise<GitSyncResult> {
  const context = await contextOf(path);
  if (!context) {
    return { kind: "failed", message: "This document is no longer in a Git repository with a remote branch.", changedOpenFiles: [] };
  }
  return inRepository(context.root, async () => {
    const changedOpenFiles: string[] = [];
    let outcome: GitOutcome;
    try {
      const blocked = await readyForChanges(context);
      outcome = blocked ?? (await run(context, changedOpenFiles));
    } catch (error) {
      outcome = failure(error);
    }
    return { ...outcome, changedOpenFiles: [...new Set(changedOpenFiles)] };
  });
}

/**
 * Get latest: fetch the remote and bring the branch up to date with it. A
 * document changed both here and on the remote is combined, or reported as a
 * conflict. `openFiles` lists the open documents, which are reloaded or
 * protected.
 */
export function getLatest(path: string, openFiles: readonly GitOpenFile[], interactive: boolean): Promise<GitSyncResult> {
  return action(path, async (context, changedOpenFiles) => {
    const fetchError = await fetchRemote(context, interactive);
    if (fetchError) return { kind: "failed", message: fetchError };
    const { ahead, behind } = await aheadBehind(context);
    if (behind === 0) return { kind: "up-to-date" };
    const result = await integrate(context, ahead, openFiles);
    if (result.kind !== "integrated") return result;
    changedOpenFiles.push(...result.changedOpenFiles);
    return { kind: "done", uploaded: false, combinedWith: result.combinedWith };
  });
}

/**
 * Discard the document's changes that are not uploaded, then get latest.
 * The caller keeps a copy of the changes first (`keepDiscardedCopy`). Once
 * the file is put back, the result lists `path` among the changed files,
 * however the rest ends. Changes in commits that another Git program made
 * are not discarded.
 */
export function discardChanges(path: string, openFiles: readonly GitOpenFile[]): Promise<GitSyncResult> {
  return action(path, async (context, changedOpenFiles) => {
    const fetchError = await fetchRemote(context, true);
    if (fetchError) return { kind: "failed", message: fetchError };
    const committed = Number((await git(["rev-list", "--count", "@{upstream}..HEAD", "--", context.rel], { cwd: context.root }))
      .stdout.toString("utf8").trim()) || 0;
    if (committed > 0) return { kind: "failed", message: UNUPLOADED_COMMITS };
    if (await hasFile(context, "HEAD")) {
      await gitText(["checkout", "HEAD", "--", context.rel], { cwd: context.root });
      changedOpenFiles.push(path);
    } else if (await hasFile(context, "@{upstream}")) {
      await unlink(context.file);
      changedOpenFiles.push(path);
    }
    const { ahead, behind } = await aheadBehind(context);
    if (behind === 0) return { kind: "done", uploaded: false, combinedWith: null };
    const others = openFiles.filter((file) => !samePath(resolve(file.path), resolve(path)));
    const result = await integrate(context, ahead, others);
    if (result.kind !== "integrated") return result;
    changedOpenFiles.push(...result.changedOpenFiles);
    return { kind: "done", uploaded: false, combinedWith: null };
  });
}

const markdown = markdownParser.configure(GFM);
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The local paths that a document's links and images point to: the
 * destinations of Markdown links, images and link definitions, and the `src`
 * and `href` of HTML tags. Code and plain text name no path, so a file name
 * mentioned in prose is never one. Web addresses, absolute paths and links
 * within the document are left out.
 */
export function linkedPaths(text: string, folder: string): string[] {
  const destinations: string[] = [];
  markdown.parse(text).iterate({
    enter(node) {
      const source = text.slice(node.from, node.to);
      if (node.name === "URL" && node.node.parent?.name !== "Autolink") {
        destinations.push(source.replace(/^<|>$/g, ""));
      } else if (node.name === "HTMLTag" || node.name === "HTMLBlock") {
        destinations.push(...htmlLinks(source));
      }
    },
  });
  const paths: string[] = [];
  for (const destination of destinations) {
    const link = destination.trim().replace(/\\([!-/:-@[-`{-~])/g, "$1").replace(/[?#].*$/, "");
    if (!link || SCHEME.test(link) || /^[\\/]/.test(link)) continue;
    let decoded = link;
    try {
      decoded = decodeURIComponent(link);
    } catch {
      // A stray % stays as written.
    }
    paths.push(resolve(folder, decoded));
  }
  return paths;
}

/**
 * The values of the `src` and `href` attributes of the tags in `html`. Each
 * tag's attributes are read in order, so text in another attribute's value,
 * such as `title="src=a.png"`, or in a comment, is no link.
 */
function htmlLinks(html: string): string[] {
  const links: string[] = [];
  const text = html.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const tag = /<[a-z][a-z0-9-]*/gi;
  const attribute = /\s+([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
  const end = /\s*\/?>/y;
  for (let start = tag.exec(text); start; start = tag.exec(text)) {
    let at = start.index + start[0].length;
    for (;;) {
      end.lastIndex = at;
      if (end.test(text)) {
        at = end.lastIndex;
        break;
      }
      attribute.lastIndex = at;
      const match = attribute.exec(text);
      if (!match) break;
      at = attribute.lastIndex;
      const name = match[1]!.toLowerCase();
      if (name === "src" || name === "href") links.push(match[2] ?? match[3] ?? match[4] ?? "");
    }
    // The next tag starts after this one, never inside its attribute values.
    tag.lastIndex = at;
  }
  return links;
}

/** Files that the document links to and that are new or changed, such as the
 *  images in its attachments folder, so Upload sends them along. Only the
 *  files themselves count, so a link to a folder sends nothing in it. */
async function linkedChanges(context: GitContext): Promise<string[]> {
  const folder = dirname(context.file);
  const linked = linkedPaths((await readMarkdown(context.file)).content, folder);
  const inWorkTree = linked
    .map((path) => gitPath(context, path))
    .filter((rel) => rel && !rel.startsWith("../") && rel !== context.rel);
  if (inWorkTree.length === 0) return [];
  const changed = await changedFiles(context, [...new Set(inWorkTree)]);
  return changed.filter((file) => linked.some((path) => samePath(path, file)));
}

/** Whether `git push --porcelain` output says that someone moved the remote
 *  branch on, before the push started or while it ran. */
export function pushWasOutrun(output: string): boolean {
  return /^!\t\S+\t\[(?:remote )?rejected\] \((?:fetch first|non-fast-forward|incorrect old value provided|stale info|failed to update ref|cannot lock ref[^)]*)\)/m
    .test(output);
}

/**
 * Upload: commit the saved document, and the new files it links to, and push
 * the commit. It first brings the branch up to date, combining the document
 * with remote changes when they touch other lines. If someone uploads in
 * between, the remote rejects the push; the commit is then taken back and the
 * whole upload runs again, at most UPLOAD_ATTEMPTS times. A push that fails
 * otherwise, or does not finish, also takes the commit back, so Downpad never
 * leaves commits that are not uploaded.
 */
export function upload(path: string, openFiles: readonly GitOpenFile[]): Promise<GitSyncResult> {
  return action(path, async (context, changedOpenFiles) => {
    let combinedWith: string | null = null;
    for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt++) {
      const fetchError = await fetchRemote(context, true);
      if (fetchError) return { kind: "failed", message: fetchError };
      let { ahead, behind } = await aheadBehind(context);
      if (behind > 0) {
        const result = await integrate(context, ahead, openFiles);
        if (result.kind !== "integrated") return result;
        changedOpenFiles.push(...result.changedOpenFiles);
        combinedWith ??= result.combinedWith;
        ({ ahead } = await aheadBehind(context));
      }

      const paths = [context.file, ...(await linkedChanges(context))].map((file) => gitPath(context, file));
      const toCommit = await changedFiles(context, paths);
      if (toCommit.length === 0 && ahead === 0) {
        return changedOpenFiles.length > 0 ? { kind: "done", uploaded: false, combinedWith } : { kind: "up-to-date" };
      }
      let commit: string | null = null;
      const committed = toCommit.map((file) => gitPath(context, file));
      if (committed.length > 0) {
        const isNew = !(await hasFile(context, "HEAD"));
        await gitText(["add", "--", ...committed], { cwd: context.root });
        const message = `${isNew ? "Add" : "Update"} ${context.rel}`;
        const result = await git(
          ["commit", "--quiet", "--only", "-m", message, "--", ...committed.map((file) => `:(literal)${file}`)],
          { cwd: context.root, hooks: true, interactive: true },
        ).catch(async (error: unknown) => {
          await git(["reset", "--quiet", "HEAD", "--", ...committed], { cwd: context.root }).catch(() => {});
          throw error;
        });
        if (result.code !== 0) {
          await git(["reset", "--quiet", "HEAD", "--", ...committed], { cwd: context.root });
          return { kind: "failed", message: explainGitError(result.stderr) };
        }
        commit = (await gitText(["rev-parse", "HEAD"], { cwd: context.root })).trim();
      }

      let pushed: RunResult;
      try {
        pushed = await git(
          ["push", "--porcelain", context.remote, `HEAD:${context.mergeRef}`],
          { cwd: context.root, hooks: true, interactive: true },
        );
      } catch (error) {
        // A push that does not finish, as after a timeout, takes its commit
        // back too. If the remote took it after all, the next Upload or Get
        // latest finds it there.
        if (commit) await takeBack(context, commit, committed).catch(() => {});
        throw error;
      }
      // A push also moves the remote branch that this branch tracks.
      if (pushed.code === 0) return { kind: "done", uploaded: true, combinedWith };
      if (commit) await takeBack(context, commit, committed);
      const output = `${pushed.stdout.toString("utf8")}\n${pushed.stderr}`;
      if (!pushWasOutrun(output)) return { kind: "failed", message: explainGitError(output) };
    }
    return { kind: "failed", message: "Others uploaded changes at the same time. Try again." };
  });
}

/** Undo Downpad's own commit `commit`, keeping its changes in the files, as
 *  they were before Upload. */
async function takeBack(context: GitContext, commit: string, paths: string[]): Promise<void> {
  const head = (await gitText(["rev-parse", "HEAD"], { cwd: context.root })).trim();
  if (head !== commit) return;
  await gitText(["reset", "--quiet", "--soft", "HEAD~1"], { cwd: context.root });
  await git(["reset", "--quiet", "HEAD", "--", ...paths], { cwd: context.root });
}

/**
 * Keep a copy of changes that the user is about to discard, in
 * `<userData>/discarded-changes`, and delete copies older than
 * DISCARDED_COPY_DAYS. Returns the copy's path.
 */
export async function keepDiscardedCopy(userData: string, path: string, content: string): Promise<string> {
  const folder = join(userData, "discarded-changes");
  await mkdir(folder, { recursive: true });
  const cutoff = Date.now() - DISCARDED_COPY_DAYS * 24 * 60 * 60 * 1000;
  for (const name of await readdir(folder).catch(() => [])) {
    const entry = join(folder, name);
    const info = await stat(entry).catch(() => null);
    if (info?.isFile() && info.mtimeMs < cutoff) await unlink(entry).catch(() => {});
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const copy = join(folder, `${stamp} ${basename(path)}`);
  await writeAtomic(copy, content);
  return copy;
}
