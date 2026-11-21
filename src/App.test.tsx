// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/settings/defaults";
import { closeContextMenu } from "@/shell/contextMenu";
import { Store } from "@/state/store";
import type { AppState } from "@/state/types";

const runtime = vi.hoisted(() => ({
  newDocument: vi.fn(),
  openDocument: vi.fn(),
  saveDocument: vi.fn(),
  saveDocumentAs: vi.fn(),
  toggleFind: vi.fn(),
  selectLayout: vi.fn(),
  printDocument: vi.fn(),
  copyDocumentMarkdown: vi.fn(),
  copyDocumentFormatted: vi.fn(),
  openSettings: vi.fn(),
  toggleDocumentTheme: vi.fn(),
  zoomDocument: vi.fn(),
  showRecentView: vi.fn(),
  activateDocumentTab: vi.fn(),
  closeDocumentTab: vi.fn(),
  closeEveryTab: vi.fn(),
  canCopyTabFile: vi.fn(),
  copyTabFile: vi.fn(),
  handleBannerAction: vi.fn(),
  dismissBanner: vi.fn(),
  revealPath: vi.fn(),
  copyText: vi.fn(),
}));

vi.mock("@/app/useAppRuntime", () => ({
  useOwnedAppRuntime: () => runtime,
}));

import { App } from "./App";

function makeStore(): Store {
  const doc = {
    markdown: "# Test",
    filePath: null,
    isDirty: false,
    savedMarkdown: "# Test",
    eol: "lf" as const,
    hadBom: false,
    modifiedMs: 0,
    frontmatterCollapsed: false,
  };
  const state: AppState = {
    view: "wysiwyg",
    sessionId: "app-test",
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
    git: null,
    started: false,
  };
  return new Store(state);
}

beforeEach(() => {
  for (const value of Object.values(runtime)) value.mockReset();
});

afterEach(() => {
  closeContextMenu();
  cleanup();
});

describe("App shell", () => {
  it("marks the document icon red for unsaved tabs and restores it after saving", () => {
    const store = makeStore();
    store.patchDoc({ filePath: "C:\\notes\\draft.md" });
    render(<App store={store} />);
    expect(document.title).toBe("draft.md — Downpad");
    act(() => store.patchDoc({ markdown: "changed", isDirty: true }));
    expect(document.querySelectorAll(".tab-file-icon.is-dirty")).toHaveLength(1);
    expect(document.querySelector(".tab-file-icon")?.classList.contains("text-ink-danger")).toBe(true);
    expect(document.querySelector("[role='tab']")?.getAttribute("aria-description")).toBe("Unsaved changes");
    expect(document.title).toBe("draft.md — Downpad");
    act(() => store.patchDoc({ isDirty: false }));
    expect(document.querySelector(".tab-file-icon.is-dirty")).toBeNull();
    expect(document.querySelector("[role='tab']")?.hasAttribute("aria-description")).toBe(false);
    // A file dropped on the document that is not in yet also counts as unsaved.
    act(() => store.setFilesPending("tab-1", true));
    expect(document.querySelectorAll(".tab-file-icon.is-dirty")).toHaveLength(1);
    expect(document.querySelector("[role='tab']")?.getAttribute("aria-description")).toBe("Unsaved changes");
    act(() => store.setFilesPending("tab-1", false));
    expect(document.querySelector(".tab-file-icon.is-dirty")).toBeNull();
    act(() => store.patchDoc({ filePath: null }));
    expect(document.title).toBe("Untitled — Downpad");
    act(() => store.closeTab("tab-1"));
    expect(document.title).toBe("Downpad");
  });

  it("mounts under Strict Mode with accessible layout and tab controls", async () => {
    render(<StrictMode><App store={makeStore()} /></StrictMode>);
    const user = userEvent.setup();

    expect(screen.getByRole("radiogroup", { name: "Editor view" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Document" }).getAttribute("aria-checked")).toBe("true");
    const tab = screen.getByRole("tab", { name: "Untitled" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(tab.parentElement?.getAttribute("role")).toBe("tablist");
    expect(tab.getAttribute("aria-keyshortcuts")).toBe("Delete");
    expect(screen.queryByRole("button", { name: "Close Untitled" })).toBeNull();

    tab.focus();
    await user.keyboard("{Enter}");
    expect(runtime.activateDocumentTab).toHaveBeenCalledWith("tab-1");

    await user.keyboard("{Delete}");
    expect(runtime.closeDocumentTab).toHaveBeenCalledWith("tab-1");
  });

  it("announces application banners", () => {
    const store = makeStore();
    const view = render(<App store={store} />);
    store.set({ banner: { kind: "error", message: "Save failed" } });
    view.rerender(<App store={store} />);

    expect(screen.getByRole("alert").textContent).toContain("Save failed");
  });

  it("shows a tab whose Document view failed in the Text view, with its notice, only while that tab is active", async () => {
    const store = makeStore();
    store.patchDoc({ filePath: "/notes/deep.md" });
    store.set({ editorLayout: "split" });
    const other = store.addTab({ ...store.get().doc, filePath: "/notes/other.md" });
    store.activateTab("tab-1");
    store.setDocumentViewFailure("tab-1", { message: "Maximum call stack size exceeded", dismissed: false });
    render(<App store={store} />);
    const user = userEvent.setup();
    const area = document.getElementById("document-editor-panel")!;
    const notice = () => screen.queryByRole("alert")?.querySelector(".banner-message")?.textContent;

    expect(notice()).toBe(
      "Downpad can't show deep.md in the Document view (Maximum call stack size exceeded), so it is open in the Text view.",
    );
    expect(screen.getByRole("radio", { name: "Text" }).getAttribute("aria-checked")).toBe("true");
    // Every view stays on offer, so the user can try the Document view again.
    for (const view of screen.getAllByRole("radio")) expect(view.hasAttribute("disabled")).toBe(false);
    expect(area.classList.contains("markdown-only")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(runtime.handleBannerAction).toHaveBeenCalledWith("retry-document-view");
    await user.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(runtime.dismissBanner).toHaveBeenCalledOnce();

    // Another banner takes the bar while it is up.
    act(() => store.set({ banner: { kind: "file-changed", message: "This file changed on disk." } }));
    expect(notice()).toBeUndefined();
    act(() => store.set({ banner: null }));
    expect(notice()).toContain("can't show deep.md");

    // A long error and a long file name are cut, the notice is clamped to two
    // lines, and its tooltip has the uncut text.
    const name = `${"n".repeat(60)}-v2.md`;
    act(() => {
      store.patchDoc({ filePath: `/notes/${name}` });
      store.setDocumentViewFailure("tab-1", { message: `${"x".repeat(300)}\nat parse`, dismissed: false });
    });
    expect(notice()).toBe(
      `Downpad can't show ${"n".repeat(20)}…${"n".repeat(13)}-v2.md in the Document view (${"x".repeat(59)}…), so it is open in the Text view.`,
    );
    const message = screen.getByRole("alert").querySelector(".banner-message")!;
    expect(message.classList.contains("line-clamp-2")).toBe(true);
    expect(message.getAttribute("title")).toBe(
      `Downpad can't show ${name} in the Document view (${"x".repeat(300)}), so it is open in the Text view.`,
    );

    // Other tabs show the window's layout and no notice.
    act(() => store.activateTab(other));
    expect(notice()).toBeUndefined();
    expect(screen.getByRole("radio", { name: "Split" }).getAttribute("aria-checked")).toBe("true");
    expect(area.classList.contains("split")).toBe(true);
  });

  it("puts Settings last in the toolbar and exposes a document-theme toggle", async () => {
    const store = makeStore();
    render(<App store={store} />);
    const user = userEvent.setup();

    expect(screen.queryByRole("button", { name: "Application menu" })).toBeNull();
    const settings = screen.getByRole("button", { name: "Settings" });
    expect(document.querySelector(".toolbar")?.lastElementChild).toBe(settings);
    await user.click(screen.getByRole("button", { name: "Switch to dark document theme" }));
    expect(runtime.toggleDocumentTheme).toHaveBeenCalledOnce();

    await user.click(settings);
    await waitFor(() => expect(runtime.openSettings).toHaveBeenCalledOnce());
  });

  it("closes a toolbar menu on Tab and moves on from its button", async () => {
    render(<App store={makeStore()} />);
    const user = userEvent.setup();
    const menuButton = screen.getByRole("button", { name: "Copy" });

    await user.click(menuButton);
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    await user.tab();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Print" })));

    await user.click(screen.getByRole("button", { name: "Save options" }));
    await user.tab({ shift: true });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Save"));
  });

  it("opens the copy choices left of Print and runs either format", async () => {
    render(<App store={makeStore()} />);
    const user = userEvent.setup();
    const copy = screen.getByRole("button", { name: "Copy" });
    expect(copy.nextElementSibling).toBe(screen.getByRole("button", { name: "Print" }));

    await user.click(copy);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Copy as markdown", "Copy formatted text",
    ]);
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(runtime.copyDocumentFormatted).toHaveBeenCalledOnce());
    expect(document.activeElement).toBe(copy);
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(copy);
    await user.click(screen.getByRole("menuitem", { name: "Copy as markdown" }));
    await waitFor(() => expect(runtime.copyDocumentMarkdown).toHaveBeenCalledOnce());
  });

  it("offers a JSON file the Text view alone, selected as for a Markdown file, a copy of its source and no formatted copy", async () => {
    const store = makeStore();
    store.patchDoc({ filePath: "/data/settings.json" });
    store.set({ editorLayout: "split" });
    render(<App store={store} />);
    const user = userEvent.setup();

    const group = screen.getByRole("radiogroup", { name: "Editor view" });
    const views = within(group).getAllByRole("radio");
    expect(views.map((view) => view.textContent)).toEqual(["Document", "Split", "Text"]);
    expect(views.map((view) => view.hasAttribute("disabled"))).toEqual([true, true, false]);
    expect(views.map((view) => view.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(views[2].classList.contains("active")).toBe(true);
    expect(group.hasAttribute("data-disabled")).toBe(false);
    // Pressing the selected view keeps it, and changes no layout.
    await user.click(views[2]);
    expect(views[2].getAttribute("aria-checked")).toBe("true");
    expect(runtime.selectLayout).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Copy as JSON", "Copy formatted text"]);
    expect(screen.getByRole("menuitem", { name: "Copy formatted text" }).hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("menuitem", { name: "Copy as JSON" }));
    await waitFor(() => expect(runtime.copyDocumentMarkdown).toHaveBeenCalledOnce());
    expect(runtime.copyDocumentFormatted).not.toHaveBeenCalled();
  });

  it("offers the Text view alone in the compact view menu of a narrow window for a JSON file", async () => {
    const store = makeStore();
    store.patchDoc({ filePath: "/data/settings.json" });
    render(<App store={store} />);
    const user = userEvent.setup();

    const menuButton = screen.getByRole("button", { name: "Editor view" });
    expect(menuButton.hasAttribute("disabled")).toBe(false);
    await user.click(menuButton);
    const menu = screen.getByRole("menu", { name: "Editor view" });
    const rows = within(menu).getAllByRole("menuitemradio");
    expect(rows.map((row) => row.textContent)).toEqual(["Document", "Split", "Text"]);
    expect(rows.map((row) => row.hasAttribute("disabled"))).toEqual([true, true, false]);
    expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(document.activeElement).toBe(rows[2]);
    await user.click(rows[0]);
    expect(screen.getByRole("menu", { name: "Editor view" })).toBeTruthy();
    expect(runtime.selectLayout).not.toHaveBeenCalled();
  });

  it("offers a YAML file the Text view alone, with no word count", () => {
    const store = makeStore();
    store.patchDoc({ filePath: "/data/compose.yml" });
    render(<App store={store} />);
    const views = within(screen.getByRole("radiogroup", { name: "Editor view" })).getAllByRole("radio");
    expect(views.map((view) => view.hasAttribute("disabled"))).toEqual([true, true, false]);
    expect(screen.getByRole("radio", { name: "Text" }).getAttribute("aria-checked")).toBe("true");
    // Data has no words to count, so the status bar shows its size alone.
    expect(document.querySelector(".status-right")?.textContent).not.toContain("word");
  });

  it("keeps every view on offer for a Markdown file, also one without an extension", () => {
    const store = makeStore();
    store.patchDoc({ filePath: "/notes/README" });
    render(<App store={store} />);
    const views = within(screen.getByRole("radiogroup", { name: "Editor view" })).getAllByRole("radio");
    expect(views.map((view) => view.textContent)).toEqual(["Document", "Split", "Text"]);
    for (const view of views) expect(view.hasAttribute("disabled")).toBe(false);
    expect(views[0].getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector(".status-right")?.textContent).toMatch(/^\d+ words? · /);
  });

  it("keeps Settings available on Recent while disabling document copy and every view", async () => {
    const store = makeStore();
    store.patchDoc({ filePath: "/data/settings.json" });
    store.set({ view: "recent" });
    render(<App store={store} />);
    const user = userEvent.setup();
    expect(screen.getByRole("button", { name: "Copy" }).hasAttribute("disabled")).toBe(true);
    for (const view of screen.getAllByRole("radio")) {
      expect(view.hasAttribute("disabled")).toBe(true);
      expect(view.getAttribute("aria-checked")).toBe("false");
    }
    expect(screen.getByRole("button", { name: "Editor view" }).hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(runtime.openSettings).toHaveBeenCalledOnce();
  });

  it.each([
    { editorTheme: "light", action: "Switch to dark document theme", other: "Switch to light document theme" },
    { editorTheme: "dark", action: "Switch to light document theme", other: "Switch to dark document theme" },
  ] as const)("labels the document-theme toggle '$action' on a $editorTheme document surface", ({ editorTheme, action, other }) => {
    const store = makeStore();
    store.set({ settings: { ...store.get().settings, editorTheme } });
    render(<App store={store} />);

    expect(screen.getByRole("button", { name: action })).toBeTruthy();
    expect(screen.queryByRole("button", { name: other })).toBeNull();
  });
});

describe("Document tab menu", () => {
  it("lists its items and gives the runtime the file's exact path or folder, or its tab for Copy file", async () => {
    const store = makeStore();
    store.patchDoc({ filePath: "C:\\notes\\draft.md" });
    runtime.canCopyTabFile.mockReturnValue(true);
    render(<App store={store} />);
    const user = userEvent.setup();
    const tab = screen.getByRole("tab", { name: "draft.md" });
    const choose = async (label: string) => {
      fireEvent.contextMenu(tab);
      await user.click(screen.getByRole("menuitem", { name: label }));
    };

    fireEvent.contextMenu(tab);
    expect(screen.getByRole("menu", { name: "Tab" })).toBeTruthy();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Open folder", "Copy file", "Copy file path", "Copy folder path", "Close all tabs",
    ]);
    closeContextMenu();

    await choose("Open folder");
    expect(runtime.revealPath).toHaveBeenCalledExactlyOnceWith("C:\\notes\\draft.md");
    await choose("Copy file");
    expect(runtime.copyTabFile).toHaveBeenCalledExactlyOnceWith("tab-1");
    await choose("Copy file path");
    expect(runtime.copyText).toHaveBeenLastCalledWith("C:\\notes\\draft.md");
    await choose("Copy folder path");
    expect(runtime.copyText).toHaveBeenLastCalledWith("C:\\notes");
    await choose("Close all tabs");
    expect(runtime.closeEveryTab).toHaveBeenCalledOnce();
    expect(runtime.copyText).toHaveBeenCalledTimes(2);
  });

  it("copies the file of the tab right-clicked, also one in back, and offers it only when the runtime can", async () => {
    const store = makeStore();
    store.patchDoc({ filePath: "/notes/front.md" });
    const back = store.addTab({ ...store.get().doc, filePath: "/notes/back.md" });
    store.activateTab("tab-1");
    runtime.canCopyTabFile.mockImplementation((id: string) => id === back);
    render(<App store={store} />);
    const user = userEvent.setup();
    const copyFile = () => screen.getByRole("menuitem", { name: "Copy file" });

    fireEvent.contextMenu(screen.getByRole("tab", { name: "front.md" }));
    expect(runtime.canCopyTabFile).toHaveBeenLastCalledWith("tab-1");
    expect(copyFile().hasAttribute("disabled")).toBe(true);
    closeContextMenu();

    fireEvent.contextMenu(screen.getByRole("tab", { name: "back.md" }));
    expect(copyFile().hasAttribute("disabled")).toBe(false);
    await user.click(copyFile());
    expect(runtime.copyTabFile).toHaveBeenCalledExactlyOnceWith(back);
    expect(runtime.activateDocumentTab).not.toHaveBeenCalled();
  });

  it("disables the path items for an untitled tab, and leaves Copy file to the runtime", () => {
    runtime.canCopyTabFile.mockReturnValue(true);
    render(<App store={makeStore()} />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Untitled" }));

    const disabled = (label: string) => screen.getByRole("menuitem", { name: label }).hasAttribute("disabled");
    expect(disabled("Open folder")).toBe(true);
    expect(disabled("Copy file")).toBe(false);
    expect(disabled("Copy file path")).toBe(true);
    expect(disabled("Copy folder path")).toBe(true);
    expect(disabled("Close all tabs")).toBe(false);
  });
});

describe("Document tab strip keyboard", () => {
  it("moves focus and the active tab with the arrow keys, Home and End, keeping only the active tab in the Tab order", async () => {
    const store = makeStore();
    store.patchDoc({ filePath: "/notes/a.md" });
    const second = store.addTab({ ...store.get().doc, filePath: "/notes/b.md" });
    const third = store.addTab({ ...store.get().doc, filePath: "/notes/c.md" });
    store.activateTab("tab-1");
    runtime.activateDocumentTab.mockImplementation((id: string) => store.activateTab(id));
    render(<App store={store} />);
    const user = userEvent.setup();
    const tab = (name: string) => screen.getByRole("tab", { name });
    const tabIndexes = () => screen.getAllByRole("tab").map((element) => element.tabIndex);
    expect(tabIndexes()).toEqual([0, -1, -1]);

    tab("a.md").focus();
    await user.keyboard("{ArrowRight}");
    expect(runtime.activateDocumentTab).toHaveBeenLastCalledWith(second);
    expect(document.activeElement).toBe(tab("b.md"));
    expect(tabIndexes()).toEqual([-1, 0, -1]);

    await user.keyboard("{End}");
    expect(runtime.activateDocumentTab).toHaveBeenLastCalledWith(third);
    expect(document.activeElement).toBe(tab("c.md"));

    // The arrows wrap around at either end.
    await user.keyboard("{ArrowRight}");
    expect(runtime.activateDocumentTab).toHaveBeenLastCalledWith("tab-1");
    expect(document.activeElement).toBe(tab("a.md"));
    await user.keyboard("{ArrowLeft}");
    expect(runtime.activateDocumentTab).toHaveBeenLastCalledWith(third);
    expect(document.activeElement).toBe(tab("c.md"));
    expect(tabIndexes()).toEqual([-1, -1, 0]);

    await user.keyboard("{Home}");
    expect(runtime.activateDocumentTab).toHaveBeenLastCalledWith("tab-1");
    expect(document.activeElement).toBe(tab("a.md"));
    expect(tabIndexes()).toEqual([0, -1, -1]);
  });
});
