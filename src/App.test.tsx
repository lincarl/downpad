// @vitest-environment jsdom
import { StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
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
    expect(runtime.openSettings).toHaveBeenCalledOnce();
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
