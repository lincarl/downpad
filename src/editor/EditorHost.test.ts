// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  /** The text and serializer bullet each document pane was built with, in order. */
  mounted: [] as Array<{ markdown: string; bullet: string }>,
  /** Runs as each document pane starts to build, to simulate an edit then. */
  duringMount: null as (() => void) | null,
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
  /** Whether each reveal of a Markdown pane asked it to take focus. */
  rawShowFocus: [] as boolean[],
  /** Each pane's find change callback, to simulate an edit with the card open. */
  wysiwygFindChange: null as (() => void) | null,
  rawFindChange: null as (() => void) | null,
}));

/** The counts each fake pane reports, so a test can tell which pane answered. */
const DOCUMENT_COUNTS = { current: 1, total: 3 };
const MARKDOWN_COUNTS = { current: 0, total: 4 };

vi.mock("./wysiwyg/WysiwygEditor", () => ({
  WysiwygEditor: class {
    private onChange: ((markdown: string) => void) | null = null;

    async mount(
      _root: HTMLElement,
      markdown: string,
      cb: { onChange(markdown: string): void; onFindChange?(): void },
      style: { bullet: string },
    ): Promise<void> {
      fakeEditors.mountCalls += 1;
      fakeEditors.mounted.push({ markdown, bullet: style.bullet });
      fakeEditors.duringMount?.();
      this.onChange = cb.onChange;
      fakeEditors.wysiwygChange = cb.onChange;
      fakeEditors.wysiwygFindChange = cb.onFindChange ?? null;
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

    /** Like the real editor, hold the insert back until typing pauses. */
    insertMarkdown(markdown: string): void {
      fakeEditors.markdown = `${fakeEditors.markdown}\n\n${markdown}`;
      fakeEditors.pending = true;
    }

    /** The pane now shows the mirrored text, dropping anything it held. */
    setMarkdown(markdown: string): void {
      fakeEditors.mirrored = markdown;
      fakeEditors.markdown = markdown;
    }

    currentCounts() {
      return DOCUMENT_COUNTS;
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
    mount(_root: HTMLElement, text: string, cb: { onChange(text: string): void; onFindChange?(): void }): void {
      fakeEditors.rawText = text;
      fakeEditors.rawChange = cb.onChange;
      fakeEditors.rawFindChange = cb.onFindChange ?? null;
    }

    getText(): string {
      return fakeEditors.rawText ?? "";
    }

    setText(text: string): void {
      fakeEditors.rawText = text;
    }

    currentCounts() {
      return MARKDOWN_COUNTS;
    }

    /** Like the real editor, add the text at the caret, here the end, and
     *  report the edit at once. */
    insertText(text: string): void {
      fakeEditors.rawText = `${fakeEditors.rawText ?? ""}${text}`;
      fakeEditors.rawChange?.(fakeEditors.rawText);
    }

    destroy(): void {}
    onShow(focus = true): void {
      fakeEditors.rawShowFocus.push(focus);
    }
  },
}));

vi.mock("./wysiwyg/spellcheck", () => ({ applySpellcheck: vi.fn() }));

import { EditorHost } from "./EditorHost";

/** The classes of the visible panes. */
const shown = (root: HTMLElement): string[] =>
  [...root.querySelectorAll<HTMLElement>(".editor-pane:not([hidden])")].map((pane) => pane.className);
const failureOf = (store: Store, tabId: string) =>
  store.get().tabs.find((tab) => tab.id === tabId)?.documentViewFailure;

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
  fakeEditors.mounted = [];
  fakeEditors.duringMount = null;
  fakeEditors.markdown = "document pane's form";
  fakeEditors.pending = false;
  fakeEditors.reportCalls = 0;
  fakeEditors.mirrored = null;
  fakeEditors.wysiwygChange = null;
  fakeEditors.rawChange = null;
  fakeEditors.rawText = null;
  fakeEditors.rawShowFocus = [];
  fakeEditors.wysiwygFindChange = null;
  fakeEditors.rawFindChange = null;
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

describe("EditorHost document view failure", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the tab's Markdown alone and records why, then Try again builds the document pane", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    host.initLayout("split");
    fakeEditors.mountPromise = Promise.reject(new Error("create failed"));

    await host.reloadActiveDoc();
    expect(shown(root)).toEqual(["editor-pane editor-pane-raw"]);
    expect(root.querySelector(".editor-pane-wysiwyg")).toBeNull();
    expect(root.classList.contains("split")).toBe(false);
    expect(failureOf(store, "tab-1")).toEqual({ message: "create failed", dismissed: false });
    expect(fakeEditors.destroyCalls).toBe(1);
    // Find searches the Markdown pane it shows.
    expect(host.counts()).toEqual(MARKDOWN_COUNTS);
    // Typing there edits this tab.
    fakeEditors.rawChange!("fixed text");
    expect(store.get().doc).toMatchObject({ markdown: "fixed text", isDirty: true });

    fakeEditors.mountPromise = Promise.resolve();
    await host.retryDocumentView();
    expect(fakeEditors.mountCalls).toBe(2);
    expect(shown(root)).toEqual(["editor-pane editor-pane-raw", "editor-pane editor-pane-wysiwyg"]);
    expect(root.classList.contains("split")).toBe(true);
    expect(failureOf(store, "tab-1")).toBeUndefined();
    expect(host.counts()).toEqual(DOCUMENT_COUNTS);

    await host.dispose();
    expect(fakeEditors.destroyCalls).toBe(2);
  });

  it("keeps the Markdown view and shows the new error when Try again fails", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    fakeEditors.mountPromise = Promise.reject(new Error("create failed"));
    await host.reloadActiveDoc();
    store.setDocumentViewFailure("tab-1", { message: "create failed", dismissed: true });

    expect(fakeEditors.rawShowFocus).toEqual([true]);

    fakeEditors.mountPromise = Promise.reject(new Error("failed again"));
    await host.retryDocumentView();
    expect(fakeEditors.mountCalls).toBe(2);
    expect(shown(root)).toEqual(["editor-pane editor-pane-raw"]);
    expect(failureOf(store, "tab-1")).toEqual({ message: "failed again", dismissed: false });
    // Focus stays on Try again, so pressing Enter again tries again instead of
    // typing a line break into the Markdown view.
    expect(fakeEditors.rawShowFocus).toEqual([true, false]);
    await host.dispose();
  });

  it("tries the document pane again in the Markdown layout, keeping it hidden", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    fakeEditors.mountPromise = Promise.reject(new Error("create failed"));
    await host.reloadActiveDoc();
    // Another tab chooses the Markdown layout for the window.
    fakeEditors.mountPromise = Promise.resolve();
    store.addTab({ ...store.get().doc, markdown: "other" });
    await host.reloadActiveDoc();
    await host.setLayout("markdown");
    store.activateTab("tab-1");
    await host.showActiveDoc();

    await host.retryDocumentView();
    expect(fakeEditors.mountCalls).toBe(3);
    expect(shown(root)).toEqual(["editor-pane editor-pane-raw"]);
    // Built and hidden, next to the other tab's.
    expect(root.querySelectorAll(".editor-pane-wysiwyg[hidden]")).toHaveLength(2);
    expect(failureOf(store, "tab-1")).toBeUndefined();
    await host.dispose();
  });

  it("shows no other tab's pane under a failing tab, and other tabs keep the window's layout", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    await host.reloadActiveDoc();
    const first = root.querySelector<HTMLElement>(".editor-pane-wysiwyg")!;

    const second = store.addTab({ ...store.get().doc, markdown: "> deep" });
    fakeEditors.mountPromise = Promise.reject(new Error("create failed"));
    await host.reloadActiveDoc();
    expect(first.hidden).toBe(true);
    expect(shown(root)).toEqual(["editor-pane editor-pane-raw"]);
    expect(fakeEditors.rawText).toBe("> deep");
    fakeEditors.rawChange!("> deeper");
    expect(store.get().tabs.map((tab) => tab.doc.markdown)).toEqual(["original markdown", "> deeper"]);

    store.activateTab("tab-1");
    await host.showActiveDoc();
    expect(shown(root)).toEqual(["editor-pane editor-pane-wysiwyg"]);
    expect(first.hidden).toBe(false);

    // Returning to the failing tab shows its Markdown again without trying again.
    store.activateTab(second);
    await host.showActiveDoc();
    expect(fakeEditors.mountCalls).toBe(2);
    expect(shown(root)).toEqual(["editor-pane editor-pane-raw"]);
    await host.dispose();
  });

  it("tries the document pane again when the document layout is chosen again", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    fakeEditors.mountPromise = Promise.reject(new Error("create failed"));
    await host.reloadActiveDoc();

    // The window has the document layout already.
    fakeEditors.mountPromise = Promise.resolve();
    await host.setLayout("document");
    expect(fakeEditors.mountCalls).toBe(2);
    expect(shown(root)).toEqual(["editor-pane editor-pane-wysiwyg"]);
    expect(failureOf(store, "tab-1")).toBeUndefined();
    await host.dispose();
  });
});

describe("EditorHost find count", () => {
  it("passes on edits only from the pane the find card searches", async () => {
    const host = new EditorHost(document.createElement("div"), makeStore());
    const recount = vi.fn();
    host.setFindChangeHandler(recount);
    host.initLayout("split");
    await host.reloadActiveDoc();

    // The split searches the document pane. A Markdown edit reaches it by mirror sync.
    fakeEditors.rawFindChange!();
    expect(recount).not.toHaveBeenCalled();
    fakeEditors.wysiwygFindChange!();
    expect(recount).toHaveBeenCalledOnce();
    expect(host.counts()).toEqual(DOCUMENT_COUNTS);

    // The Markdown view searches the Markdown pane; the hidden document pane is ignored.
    await host.setLayout("markdown");
    fakeEditors.wysiwygFindChange!();
    expect(recount).toHaveBeenCalledOnce();
    fakeEditors.rawFindChange!();
    expect(recount).toHaveBeenCalledTimes(2);
    expect(host.counts()).toEqual(MARKDOWN_COUNTS);

    await host.dispose();
    fakeEditors.rawFindChange!();
    expect(recount).toHaveBeenCalledTimes(2);
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

describe("EditorHost changes while a document pane builds", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Start `show`, which builds a document pane, make `change` while that build
   *  waits, then let it finish. Any later build ends as `later` does. */
  async function changeWhileBuilding(
    show: () => Promise<void>,
    change: () => void,
    later: Promise<void> = Promise.resolve(),
  ): Promise<void> {
    const mount = deferred();
    fakeEditors.mountPromise = mount.promise;
    const showing = show();
    expect(fakeEditors.mounted).not.toHaveLength(0);
    fakeEditors.mountPromise = later;
    change();
    mount.resolve();
    await showing;
  }

  it("shows Try again's document pane with the Markdown typed while it builds, and keeps its edits", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    fakeEditors.mountPromise = Promise.reject(new Error("create failed"));
    await host.reloadActiveDoc();
    fakeEditors.rawChange!("fixed text");

    await changeWhileBuilding(
      () => host.retryDocumentView(),
      () => fakeEditors.rawChange!("fixed text, typed while it opens"),
    );

    expect(shown(root)).toEqual(["editor-pane editor-pane-wysiwyg"]);
    expect(failureOf(store, "tab-1")).toBeUndefined();
    // An edit in it reaches the tab, and it was built from the latest text.
    fakeEditors.wysiwygChange!("fixed text, typed while it opens, then the document");
    expect(store.get().doc.markdown).toBe("fixed text, typed while it opens, then the document");
    expect(fakeEditors.mounted.at(-1)?.markdown).toBe("fixed text, typed while it opens");
    await host.dispose();
  });

  it("keeps the Markdown view and the notice when the text typed while Try again builds cannot be shown", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    fakeEditors.mountPromise = Promise.reject(new Error("create failed"));
    await host.reloadActiveDoc();
    fakeEditors.rawChange!("fixed text");

    await changeWhileBuilding(
      () => host.retryDocumentView(),
      () => fakeEditors.rawChange!("> deep again"),
      Promise.reject(new Error("failed again")),
    );

    expect(shown(root)).toEqual(["editor-pane editor-pane-raw"]);
    expect(root.querySelector(".editor-pane-wysiwyg")).toBeNull();
    expect(failureOf(store, "tab-1")).toEqual({ message: "failed again", dismissed: false });
    expect(fakeEditors.mounted.at(-1)?.markdown).toBe("> deep again");
    await host.dispose();
  });

  it.each(["document", "split"] as const)(
    "shows the %s layout's new document pane with the Markdown typed while it builds, and keeps its edits",
    async (layout) => {
      const root = document.createElement("div");
      const store = makeStore();
      const host = new EditorHost(root, store);
      host.initLayout("markdown");
      await host.reloadActiveDoc();

      await changeWhileBuilding(
        () => host.setLayout(layout),
        () => fakeEditors.rawChange!("typed while it opens"),
      );

      expect(root.querySelector(".editor-pane-wysiwyg:not([hidden])")).not.toBeNull();
      fakeEditors.wysiwygChange!("typed while it opens, then the document");
      expect(store.get().doc.markdown).toBe("typed while it opens, then the document");
      expect(fakeEditors.mounted.at(-1)?.markdown).toBe("typed while it opens");
      await host.dispose();
    },
  );

  /** Replace the active tab's text the way a reload from disk does, then show it. */
  function reloadFromDisk(store: Store, host: EditorHost, markdown: string): Promise<void> {
    store.replaceActiveDoc({ ...store.get().doc, markdown, savedMarkdown: markdown, isDirty: false });
    return host.reloadActiveDoc();
  }

  it.each([
    ["the split", false],
    ["a failing tab", true],
  ])("keeps the reloaded text when typing lands in the old Markdown pane of %s while the document pane builds", async (_name, failing) => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    host.initLayout("split");
    if (failing) fakeEditors.mountPromise = Promise.reject(new Error("create failed"));
    await host.reloadActiveDoc();
    // The Markdown pane on screen keeps the text from before the reload until
    // the document pane is built.
    const typeInOldPane = fakeEditors.rawChange!;

    await changeWhileBuilding(
      () => reloadFromDisk(store, host, "text from disk"),
      () => typeInOldPane("original markdown, typed during the reload"),
    );

    expect(store.get().doc).toMatchObject({ markdown: "text from disk", isDirty: false });
    // One build for the reload, from the text on disk.
    expect(fakeEditors.mounted.map((build) => build.markdown)).toEqual(["original markdown", "text from disk"]);
    expect(fakeEditors.rawText).toBe("text from disk");
    expect(shown(root)).toEqual(["editor-pane editor-pane-wysiwyg", "editor-pane editor-pane-raw"]);
    expect(failureOf(store, "tab-1")).toBeUndefined();
    // The Markdown pane built for the reload takes edits.
    fakeEditors.rawChange!("text from disk, typed after");
    expect(store.get().doc.markdown).toBe("text from disk, typed after");
    await host.dispose();
  });

  it("builds the document pane again with settings changed while it builds", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    host.initLayout("markdown");
    await host.reloadActiveDoc();

    await changeWhileBuilding(
      () => host.setLayout("document"),
      () => {
        store.set({ settings: { ...store.get().settings, mdBulletChar: "*" } });
        void host.reload();
      },
    );

    expect(fakeEditors.mounted.map((build) => build.bullet)).toEqual(["-", "*"]);
    expect(shown(root)).toEqual(["editor-pane editor-pane-wysiwyg"]);
    expect(root.querySelectorAll(".editor-pane-wysiwyg")).toHaveLength(1);
    await host.dispose();
  });

  it("stops building and shows the Markdown with the notice while the typing never pauses", async () => {
    const root = document.createElement("div");
    const store = makeStore();
    const host = new EditorHost(root, store);
    host.initLayout("markdown");
    await host.reloadActiveDoc();
    let keystrokes = 0;
    fakeEditors.duringMount = () => fakeEditors.rawChange!(`typed ${++keystrokes}`);

    await host.setLayout("document");

    expect(fakeEditors.mountCalls).toBe(5);
    // Every pane built is destroyed again.
    expect(fakeEditors.destroyCalls).toBe(5);
    expect(root.querySelector(".editor-pane-wysiwyg")).toBeNull();
    expect(shown(root)).toEqual(["editor-pane editor-pane-raw"]);
    expect(failureOf(store, "tab-1")).toEqual({
      message: "the text kept changing while the view opened",
      dismissed: false,
    });
    expect(store.get().doc.markdown).toBe("typed 5");
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

  it("catches up before a control in the pane stops the click", async () => {
    const { root, host } = await openSplit();
    fakeEditors.rawChange!("newer Markdown text");
    // Like a task checkbox or table button that acts on pointerdown.
    const control = document.createElement("button");
    control.addEventListener("pointerdown", (event) => event.stopPropagation());
    root.querySelector(".editor-pane-wysiwyg")!.appendChild(control);

    control.dispatchEvent(new Event("pointerdown", { bubbles: true }));

    expect(fakeEditors.mirrored).toBe("newer Markdown text");
    await host.dispose();
  });

  it("puts a file dropped while the Markdown pane has focus at its caret, as written", async () => {
    const { root, store, host } = await openSplit();
    document.body.append(root);
    const caret = document.createElement("textarea");
    root.querySelector(".editor-pane-raw")!.append(caret);
    caret.focus();
    fakeEditors.rawText = "Markdown text, typed";
    fakeEditors.rawChange!(fakeEditors.rawText);

    host.insertMarkdown("[notes.csv](attachments/notes.csv)");

    // The document pane would report its own form of the whole text.
    expect(store.get().doc.markdown).toBe("Markdown text, typed[notes.csv](attachments/notes.csv)");
    host.flush();
    expect(fakeEditors.mirrored).toBe("Markdown text, typed[notes.csv](attachments/notes.csv)");
    root.remove();
    await host.dispose();
  });

  it("drops a file into a document pane that holds the latest Markdown edit", async () => {
    const { store, host } = await openSplit();
    fakeEditors.rawChange!("newer Markdown text");

    host.insertMarkdown("![](image.png)");
    host.flush();

    expect(store.get().doc.markdown).toBe("newer Markdown text\n\n![](image.png)");
    expect(fakeEditors.rawText).toBe("newer Markdown text\n\n![](image.png)");
    await host.dispose();
  });

  it("leaves a saved document saved when the panes take a click or focus", async () => {
    const { root, store, host } = await openSplit();
    const before = { markdown: store.get().doc.markdown, raw: fakeEditors.rawText };
    // The document pane serializes differently now, with no edit to report.
    fakeEditors.markdown = `${before.markdown}, written another way`;

    for (const pane of root.querySelectorAll(".editor-pane")) {
      pane.dispatchEvent(new Event("pointerdown"));
      pane.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    }

    expect(store.get().doc).toMatchObject({ markdown: before.markdown, isDirty: false });
    expect(fakeEditors.rawText).toBe(before.raw);
    await host.dispose();
  });
});
