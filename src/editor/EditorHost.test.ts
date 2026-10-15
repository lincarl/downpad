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
  /** What the document pane writes, its own form of the tab's text or typing. */
  markdown: "document pane's form",
  /** Whether the document pane holds typing it has not reported yet. */
  pending: false,
  reportCalls: 0,
  /** The text the split last mirrored into the document pane. */
  mirrored: null as string | null,
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

    /** Like the real editor, report held-back typing through `onChange`. */
    reportPendingChange(): void {
      fakeEditors.reportCalls += 1;
      if (!fakeEditors.pending) return;
      fakeEditors.pending = false;
      this.onChange?.(fakeEditors.markdown);
    }

    setMarkdown(markdown: string): void {
      fakeEditors.mirrored = markdown;
    }

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
    savedMarkdown: "original markdown",
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
  fakeEditors.markdown = "document pane's form";
  fakeEditors.pending = false;
  fakeEditors.reportCalls = 0;
  fakeEditors.mirrored = null;
  fakeEditors.wysiwygChange = null;
  fakeEditors.rawChange = null;
  fakeEditors.rawText = null;
});

describe("EditorHost terminal disposal", () => {
  it("silences and detaches an in-flight build, leaving its tab's markdown alone", async () => {
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
    // A dead WYSIWYG build must not write over the canonical document after
    // React has disposed its host.
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

describe("EditorHost build", () => {
  it("opens both split panes on the tab's exact text", async () => {
    const store = makeStore();
    const host = new EditorHost(document.createElement("div"), store);
    host.initLayout("split");
    await host.reloadActiveDoc();

    // The document pane writes the text its own way, but nothing was edited.
    expect(store.get().doc).toMatchObject({ markdown: "original markdown", isDirty: false });
    expect(fakeEditors.rawText).toBe("original markdown");
    await host.dispose();
  });
});

describe("EditorHost flush", () => {
  it("reports typing the visible document pane has not announced yet", async () => {
    const store = makeStore();
    const host = new EditorHost(document.createElement("div"), store);
    await host.reloadActiveDoc();
    fakeEditors.markdown = "original markdown, typed just now";
    fakeEditors.pending = true;

    host.flush();

    expect(store.get().doc).toMatchObject({ markdown: "original markdown, typed just now", isDirty: true });
    await host.dispose();
  });

  it("mirrors a document edit into the split's Markdown pane at once", async () => {
    const store = makeStore();
    const host = new EditorHost(document.createElement("div"), store);
    host.initLayout("split");
    await host.reloadActiveDoc();
    fakeEditors.markdown = "original markdown, typed just now";
    fakeEditors.pending = true;

    host.flush();

    expect(fakeEditors.rawText).toBe("original markdown, typed just now");
    await host.dispose();
  });

  it("mirrors a Markdown edit into the split's document pane at once, so its next edit counts", async () => {
    const store = makeStore();
    const host = new EditorHost(document.createElement("div"), store);
    host.initLayout("split");
    await host.reloadActiveDoc();
    fakeEditors.rawChange!("newer Markdown text");

    host.flush();

    // The document pane is behind, so it must not report; the mirror updates it.
    expect(fakeEditors.reportCalls).toBe(0);
    expect(fakeEditors.mirrored).toBe("newer Markdown text");
    fakeEditors.wysiwygChange!("newer Markdown text, then the document");
    expect(store.get().doc.markdown).toBe("newer Markdown text, then the document");
    await host.dispose();
  });

  it("never writes a pane's own form of the text back", async () => {
    const store = makeStore();
    const host = new EditorHost(document.createElement("div"), store);
    await host.reloadActiveDoc();

    // The document pane serializes differently, with no edit to report.
    host.flush();

    expect(store.get().doc).toMatchObject({ markdown: "original markdown", isDirty: false });
    await host.dispose();
  });

  it("leaves a hidden document pane alone", async () => {
    const store = makeStore();
    const host = new EditorHost(document.createElement("div"), store);
    await host.reloadActiveDoc();
    await host.setLayout("markdown");
    fakeEditors.markdown = "older document text";
    fakeEditors.pending = true;

    host.flush();

    expect(fakeEditors.pending).toBe(true);
    expect(store.get().doc.markdown).toBe("original markdown");
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

describe("EditorHost split catch-up", () => {
  /** Open the store's document in the split, keeping the root to find its panes. */
  async function openSplit(): Promise<{ root: HTMLElement; store: Store; host: EditorHost }> {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    host.initLayout("split");
    await host.reloadActiveDoc();
    return { root, store, host };
  }

  it("gives a clicked Markdown pane the document pane's held-back typing first", async () => {
    const { root, store, host } = await openSplit();
    fakeEditors.markdown = "settled markdown, typed in the document";
    fakeEditors.pending = true;

    root.querySelector(".editor-pane-raw")!.dispatchEvent(new Event("pointerdown"));

    expect(fakeEditors.rawText).toBe("settled markdown, typed in the document");
    fakeEditors.rawChange!("settled markdown, typed in the document, then Markdown");
    expect(store.get().doc.markdown).toBe("settled markdown, typed in the document, then Markdown");
    await host.dispose();
  });

  it("gives the document pane a Markdown edit when focus moves into it", async () => {
    const { root, store, host } = await openSplit();
    fakeEditors.rawChange!("newer Markdown text");

    root.querySelector(".editor-pane-wysiwyg")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(fakeEditors.mirrored).toBe("newer Markdown text");
    fakeEditors.wysiwygChange!("newer Markdown text, then the document");
    expect(store.get().doc.markdown).toBe("newer Markdown text, then the document");
    await host.dispose();
  });

  it("leaves a saved document saved when the panes take a click or focus", async () => {
    const { root, store, host } = await openSplit();
    // The document pane serializes differently now, with no edit to report.
    fakeEditors.markdown = "settled markdown, written another way";

    for (const pane of root.querySelectorAll(".editor-pane")) {
      pane.dispatchEvent(new Event("pointerdown"));
      pane.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    }

    expect(store.get().doc).toMatchObject({ markdown: "settled markdown", isDirty: false });
    expect(fakeEditors.rawText).toBe("settled markdown");
    await host.dispose();
  });
});
