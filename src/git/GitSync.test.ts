// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitFileStatus, GitOpenFile, GitSyncResult } from "../ipc/contracts";
import { createAppStore } from "../app/createAppStore";
import type { Store } from "../state/store";
import { DEFAULT_SETTINGS } from "../settings/defaults";
import type { ConflictChoice, ConflictDialogOptions } from "./ConflictDialog";
import { GIT_GET_LATEST, GIT_OPEN_COPY, GIT_RESOLVE, GitSync, type GitSyncDependencies } from "./GitSync";

const git = vi.hoisted(() => ({
  status: vi.fn<(path: string, fetch: boolean) => Promise<GitFileStatus | null>>(),
  preview: vi.fn<(path: string, markdown: string) => Promise<{ clean: boolean }>>(),
  getLatest: vi.fn<(path: string, openFiles: GitOpenFile[], interactive: boolean) => Promise<GitSyncResult>>(),
  upload: vi.fn<(path: string, openFiles: GitOpenFile[]) => Promise<GitSyncResult>>(),
  discard: vi.fn<(path: string, openFiles: GitOpenFile[]) => Promise<GitSyncResult>>(),
  keepCopy: vi.fn<(path: string, content: string) => Promise<string>>(),
}));

vi.mock("../ipc/commands", () => ({
  gitStatus: git.status,
  gitPreviewCombine: git.preview,
  gitGetLatest: git.getLatest,
  gitUpload: git.upload,
  gitDiscard: git.discard,
  keepDiscardedCopy: git.keepCopy,
}));

const PATH = "/work/notes.md";
const clean: GitFileStatus = {
  repositoryRoot: "/work",
  branch: "main",
  changed: false,
  unuploadedCommits: 0,
  ahead: 0,
  behind: 0,
  remoteChange: null,
  fetchError: null,
  unfinishedOperation: false,
};
const remoteChange = { commit: "abc", author: "Anna Berg", timeMs: Date.now() - 5 * 60_000 };
const behind: GitFileStatus = { ...clean, behind: 1, remoteChange };
const done = (changedOpenFiles: string[] = [], extra: Partial<Extract<GitSyncResult, { kind: "done" }>> = {}): GitSyncResult =>
  ({ kind: "done", uploaded: false, changedOpenFiles, combinedWith: null, ...extra });

let store: Store;
let deps: GitSyncDependencies & {
  files: { [K in keyof GitSyncDependencies["files"]]: ReturnType<typeof vi.fn> };
  askConflict: ReturnType<typeof vi.fn<(options: ConflictDialogOptions) => Promise<ConflictChoice>>>;
};
let sync: GitSync;

/** Open `PATH` in the store's only tab, with `markdown` saved or, with `unsaved`, edited. */
function openDocument({ unsaved = false } = {}): void {
  const doc = {
    ...store.get().doc,
    filePath: PATH,
    markdown: unsaved ? "# Notes\n\nMine\n" : "# Notes\n",
    savedMarkdown: "# Notes\n",
    isDirty: unsaved,
  };
  store.replaceActiveDoc(doc);
}

/** Hold an operation until a test changes the setting or document. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** Change the master switch without changing the saved Git preferences. */
function enableGit(gitEnabled: boolean): void {
  store.set({ settings: { ...store.get().settings, gitEnabled } });
}

beforeEach(() => {
  window.downpadDesktop = { platform: "linux" } as unknown as NonNullable<typeof window.downpadDesktop>;
  for (const mock of Object.values(git)) mock.mockReset();
  store = createAppStore();
  deps = {
    store,
    files: {
      save: vi.fn(async () => {
        store.patchDoc({ isDirty: false, savedMarkdown: store.get().doc.markdown });
        return true;
      }),
      saveAs: vi.fn(async () => true),
      openPath: vi.fn(async () => {}),
      openBeside: vi.fn(async () => {}),
      refreshFromDisk: vi.fn(async () => true),
      // As FileService does: the tab takes the file only if its text is the kept one.
      replaceFromDisk: vi.fn(async (tabId: string, path: string, kept: (markdown: string) => boolean) => {
        const tab = store.get().tabs.find((entry) => entry.id === tabId && entry.doc.filePath === path);
        if (!tab) return "gone" as const;
        if (!kept(tab.doc.markdown)) return "changed" as const;
        store.patchDocById(tabId, { markdown: "# Theirs\n", savedMarkdown: "# Theirs\n", isDirty: false });
        return "shown" as const;
      }),
    },
    flush: vi.fn(),
    discardEditors: vi.fn(async () => {}),
    keepingPlace: vi.fn(async (reload: () => Promise<void>) => reload()),
    askConflict: vi.fn(async () => "later" as ConflictChoice),
  };
  sync = new GitSync(deps);
});

afterEach(() => {
  sync.dispose();
  vi.useRealTimers();
  delete window.downpadDesktop;
});

describe("GitSync enable setting", () => {
  it("does no Git work while disabled and resumes checks with the saved preferences", async () => {
    vi.useFakeTimers();
    openDocument({ unsaved: true });
    const document = store.get().doc;
    store.set({ settings: { ...DEFAULT_SETTINGS, gitEnabled: false, gitAutoGetLatest: false, gitUploadOnSave: true } });
    git.status.mockResolvedValue(behind);
    sync.start();
    await sync.check({ force: true });
    await sync.upload();
    await sync.getLatest();
    sync.afterUserSave(PATH);
    sync.handleBannerAction(GIT_GET_LATEST);
    window.dispatchEvent(new Event("focus"));
    store.patchDoc({ modifiedMs: 123 });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(git.status).not.toHaveBeenCalled();
    expect(git.upload).not.toHaveBeenCalled();
    expect(git.getLatest).not.toHaveBeenCalled();
    expect(deps.files.save).not.toHaveBeenCalled();
    expect(store.get().doc.markdown).toBe(document.markdown);
    expect(store.get().doc.isDirty).toBe(true);

    enableGit(true);
    git.preview.mockResolvedValue({ clean: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(git.status).toHaveBeenCalledWith(PATH, true);
    expect(store.get().git?.path).toBe(PATH);
    expect(store.get().settings).toMatchObject({ gitAutoGetLatest: false, gitUploadOnSave: true });
    enableGit(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(store.get().git).toBeNull();
    expect(store.get().banner).toBeNull();
  });

  it("clears only its own notice when disabled", async () => {
    openDocument();
    store.set({ settings: { ...DEFAULT_SETTINGS, gitAutoGetLatest: false } });
    git.status.mockResolvedValue(behind);
    sync.start();
    await vi.waitFor(() => expect(store.get().banner?.actions?.[0].id).toBe(GIT_GET_LATEST));
    enableGit(false);
    expect(store.get().banner).toBeNull();

    enableGit(true);
    await vi.waitFor(() => expect(store.get().banner?.actions?.[0].id).toBe(GIT_GET_LATEST));
    const unrelated = { kind: "error" as const, message: "The document could not be saved." };
    store.set({ banner: unrelated });
    enableGit(false);
    expect(store.get().banner).toBe(unrelated);
    expect(store.get().git).toBeNull();
  });

  it("ignores an old local status after Git is turned off and back on", async () => {
    openDocument();
    const status = deferred<GitFileStatus | null>();
    git.status.mockReturnValueOnce(status.promise).mockResolvedValue(clean);
    sync.start();
    enableGit(false);
    enableGit(true);
    await vi.waitFor(() => expect(store.get().git?.status).toEqual(clean));
    status.resolve(behind);
    await vi.waitFor(() => expect(git.status).toHaveBeenCalledTimes(3));
    expect(store.get().git?.status).toEqual(clean);
    expect(store.get().banner).toBeNull();
    expect(git.getLatest).not.toHaveBeenCalled();
  });

  it.each(["resolved", "rejected"])("ignores a %s old fetch after Git is turned off and back on", async (outcome) => {
    openDocument();
    const status = deferred<GitFileStatus | null>();
    git.status.mockResolvedValueOnce(clean).mockReturnValueOnce(status.promise).mockResolvedValue(clean);
    sync.start();
    await vi.waitFor(() => expect(git.status).toHaveBeenCalledWith(PATH, true));
    enableGit(false);
    enableGit(true);
    await vi.waitFor(() => expect(git.status).toHaveBeenCalledTimes(4));
    if (outcome === "resolved") status.resolve(behind);
    else status.reject(new Error("Command failed with private Git details"));
    await Promise.resolve();
    expect(store.get().git).toMatchObject({ status: clean, problem: null });
    expect(store.get().banner).toBeNull();
    expect(git.getLatest).not.toHaveBeenCalled();
  });

  it("ignores a conflict preview from before Git was disabled", async () => {
    openDocument({ unsaved: true });
    const preview = deferred<{ clean: boolean }>();
    git.status.mockResolvedValue(behind);
    git.preview.mockReturnValueOnce(preview.promise);
    sync.start();
    await vi.waitFor(() => expect(git.preview).toHaveBeenCalledTimes(1));
    enableGit(false);
    git.status.mockResolvedValue(clean);
    enableGit(true);
    preview.resolve({ clean: false });
    await vi.waitFor(() => expect(store.get().git?.status).toEqual(clean));
    expect(deps.askConflict).not.toHaveBeenCalled();
    expect(store.get().banner).toBeNull();
  });

  it("drops queued requests and late action notices but reloads changed files without losing typing", async () => {
    openDocument();
    const original = store.get().activeTabId!;
    const background = store.addTab({ ...store.get().doc, filePath: "/work/other.md" });
    store.activateTab(original);
    store.set({ settings: { ...DEFAULT_SETTINGS, gitUploadOnSave: true } });
    git.status.mockResolvedValue(clean);
    sync.start();
    await vi.waitFor(() => expect(store.get().git).not.toBeNull());
    const upload = deferred<GitSyncResult>();
    git.upload.mockReturnValueOnce(upload.promise).mockResolvedValue(done());
    const first = sync.upload();
    await vi.waitFor(() => expect(git.upload).toHaveBeenCalledTimes(1));
    sync.afterUserSave(PATH);
    const queued = sync.getLatest();
    enableGit(false);
    enableGit(true);
    store.patchDoc({ markdown: "# Typing during upload\n", isDirty: true });
    upload.resolve(done([PATH, "/work/other.md"], { combinedWith: "Anna Berg" }));
    await Promise.all([first, queued]);
    expect(git.upload).toHaveBeenCalledTimes(1);
    expect(git.getLatest).not.toHaveBeenCalled();
    expect(deps.files.refreshFromDisk).toHaveBeenCalledWith(background);
    expect(deps.discardEditors).toHaveBeenCalledWith(background);
    expect(deps.files.openPath).not.toHaveBeenCalled();
    expect(store.get().doc.markdown).toBe("# Typing during upload\n");
    expect(store.get().banner).toBeNull();
    expect(store.get().git?.activity).toBeNull();
    sync.afterUserSave(PATH);
    await vi.waitFor(() => expect(git.upload).toHaveBeenCalledTimes(2));
  });

  it("lets an already started save finish without uploading after Git is disabled", async () => {
    openDocument({ unsaved: true });
    git.status.mockResolvedValue(clean);
    sync.start();
    await vi.waitFor(() => expect(store.get().git).not.toBeNull());
    const save = deferred<boolean>();
    deps.files.save.mockImplementation(async () => {
      await save.promise;
      store.patchDoc({ savedMarkdown: store.get().doc.markdown, isDirty: false });
      return true;
    });
    const upload = sync.upload();
    await vi.waitFor(() => expect(deps.files.save).toHaveBeenCalledTimes(1));
    enableGit(false);
    save.resolve(true);
    await upload;
    expect(git.upload).not.toHaveBeenCalled();
    expect(store.get().doc).toMatchObject({ markdown: "# Notes\n\nMine\n", savedMarkdown: "# Notes\n\nMine\n", isDirty: false });
    expect(store.get().git).toBeNull();
    expect(store.get().banner).toBeNull();
  });

  it("does not act on a conflict choice from before Git was disabled", async () => {
    openDocument({ unsaved: true });
    git.status.mockResolvedValue(behind);
    git.preview.mockResolvedValue({ clean: false });
    const choice = deferred<ConflictChoice>();
    deps.askConflict.mockReturnValueOnce(choice.promise);
    sync.start();
    await vi.waitFor(() => expect(deps.askConflict).toHaveBeenCalledTimes(1));
    enableGit(false);
    git.status.mockResolvedValue(clean);
    enableGit(true);
    choice.resolve("discard");
    await vi.waitFor(() => expect(store.get().git?.status).toEqual(clean));
    expect(git.keepCopy).not.toHaveBeenCalled();
    expect(git.discard).not.toHaveBeenCalled();
    expect(store.get().doc.isDirty).toBe(true);
    expect(store.get().banner).toBeNull();
  });

  it("does not begin discarding after Git is disabled while a safety copy is saved", async () => {
    openDocument({ unsaved: true });
    git.status.mockResolvedValue(behind);
    git.preview.mockResolvedValue({ clean: false });
    deps.askConflict.mockResolvedValue("discard");
    const copy = deferred<string>();
    git.keepCopy.mockReturnValueOnce(copy.promise);
    sync.start();
    await vi.waitFor(() => expect(git.keepCopy).toHaveBeenCalledTimes(1));
    enableGit(false);
    copy.resolve("/profile/discarded-changes/notes.md");
    await Promise.resolve();
    expect(git.discard).not.toHaveBeenCalled();
    expect(deps.files.replaceFromDisk).not.toHaveBeenCalled();
    expect(store.get().doc.markdown).toBe("# Notes\n\nMine\n");
    expect(store.get().banner).toBeNull();
  });

  it("keeps newer typing before completing a discard that started before Git was disabled", async () => {
    openDocument({ unsaved: true });
    git.status.mockResolvedValue(behind);
    git.preview.mockResolvedValue({ clean: false });
    deps.askConflict.mockResolvedValue("discard");
    git.keepCopy.mockResolvedValue("/profile/discarded-changes/notes.md");
    const discard = deferred<GitSyncResult>();
    git.discard.mockReturnValueOnce(discard.promise);
    sync.start();
    await vi.waitFor(() => expect(git.discard).toHaveBeenCalledTimes(1));
    enableGit(false);
    store.patchDoc({ markdown: "# More typing\n" });
    discard.resolve(done([PATH]));
    await vi.waitFor(() => expect(deps.files.replaceFromDisk).toHaveBeenCalledTimes(2));
    expect(git.keepCopy).toHaveBeenLastCalledWith(PATH, "# More typing\n");
    expect(store.get().doc.markdown).toBe("# Theirs\n");
    expect(store.get().git).toBeNull();
    expect(store.get().banner).toBeNull();
  });
});

describe("GitSync checks", () => {
  it("offers nothing for a document outside a repository", async () => {
    openDocument();
    git.status.mockResolvedValue(null);
    await sync.check({ force: true });
    expect(store.get().git).toBeNull();
    expect(git.status).toHaveBeenCalledTimes(1);
  });

  it("explains unexpected fetch failures without displaying raw process errors", async () => {
    openDocument();
    git.status.mockResolvedValueOnce(clean).mockRejectedValueOnce(new Error("spawn git ENAMETOOLONG"));
    await sync.check({ force: true });
    expect(store.get().git?.problem).toContain("a file path or command was too long");
    expect(store.get().git?.problem).not.toContain("ENAMETOOLONG");
  });

  it("gets remote changes quietly when nothing that is not uploaded would change", async () => {
    openDocument();
    git.status.mockImplementation(async (_path, fetch) => (fetch ? behind : clean));
    git.getLatest.mockResolvedValue(done([PATH]));
    await sync.check({ force: true });
    expect(git.getLatest).toHaveBeenCalledWith(PATH, [{ path: PATH, unsaved: false }], false);
    expect(deps.files.openPath).toHaveBeenCalledWith(PATH, { reload: true });
    expect(store.get().banner).toBeNull();
  });

  it("only tells the user about remote changes when Get latest automatically is off", async () => {
    openDocument();
    store.set({ settings: { ...DEFAULT_SETTINGS, gitAutoGetLatest: false } });
    git.status.mockImplementation(async (_path, fetch) => (fetch ? behind : clean));
    await sync.check({ force: true });
    expect(git.getLatest).not.toHaveBeenCalled();
    expect(store.get().banner).toMatchObject({
      kind: "remote-changed",
      message: "Anna Berg changed this document 5 minutes ago.",
      actions: [{ id: GIT_GET_LATEST }],
    });
  });

  it("offers to combine remote changes with unsaved changes to other parts", async () => {
    openDocument({ unsaved: true });
    git.status.mockImplementation(async (_path, fetch) => (fetch ? behind : clean));
    git.preview.mockResolvedValue({ clean: true });
    await sync.check({ force: true });
    expect(git.preview).toHaveBeenCalledWith(PATH, "# Notes\n\nMine\n");
    expect(git.getLatest).not.toHaveBeenCalled();
    expect(deps.askConflict).not.toHaveBeenCalled();
    expect(store.get().banner?.actions).toEqual([{ id: GIT_GET_LATEST, label: "Get latest" }]);

    // Get latest saves the changes first, then combines them.
    git.getLatest.mockResolvedValue(done([PATH], { combinedWith: "Anna Berg" }));
    git.status.mockResolvedValue(clean);
    expect(sync.handleBannerAction(GIT_GET_LATEST)).toBe(true);
    await vi.waitFor(() => expect(git.getLatest).toHaveBeenCalledWith(PATH, [{ path: PATH, unsaved: false }], true));
    expect(deps.files.save).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(store.get().banner?.message).toBe("Downpad combined Anna Berg's changes with yours. Upload to share the result."));
  });

  it("asks once about overlapping changes, then keeps a notice", async () => {
    openDocument({ unsaved: true });
    git.status.mockImplementation(async (_path, fetch) => (fetch ? behind : clean));
    git.preview.mockResolvedValue({ clean: false });
    await sync.check({ force: true });
    expect(deps.askConflict).toHaveBeenCalledWith({ fileName: "notes.md", author: "Anna Berg", timeMs: remoteChange.timeMs });
    expect(store.get().banner).toMatchObject({ actions: [{ id: GIT_RESOLVE }] });

    store.set({ banner: null });
    await sync.check({ force: true });
    expect(deps.askConflict).toHaveBeenCalledTimes(1);
    expect(store.get().banner).toMatchObject({ actions: [{ id: GIT_RESOLVE }] });
  });
});

describe("GitSync conflicts", () => {
  beforeEach(() => {
    openDocument({ unsaved: true });
    git.status.mockImplementation(async (_path, fetch) => (fetch ? behind : clean));
    git.preview.mockResolvedValue({ clean: false });
  });

  it("keeps a copy of discarded changes and shows the latest version", async () => {
    deps.askConflict.mockResolvedValue("discard");
    git.keepCopy.mockResolvedValue("/profile/discarded-changes/notes.md");
    git.discard.mockResolvedValue(done([PATH]));
    await sync.check({ force: true });
    expect(git.keepCopy).toHaveBeenCalledWith(PATH, "# Notes\n\nMine\n");
    expect(git.discard).toHaveBeenCalledWith(PATH, []);
    expect(deps.files.replaceFromDisk).toHaveBeenCalledTimes(1);
    expect(store.get().doc.markdown).toBe("# Theirs\n");
    expect(store.get().banner).toMatchObject({ kind: "info", actions: [{ id: GIT_OPEN_COPY }] });
    sync.handleBannerAction(GIT_OPEN_COPY);
    expect(deps.files.openPath).toHaveBeenLastCalledWith("/profile/discarded-changes/notes.md");
  });

  it("keeps a newer copy when the user typed while Git ran", async () => {
    deps.askConflict.mockResolvedValue("discard");
    git.keepCopy.mockResolvedValueOnce("/profile/discarded-changes/first.md");
    git.keepCopy.mockResolvedValueOnce("/profile/discarded-changes/latest.md");
    git.discard.mockImplementation(async () => {
      store.patchDoc({ markdown: "# Notes\n\nMine, and more\n" });
      return done([PATH]);
    });
    await sync.check({ force: true });
    expect(git.keepCopy).toHaveBeenLastCalledWith(PATH, "# Notes\n\nMine, and more\n");
    expect(deps.files.replaceFromDisk).toHaveBeenCalledTimes(2);
    expect(store.get().doc.markdown).toBe("# Theirs\n");
    sync.handleBannerAction(GIT_OPEN_COPY);
    expect(deps.files.openPath).toHaveBeenLastCalledWith("/profile/discarded-changes/latest.md");
  });

  it("leaves a document that was saved under another name while Git ran alone", async () => {
    deps.askConflict.mockResolvedValue("discard");
    git.keepCopy.mockResolvedValue("/profile/discarded-changes/notes.md");
    git.discard.mockImplementation(async () => {
      store.patchDoc({ filePath: "/work/renamed.md", markdown: "# Renamed, with more\n" });
      return done([PATH]);
    });
    await sync.check({ force: true });
    expect(store.get().doc).toMatchObject({ filePath: "/work/renamed.md", markdown: "# Renamed, with more\n" });
  });

  it("leaves an overlap with another Git program's commits to that program", async () => {
    git.status.mockImplementation(async (_path, fetch) => (fetch ? { ...behind, ahead: 1, unuploadedCommits: 1 } : clean));
    await sync.check({ force: true });
    expect(deps.askConflict).not.toHaveBeenCalled();
    expect(store.get().banner).toMatchObject({ kind: "error" });
    expect(store.get().banner?.message).toContain("another Git program");
  });

  it("discards nothing when it cannot keep a copy", async () => {
    deps.askConflict.mockResolvedValue("discard");
    git.keepCopy.mockRejectedValue(new Error("Disk full"));
    await sync.check({ force: true });
    expect(git.discard).not.toHaveBeenCalled();
    expect(store.get().banner?.kind).toBe("error");
  });

  it("saves the user's version as a new file and opens the latest original beside it", async () => {
    deps.askConflict.mockResolvedValue("save-as");
    deps.files.saveAs.mockImplementation(async () => {
      store.patchDoc({ filePath: "/work/notes (my version).md", isDirty: false });
      return true;
    });
    git.discard.mockResolvedValue(done());
    await sync.check({ force: true });
    expect(deps.files.saveAs).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "/work/notes (my version).md" }));
    const { refuse } = deps.files.saveAs.mock.calls[0][0] as { refuse(path: string): boolean };
    expect(refuse(PATH)).toBe(true);
    expect(refuse("/work/mine.md")).toBe(false);
    expect(git.discard).toHaveBeenCalledWith(PATH, [{ path: "/work/notes (my version).md", unsaved: false }]);
    expect(deps.files.openBeside).toHaveBeenCalledWith(PATH, store.get().activeTabId);
    expect(store.get().banner?.message).toBe("Your version is saved as “notes (my version).md”. The latest “notes.md” is open in the next tab.");
  });
});

describe("GitSync upload", () => {
  beforeEach(() => {
    git.status.mockResolvedValue({ ...clean, changed: true });
  });

  it("saves the document first, then uploads it", async () => {
    openDocument({ unsaved: true });
    await sync.check();
    git.upload.mockResolvedValue(done([], { uploaded: true }));
    await sync.upload();
    expect(deps.files.save).toHaveBeenCalledTimes(1);
    expect(git.upload).toHaveBeenCalledWith(PATH, [{ path: PATH, unsaved: false }]);
    expect(store.get().banner).toBeNull();
  });

  it("uploads after a save only when Upload when saving is on", async () => {
    openDocument();
    await sync.check();
    git.upload.mockResolvedValue(done([], { uploaded: true }));
    sync.afterUserSave(PATH);
    expect(git.upload).not.toHaveBeenCalled();

    store.set({ settings: { ...DEFAULT_SETTINGS, gitUploadOnSave: true } });
    sync.afterUserSave(PATH);
    await vi.waitFor(() => expect(git.upload).toHaveBeenCalledTimes(1));
    // A save never asks to save again.
    expect(deps.files.save).not.toHaveBeenCalled();
  });

  it("explains a failed upload", async () => {
    openDocument();
    await sync.check();
    git.upload.mockResolvedValue({ kind: "failed", message: "Git could not sign in to github.com.", changedOpenFiles: [] });
    await sync.upload();
    expect(store.get().banner).toEqual({ kind: "error", message: "Upload failed. Git could not sign in to github.com." });
  });

  it("explains unexpected upload errors without displaying raw process errors", async () => {
    openDocument();
    await sync.check();
    git.upload.mockRejectedValue(new Error("spawn git ENAMETOOLONG"));
    await sync.upload();
    expect(store.get().banner?.message).toContain("Upload failed. Git could not complete this action because a file path or command was too long.");
    expect(store.get().banner?.message).not.toContain("ENAMETOOLONG");
  });

  it("uploads after the first save into a repository, before Downpad knew the repository", async () => {
    openDocument();
    store.set({ settings: { ...DEFAULT_SETTINGS, gitUploadOnSave: true } });
    expect(store.get().git).toBeNull();
    git.upload.mockResolvedValue(done([], { uploaded: true }));
    sync.afterUserSave(PATH);
    await vi.waitFor(() => expect(git.upload).toHaveBeenCalledWith(PATH, [{ path: PATH, unsaved: false }]));
  });

  it("uploads the saved document after a running action, also once another tab is active", async () => {
    openDocument();
    await sync.check();
    store.set({ settings: { ...DEFAULT_SETTINGS, gitUploadOnSave: true } });
    let finishFirst!: (result: GitSyncResult) => void;
    git.upload.mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)));
    git.upload.mockResolvedValue(done([], { uploaded: true }));
    const first = sync.upload();
    await vi.waitFor(() => expect(git.upload).toHaveBeenCalledTimes(1));
    sync.afterUserSave(PATH);
    store.addTab({ ...store.get().doc, filePath: "/work/other.md" });
    finishFirst(done([], { uploaded: true }));
    await first;
    await vi.waitFor(() => expect(git.upload).toHaveBeenCalledTimes(2));
    expect(git.upload.mock.calls[1][0]).toBe(PATH);
  });

  it("reloads the documents an upload changed before it failed", async () => {
    openDocument();
    const background = store.get().activeTabId!;
    store.addTab({ ...store.get().doc, filePath: "/work/notes2.md" });
    store.activateTab(background);
    await sync.check();
    git.upload.mockResolvedValue({ kind: "failed", message: "No connection.", changedOpenFiles: ["/work/notes2.md"] });
    await sync.upload();
    const other = store.get().tabs.find((tab) => tab.doc.filePath === "/work/notes2.md")!;
    expect(deps.files.refreshFromDisk).toHaveBeenCalledWith(other.id);
    expect(deps.discardEditors).toHaveBeenCalledWith(other.id);
    expect(store.get().banner?.message).toBe("Upload failed. No connection.");
  });

  it("asks about a conflict that the upload ran into", async () => {
    openDocument();
    await sync.check();
    git.upload.mockResolvedValue({ kind: "conflict", author: "Anna Berg", timeMs: remoteChange.timeMs, changedOpenFiles: [] });
    await sync.upload();
    expect(deps.askConflict).toHaveBeenCalledTimes(1);
  });
});

describe("GitSync start", () => {
  it("checks again when the user returns from the Recent view", async () => {
    openDocument();
    git.status.mockResolvedValue(clean);
    sync.start();
    await vi.waitFor(() => expect(store.get().git?.path).toBe(PATH));
    store.set({ view: "recent" });
    await vi.waitFor(() => expect(store.get().git).toBeNull());
    store.set({ view: "wysiwyg" });
    await vi.waitFor(() => expect(store.get().git?.path).toBe(PATH));
  });
});
