// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppStore } from "../app/createAppStore";
import { SettingsModel } from "../settings/SettingsModel";
import { applyTheme } from "./theme";

class TestMediaQueryList implements MediaQueryList {
  matches = false;
  readonly media = "(prefers-color-scheme: dark)";
  onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null = null;
  private changeListener: ((event: MediaQueryListEvent) => void) | null = null;

  readonly addEventListener = vi.fn(
    (_type: string, listener: EventListenerOrEventListenerObject | null): void => {
      if (typeof listener === "function") {
        this.changeListener = listener as (event: MediaQueryListEvent) => void;
      }
    },
  ) as MediaQueryList["addEventListener"];

  readonly removeEventListener = vi.fn(
    (_type: string, listener: EventListenerOrEventListenerObject | null): void => {
      if (listener === this.changeListener) this.changeListener = null;
    },
  ) as MediaQueryList["removeEventListener"];

  addListener(listener: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null): void {
    this.changeListener = listener as ((event: MediaQueryListEvent) => void) | null;
  }

  removeListener(listener: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null): void {
    if (listener === this.changeListener) this.changeListener = null;
  }

  dispatchEvent(): boolean {
    return true;
  }

  emit(matches: boolean): void {
    this.matches = matches;
    this.changeListener?.({ matches } as MediaQueryListEvent);
  }
}

describe("system theme lifecycle", () => {
  let query: TestMediaQueryList;

  beforeEach(() => {
    query = new TestMediaQueryList();
    vi.stubGlobal("matchMedia", vi.fn(() => query));
  });

  afterEach(() => {
    applyTheme("light", "light")();
    vi.unstubAllGlobals();
  });

  it("keeps following system changes until its disposer is called", () => {
    const dispose = applyTheme("system", "follow-ui");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.getAttribute("data-editor-theme")).toBe("light");

    query.emit(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-editor-theme")).toBe("dark");

    dispose();
    expect(query.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    query.emit(false);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("keeps the UI and document themes independent", () => {
    const disposeDarkUi = applyTheme("dark", "light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-editor-theme")).toBe("light");
    disposeDarkUi();

    const disposeLightUi = applyTheme("light", "dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.getAttribute("data-editor-theme")).toBe("dark");
    disposeLightUi();
  });

  it("releases the SettingsModel system listener on destroy", async () => {
    const store = createAppStore();
    store.set({
      settings: { ...store.get().settings, theme: "system", editorTheme: "follow-ui" },
    });
    const model = new SettingsModel(store, vi.fn());
    await model.init();

    expect(query.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    model.destroy();
    expect(query.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
