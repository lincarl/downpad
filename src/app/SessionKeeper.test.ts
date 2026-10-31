import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../ipc/contracts";
import { blankDoc } from "../state/types";
import { createAppStore } from "./createAppStore";
import { SessionKeeper, sessionOf } from "./SessionKeeper";

const native = vi.hoisted(() => ({ saveSession: vi.fn<(session: Session) => Promise<void>>() }));

vi.mock("../ipc/env", () => ({ isElectron: () => true }));
vi.mock("../ipc/commands", () => ({ saveSession: native.saveSession }));

const file = (filePath: string) => ({ ...blankDoc(), filePath, markdown: `# ${filePath}\n`, savedMarkdown: `# ${filePath}\n` });

/** A store whose tabs hold `a.md`, an untitled buffer and `b.md`, with the untitled one active. */
function setup() {
  const store = createAppStore();
  store.set({ tabs: [], activeTabId: null, doc: blankDoc() });
  const a = store.addTab(file("/docs/a.md"));
  const untitled = store.addTab(blankDoc());
  const b = store.addTab(file("/docs/b.md"));
  store.activateTab(untitled);
  return { store, keeper: new SessionKeeper(store), ids: { a, untitled, b } };
}

beforeEach(() => {
  native.saveSession.mockReset();
  native.saveSession.mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

describe("recording the open documents", () => {
  it("lists the files in tab order and the active one, leaving out untitled documents", () => {
    const { store, ids } = setup();
    expect(sessionOf(store.get())).toEqual({ files: ["/docs/a.md", "/docs/b.md"], active: null });
    store.activateTab(ids.b);
    expect(sessionOf(store.get())).toEqual({ files: ["/docs/a.md", "/docs/b.md"], active: "/docs/b.md" });
  });

  it("writes nothing before it starts, then every change to the documents but no other change", async () => {
    const { store, keeper, ids } = setup();
    store.activateTab(ids.a);
    expect(native.saveSession).not.toHaveBeenCalled();

    keeper.start();
    await keeper.flush();
    expect(native.saveSession.mock.calls).toEqual([[{ files: ["/docs/a.md", "/docs/b.md"], active: "/docs/a.md" }]]);

    // Typing changes nothing recorded, a switch to another file does.
    store.patchDoc({ markdown: "# Edited\n", isDirty: true });
    await keeper.flush();
    expect(native.saveSession).toHaveBeenCalledOnce();
    store.activateTab(ids.b);
    await keeper.flush();
    expect(native.saveSession.mock.calls.at(-1)).toEqual([{ files: ["/docs/a.md", "/docs/b.md"], active: "/docs/b.md" }]);
    expect(native.saveSession).toHaveBeenCalledTimes(2);

    keeper.dispose();
    store.activateTab(ids.a);
    await keeper.flush();
    expect(native.saveSession).toHaveBeenCalledTimes(2);
  });

  it("resolves a flush only once the last change is written", async () => {
    const { store, keeper, ids } = setup();
    keeper.start();
    let written!: () => void;
    native.saveSession.mockReturnValueOnce(new Promise<void>((resolve) => { written = resolve; }));
    store.activateTab(ids.a);
    let flushed = false;
    const flushing = keeper.flush().then(() => { flushed = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(flushed).toBe(false);
    written();
    await flushing;
    expect(native.saveSession.mock.calls.at(-1)).toEqual([{ files: ["/docs/a.md", "/docs/b.md"], active: "/docs/a.md" }]);
  });

  it("waits in a flush also for a change made while the write before it was under way", async () => {
    const { store, keeper, ids } = setup();
    keeper.start();
    await keeper.flush();
    let first!: () => void;
    let second!: () => void;
    native.saveSession
      .mockReturnValueOnce(new Promise<void>((resolve) => { first = resolve; }))
      .mockReturnValueOnce(new Promise<void>((resolve) => { second = resolve; }));
    store.activateTab(ids.a);
    let flushed = false;
    const flushing = keeper.flush().then(() => { flushed = true; });
    // A tab chosen while the window waits to close.
    store.activateTab(ids.b);
    first();
    await vi.waitFor(() => expect(native.saveSession).toHaveBeenCalledTimes(3));
    expect(flushed).toBe(false);
    second();
    await flushing;
    expect(native.saveSession.mock.calls.at(-1)).toEqual([{ files: ["/docs/a.md", "/docs/b.md"], active: "/docs/b.md" }]);
  });

  it("writes a session again after its write failed", async () => {
    const { keeper } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    native.saveSession.mockRejectedValueOnce(new Error("The disk is full."));
    keeper.start();
    await keeper.flush();
    expect(native.saveSession).toHaveBeenCalledOnce();
    await keeper.flush();
    expect(native.saveSession).toHaveBeenCalledTimes(2);
    expect(native.saveSession.mock.calls[1]).toEqual(native.saveSession.mock.calls[0]);
  });
});

describe("remembering temporarily unavailable documents", () => {
  const unavailable = "/offline/notes.md";

  it("keeps unavailable files in order and updates the active file after a tab switch", async () => {
    const { store, keeper, ids } = setup();
    const previous = { files: ["/docs/a.md", unavailable, "/docs/b.md"], active: unavailable };
    keeper.start(previous);
    await keeper.flush();
    expect(native.saveSession).toHaveBeenLastCalledWith(previous);

    store.activateTab(ids.b);
    store.closeTab(ids.a);
    await keeper.flush();
    expect(native.saveSession).toHaveBeenLastCalledWith({ files: [unavailable, "/docs/b.md"], active: "/docs/b.md" });
    keeper.dispose();
  });

  it("forgets a formerly unavailable file after it opens and the user closes it", async () => {
    const { store, keeper, ids } = setup();
    keeper.start({ files: [unavailable, "/docs/a.md", "/docs/b.md"], active: unavailable });
    const opened = store.addTab(file(unavailable));
    await keeper.flush();
    expect(native.saveSession).toHaveBeenLastCalledWith({ files: ["/docs/a.md", "/docs/b.md", unavailable], active: unavailable });

    store.closeTab(opened);
    store.activateTab(ids.b);
    await keeper.flush();
    expect(native.saveSession).toHaveBeenLastCalledWith({ files: ["/docs/a.md", "/docs/b.md"], active: "/docs/b.md" });
    keeper.dispose();
  });

  it("clears unavailable files when the user closes every tab", async () => {
    const { store, keeper } = setup();
    keeper.start({ files: [unavailable, "/docs/a.md", "/docs/b.md"], active: unavailable });
    for (const tab of store.get().tabs) store.closeTab(tab.id);
    await keeper.flush();
    expect(native.saveSession).toHaveBeenLastCalledWith({ files: [], active: null });
    keeper.dispose();
  });

  it("clears a wholly unavailable session after the user opens and closes an untitled tab", async () => {
    const { store, keeper } = setup();
    for (const tab of store.get().tabs) store.closeTab(tab.id);
    keeper.start({ files: [unavailable], active: unavailable });
    await keeper.flush();
    expect(native.saveSession).toHaveBeenLastCalledWith({ files: [unavailable], active: unavailable });

    const untitled = store.addTab(blankDoc());
    store.closeTab(untitled);
    await keeper.flush();
    expect(native.saveSession).toHaveBeenLastCalledWith({ files: [], active: null });
    keeper.dispose();
  });

  it("recognizes Windows path variants when an unavailable file is opened and saved elsewhere", async () => {
    const { store, keeper } = setup();
    keeper.start({ files: ["Z:\\Notes.md", "z:/NOTES.md"], active: "Z:\\Notes.md" });
    const opened = store.addTab(file("z:/notes.md"));
    await keeper.flush();
    expect(native.saveSession).toHaveBeenLastCalledWith({ files: ["/docs/a.md", "/docs/b.md", "z:/notes.md"], active: "z:/notes.md" });

    store.patchDocById(opened, { filePath: "C:\\Saved.md" });
    await keeper.flush();
    expect(native.saveSession).toHaveBeenLastCalledWith({ files: ["/docs/a.md", "/docs/b.md", "C:\\Saved.md"], active: "C:\\Saved.md" });
    keeper.dispose();
  });
});
