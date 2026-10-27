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
