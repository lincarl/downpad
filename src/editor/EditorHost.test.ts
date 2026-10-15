// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings/defaults";
import { Store } from "../state/store";
import type { AppState } from "../state/types";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const fakeEditors = vi.hoisted(() => ({
  mountPromise: Promise.resolve() as Promise<void>,
  destroyPromise: Promise.resolve() as Promise<void>,
  mountCalls: 0,
  destroyCalls: 0,
  markdown: "settled markdown",
  reportCalls: 0,
  /** The document pane's change callback, to simulate its delayed report. */
  wysiwygChange: null as ((markdown: string) => void) | null,
  /** The Markdown pane's change callback, to simulate typing in it. */
  rawChange: null as ((text: string) => void) | null,
  /** The Markdown pane's current text. */
  rawText: null as string | null,
}));

vi.mock("./wysiwyg/WysiwygEditor", () => ({
  WysiwygEditor: class {
    private onChange: ((markdown: string) => void) | null = null;

    async mount(_root: HTMLElement, _markdown: string, cb: { onChange(markdown: string): void }): Promise<void> {
      fakeEditors.mountCalls += 1;
      this.onChange = cb.onChange;
      fakeEditors.wysiwygChange = cb.onChange;
      await fakeEditors.mountPromise;
    }

    getMarkdown(): string {
      return fakeEditors.markdown;
    }

    /** Like the real editor, report the current text through `onChange`. */
    reportPendingChange(): void {
      fakeEditors.reportCalls += 1;
      this.onChange?.(fakeEditors.markdown);
    }

    setMarkdown(): void {}

    async destroy(): Promise<void> {
      fakeEditors.destroyCalls += 1;
      await fakeEditors.destroyPromise;
    }

    onShow(): void {}
  },
}));

vi.mock("./raw/RawEditor", () => ({
  RawEditor: class {
    mount(_root: HTMLElement, text: string, cb: { onChange(text: string): void }): void {
      fakeEditors.rawText = text;
      fakeEditors.rawChange = cb.onChange;
    }

    getText(): string {
      return fakeEditors.rawText ?? "";
    }

    setText(text: string): void {
      fakeEditors.rawText = text;
    }

    destroy(): void {}
    onShow(): void {}
  },
}));

vi.mock("./wysiwyg/spellcheck", () => ({ applySpellcheck: vi.fn() }));

import { EditorHost } from "./EditorHost";

function makeStore(): Store {
  const doc = {
    markdown: "original markdown",
    filePath: null,
    isDirty: false,
    eol: "lf" as const,
    hadBom: false,
    modifiedMs: 0,
    frontmatterCollapsed: false,
  };
  const initial: AppState = {
    view: "wysiwyg",
    sessionId: "editor-host-test",
    doc,
    tabs: [{ id: "tab-1", doc }],
    activeTabId: "tab-1",
    editorLayout: "document",
    settings: DEFAULT_SETTINGS,
    find: {
      open: false,
      query: "",
      replace: "",
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      current: 0,
      total: 0,
    },
    banner: null,
    saveStatus: { lastSavedAt: null, autosaving: false },
  };
  return new Store(initial);
}

beforeEach(() => {
  fakeEditors.mountPromise = Promise.resolve();
  fakeEditors.destroyPromise = Promise.resolve();
  fakeEditors.mountCalls = 0;
  fakeEditors.destroyCalls = 0;
  fakeEditors.markdown = "settled markdown";
  fakeEditors.reportCalls = 0;
  fakeEditors.wysiwygChange = null;
  fakeEditors.rawChange = null;
  fakeEditors.rawText = null;
});

describe("EditorHost terminal disposal", () => {
  it("silences and detaches an in-flight build without reconciling its markdown", async () => {
    const mount = deferred();
    const destroy = deferred();
    fakeEditors.mountPromise = mount.promise;
    fakeEditors.destroyPromise = destroy.promise;

    const root = document.createElement("div");
    const reactOwnedSibling = document.createElement("div");
    reactOwnedSibling.dataset.owner = "react";
    root.appendChild(reactOwnedSibling);
    const store = makeStore();
    const host = new EditorHost(root, store);

    const presenting = host.reloadActiveDoc();
    expect(fakeEditors.mountCalls).toBe(1);
    expect(root.querySelector(".editor-pane-wysiwyg")).not.toBeNull();

    const firstDispose = host.dispose();
    const secondDispose = host.dispose();
    expect(secondDispose).toBe(firstDispose);
    expect(fakeEditors.destroyCalls).toBe(1);
    expect(root.querySelector(".editor-pane-wysiwyg")).toBeNull();
    // Terminal cleanup removes only editor-owned DOM, never a replacement or
    // sibling owned by React.
    expect(root.firstElementChild).toBe(reactOwnedSibling);

    let disposeSettled = false;
    void firstDispose.then(() => {
      disposeSettled = true;
    });
    await Promise.resolve();
    expect(disposeSettled).toBe(false);

    mount.resolve();
    await presenting;
    // A dead WYSIWYG build must not reconcile its settled serialization over
    // the canonical document after React has disposed its host.
    expect(store.get().doc.markdown).toBe("original markdown");
    expect(store.get().doc.isDirty).toBe(false);
    expect(disposeSettled).toBe(false);

    destroy.resolve();
    await firstDispose;
    expect(disposeSettled).toBe(true);
    expect(host.isMounted()).toBe(false);

    // Disposal is terminal; later runtime work is harmless and cannot recreate
    // an editor in the old root.
    await host.reloadActiveDoc();
    expect(fakeEditors.mountCalls).toBe(1);
    expect(root.firstElementChild).toBe(reactOwnedSibling);
  });

  it("does not resurrect a tab closed while its editor is being created", async () => {
    const mount = deferred();
    const destroy = deferred();
    fakeEditors.mountPromise = mount.promise;
    fakeEditors.destroyPromise = destroy.promise;

    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    const presenting = host.reloadActiveDoc();
    expect(fakeEditors.mountCalls).toBe(1);

    store.closeTab("tab-1");
    const discarding = host.discardTab("tab-1");
    expect(root.querySelector(".editor-pane-wysiwyg")).toBeNull();

    mount.resolve();
    await presenting;
    expect(store.get().activeTabId).toBeNull();
    expect(store.get().tabs).toHaveLength(0);
    expect(host.isMounted()).toBe(false);
    expect(root.querySelector(".editor-pane-wysiwyg")).toBeNull();

    destroy.resolve();
    await discarding;
    await host.dispose();
    expect(fakeEditors.destroyCalls).toBe(1);
  });

  it("removes a failed partial pane so presentation can retry cleanly", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    fakeEditors.mountPromise = Promise.reject(new Error("create failed"));

    await expect(host.reloadActiveDoc()).rejects.toThrow("create failed");
    expect(root.querySelector(".editor-pane-wysiwyg")).toBeNull();
    expect(fakeEditors.destroyCalls).toBe(1);

    fakeEditors.mountPromise = Promise.resolve();
    await host.reloadActiveDoc();
    expect(fakeEditors.mountCalls).toBe(2);
    expect(root.querySelector(".editor-pane-wysiwyg")).not.toBeNull();

    await host.dispose();
    expect(fakeEditors.destroyCalls).toBe(2);
  });

  it("waits for a pane already detached by an in-flight reload", async () => {
    const root = document.createElement("div");
    const host = new EditorHost(root, makeStore());
    await host.reloadActiveDoc();

    const destroy = deferred();
    fakeEditors.destroyPromise = destroy.promise;
    const reloading = host.reload();
    expect(fakeEditors.destroyCalls).toBe(1);
    expect(root.querySelector(".editor-pane-wysiwyg")).toBeNull();

    const disposing = host.dispose();
    let disposeSettled = false;
    void disposing.then(() => {
      disposeSettled = true;
    });
    await Promise.resolve();
    expect(disposeSettled).toBe(false);

    destroy.resolve();
    await reloading;
    await disposing;
    expect(disposeSettled).toBe(true);
    expect(fakeEditors.destroyCalls).toBe(1);
  });
});

describe("EditorHost split divider", () => {
  it("exposes and changes the split ratio from the keyboard", async () => {
    const root = document.createElement("div");
    const host = new EditorHost(root, makeStore());
    host.initLayout("split");
    await host.reloadActiveDoc();
    const divider = root.querySelector<HTMLElement>(".split-divider")!;

    expect(divider.tabIndex).toBe(0);
    expect(divider.getAttribute("aria-valuenow")).toBe("50");
    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(divider.getAttribute("aria-valuenow")).toBe("52");
    expect(root.style.getPropertyValue("--split-left")).toBe("52.000%");

    await host.dispose();
  });
});

describe("EditorHost pending document edits", () => {
  it("reports typing the visible document pane has not announced yet", async () => {
    const store = makeStore();
    const host = new EditorHost(document.createElement("div"), store);
    await host.reloadActiveDoc();
    fakeEditors.markdown = "settled markdown, typed just now";

    host.commitPendingEdits();

    expect(store.get().doc).toMatchObject({ markdown: "settled markdown, typed just now", isDirty: true });
    await host.dispose();
  });

  it("keeps the split's Markdown pane in step with the reported edit", async () => {
    const store = makeStore();
    const host = new EditorHost(document.createElement("div"), store);
    host.initLayout("split");
    await host.reloadActiveDoc();
    vi.useFakeTimers();
    try {
      fakeEditors.markdown = "settled markdown, typed just now";
      host.commitPendingEdits();
      vi.advanceTimersByTime(500);
      expect(fakeEditors.rawText).toBe("settled markdown, typed just now");
    } finally {
      vi.useRealTimers();
    }
    await host.dispose();
  });

  it("leaves a hidden or stale document pane alone so newer Markdown edits survive", async () => {
    const store = makeStore();
    const host = new EditorHost(document.createElement("div"), store);
    await host.reloadActiveDoc();
    await host.setLayout("markdown");
    fakeEditors.markdown = "older document text";
    host.commitPendingEdits();
    expect(fakeEditors.reportCalls).toBe(0);

    // In the split, a Markdown edit makes the document pane stale until the
    // mirror sync catches it up.
    await host.setLayout("split");
    fakeEditors.rawChange!("newer Markdown text");
    host.commitPendingEdits();
    expect(fakeEditors.reportCalls).toBe(0);
    expect(store.get().doc.markdown).toBe("newer Markdown text");
    await host.dispose();
  });

  it("drops a delayed document report made stale by a newer Markdown edit", async () => {
    const store = makeStore();
    const host = new EditorHost(document.createElement("div"), store);
    host.initLayout("split");
    await host.reloadActiveDoc();
    fakeEditors.rawChange!("newer Markdown text");

    // The document pane's report for typing from before that edit lands late.
    fakeEditors.wysiwygChange!("older document text");

    expect(store.get().doc.markdown).toBe("newer Markdown text");
    await host.dispose();
  });
});
