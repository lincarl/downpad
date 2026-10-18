// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/settings/defaults";
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
  openSettings: vi.fn(),
  toggleDocumentTheme: vi.fn(),
  zoomDocument: vi.fn(),
  showRecentView: vi.fn(),
  activateDocumentTab: vi.fn(),
  closeDocumentTab: vi.fn(),
  closeEveryTab: vi.fn(),
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
  };
  return new Store(state);
}

beforeEach(() => {
  for (const value of Object.values(runtime)) value.mockClear();
});

afterEach(() => cleanup());

describe("App shell", () => {
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

  it("shows a tab whose Document view failed in Markdown, with its notice, only while that tab is active", async () => {
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
      "md-easy can't show deep.md in the Document view (Maximum call stack size exceeded), so it is open in the Markdown view.",
    );
    expect(screen.getByRole("radio", { name: "Markdown" }).getAttribute("aria-checked")).toBe("true");
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
      `md-easy can't show ${"n".repeat(20)}…${"n".repeat(13)}-v2.md in the Document view (${"x".repeat(59)}…), so it is open in the Markdown view.`,
    );
    const message = screen.getByRole("alert").querySelector(".banner-message")!;
    expect(message.classList.contains("line-clamp-2")).toBe(true);
    expect(message.getAttribute("title")).toBe(
      `md-easy can't show ${name} in the Document view (${"x".repeat(300)}), so it is open in the Markdown view.`,
    );

    // Other tabs show the window's layout and no notice.
    act(() => store.activateTab(other));
    expect(notice()).toBeUndefined();
    expect(screen.getByRole("radio", { name: "Split" }).getAttribute("aria-checked")).toBe("true");
    expect(area.classList.contains("split")).toBe(true);
  });

  it("keeps Settings in the application menu and exposes a document-theme toggle", async () => {
    const store = makeStore();
    render(<App store={store} />);
    const user = userEvent.setup();

    expect(screen.queryByRole("menuitem", { name: "Settings" })).toBeNull();
    const themeButton = screen.getByRole("button", {
      name: "Switch to dark document theme",
    });
    expect(themeButton.querySelector(".lucide-moon")).toBeTruthy();
    await user.click(themeButton);
    expect(runtime.toggleDocumentTheme).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Application menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    await waitFor(() => expect(runtime.openSettings).toHaveBeenCalledOnce());
  });

  it("closes a toolbar menu on Tab and moves on from its button", async () => {
    render(<App store={makeStore()} />);
    const user = userEvent.setup();
    const menuButton = screen.getByRole("button", { name: "Application menu" });

    await user.click(menuButton);
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    await user.tab();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Open"));

    await user.click(screen.getByRole("button", { name: "Save options" }));
    await user.tab({ shift: true });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Save"));
  });

  it("shows the sun action for a dark document surface", () => {
    const store = makeStore();
    store.set({
      settings: { ...store.get().settings, editorTheme: "dark" },
    });
    render(<App store={store} />);

    const themeButton = screen.getByRole("button", {
      name: "Switch to light document theme",
    });
    expect(themeButton.querySelector(".lucide-sun")).toBeTruthy();
  });
});
