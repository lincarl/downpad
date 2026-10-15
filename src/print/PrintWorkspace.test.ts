// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrinterInfo } from "../ipc/contracts";
import { DEFAULT_SETTINGS } from "../settings/defaults";
import type { Settings } from "../state/types";
import { PrintWorkspace, type PrintJob } from "./PrintWorkspace";

const printRenderMocks = vi.hoisted(() => ({
  renderPrintPages: vi.fn((_request: unknown) => {
    const root = document.createElement("div");
    root.className = "print-root";
    root.innerHTML = '<div class="print-page"></div><div class="print-page"></div>';
    return root;
  }),
}));

const nativeMocks = vi.hoisted(() => ({
  listPrinters: vi.fn(async (): Promise<PrinterInfo[]> => []),
  printWebview: vi.fn(async () => {}),
  printWebviewToPdf: vi.fn(async () => {}),
  saveDialog: vi.fn(async () => null as string | null),
  onPrintCompleted: vi.fn(
    (handler: (result: { ok: boolean; message?: string }) => void) => {
      queueMicrotask(() => handler({ ok: true }));
      return Promise.resolve(() => {});
    },
  ),
}));

vi.mock("./printRender", () => ({
  renderPrintPages: printRenderMocks.renderPrintPages,
  pageCount: (root: HTMLElement) => root.querySelectorAll(".print-page").length,
}));

vi.mock("../ipc/commands", () => ({
  listPrinters: nativeMocks.listPrinters,
  printWebview: nativeMocks.printWebview,
  printWebviewToPdf: nativeMocks.printWebviewToPdf,
}));

vi.mock("../ipc/events", () => ({ onPrintCompleted: nativeMocks.onPrintCompleted }));
vi.mock("../ipc/dialogs", () => ({ saveDialog: nativeMocks.saveDialog }));

class TestResizeObserver implements ResizeObserver {
  static latest: TestResizeObserver | null = null;
  readonly disconnect = vi.fn();
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();

  constructor(_callback: ResizeObserverCallback) {
    TestResizeObserver.latest = this;
  }
}

const JOB: PrintJob = {
  markdown: "# Notes\n",
  documentNode: null,
  docTitle: "notes.md",
};

function enableElectron(): void {
  Object.defineProperty(window, "mdEasy", { value: {}, configurable: true });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function changeSelect(name: string, value: string): void {
  const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`);
  if (!select) throw new Error(`Missing ${name} select`);
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** The radio whose label reads `label`. */
function radio(label: string): HTMLInputElement {
  const input = Array.from(
    document.querySelectorAll<HTMLInputElement>('.print-workspace input[type="radio"]'),
  ).find((candidate) => candidate.closest("label")?.textContent === label);
  if (!input) throw new Error(`Missing ${label} radio`);
  return input;
}

function button(text: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!match) throw new Error(`Missing ${text} button`);
  return match;
}

function pressTab(shiftKey = false): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }),
    );
  });
}

function editInput(name: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`);
  if (!input) throw new Error(`Missing ${name} input`);
  act(() => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

describe("PrintWorkspace React view", () => {
  let workspace: PrintWorkspace | null = null;
  let saveSettings: ReturnType<typeof vi.fn<(settings: Settings) => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    document.documentElement.classList.remove("printing");
    delete window.mdEasy;
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    saveSettings = vi.fn<(settings: Settings) => void>();
    workspace = new PrintWorkspace({
      getSettings: () => DEFAULT_SETTINGS,
      saveSettings,
    });
  });

  afterEach(() => {
    workspace?.close();
    workspace = null;
    delete window.mdEasy;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("behaves as a modal workspace and restores the covered app and focus", async () => {
    const app = document.createElement("main");
    app.id = "app";
    app.setAttribute("aria-hidden", "false");
    const trigger = document.createElement("button");
    trigger.textContent = "Open print";
    app.appendChild(trigger);
    document.body.appendChild(app);
    const initialInert = app.inert;
    trigger.focus();

    act(() => workspace!.open(JOB));

    const dialog = document.querySelector<HTMLElement>('.print-workspace[role="dialog"]')!;
    const cancel = button("Cancel");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(app.inert).toBe(true);
    expect(app.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).toBe(cancel);

    // Programmatic focus cannot escape the workspace even in DOM environments
    // that do not implement native inert focus suppression.
    act(() => trigger.focus());
    expect(document.activeElement).toBe(cancel);

    act(() => workspace!.close());
    await flush();
    expect(app.inert).toBe(initialInert);
    expect(app.getAttribute("aria-hidden")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("renders the established workspace selectors and re-paginates from React controls", () => {
    act(() => workspace!.open(JOB));

    const dialog = document.querySelector<HTMLElement>('.print-workspace[role="dialog"]');
    expect(dialog?.getAttribute("aria-label")).toBe("Print");
    expect(dialog?.querySelector(".print-ws-title")?.textContent).toBe("Print");
    expect(dialog?.querySelector(".print-ws-paper")?.textContent).toBe(
      "A4 · Portrait · 210 × 297 mm · 2 pages",
    );
    expect(dialog?.querySelector(".print-ws-note")?.textContent).toBe("System dialog");
    expect(dialog?.querySelector(".print-ws-scaler > .print-root")).not.toBeNull();
    expect(printRenderMocks.renderPrintPages).toHaveBeenCalledTimes(1);

    expect(radio("Document").checked).toBe(true);
    act(() => radio("Markdown").click());
    expect(radio("Markdown").checked).toBe(true);

    expect(printRenderMocks.renderPrintPages).toHaveBeenCalledTimes(2);
    expect(printRenderMocks.renderPrintPages.mock.calls[1]?.[0]).toMatchObject({
      version: "markdown",
      markdown: JOB.markdown,
      docTitle: JOB.docTitle,
    });
    expect(dialog?.querySelector(".print-ws-hint")?.textContent).toContain(
      "raw Markdown source",
    );
    // React owns the surrounding preview while the pagination renderer owns the
    // page nodes within its dedicated slot; re-rendering must keep that boundary.
    expect(dialog?.querySelector(".print-ws-scaler > .print-root")).not.toBeNull();
  });

  it("switches orientation with radios and describes the paper under the preview", () => {
    act(() => workspace!.open(JOB));
    const paper = document.querySelector(".print-ws-paper");
    expect(paper?.textContent).toContain("A4 · Portrait · 210 × 297 mm");
    expect(document.querySelector('[role="radiogroup"][aria-label="Orientation"]')).not.toBeNull();

    act(() => radio("Landscape").click());

    expect(printRenderMocks.renderPrintPages).toHaveBeenCalledTimes(2);
    const geometry = (
      printRenderMocks.renderPrintPages.mock.calls[1]?.[0] as {
        geometry: { widthPx: number; heightPx: number };
      }
    ).geometry;
    expect(geometry.widthPx).toBeGreaterThan(geometry.heightPx);
    expect(paper?.textContent).toContain("A4 · Landscape · 297 × 210 mm");

    changeSelect("Paper size", "letter");
    expect(paper?.textContent).toContain("Letter · Landscape · 279.4 × 215.9 mm");
  });

  it("traps Tab through the checked radio of each group and wraps at both ends", () => {
    act(() => workspace!.open(JOB));
    const print = button("Print");

    act(() => print.focus());
    pressTab();
    // The first stop is the checked Version radio, not every radio in DOM order.
    expect(document.activeElement).toBe(radio("Document"));

    act(() => radio("Markdown").click());
    act(() => radio("Markdown").focus());
    pressTab(true);
    expect(document.activeElement).toBe(print);
  });

  it("does not persist an untouched workspace and closes it with Escape", () => {
    act(() => workspace!.open(JOB));
    // Merely focusing and leaving a numeric field is not a settings change.
    editInput("Copies", "1");
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => document.dispatchEvent(escape));

    expect(escape.defaultPrevented).toBe(true);
    expect(workspace!.isOpen()).toBe(false);
    expect(document.querySelector(".print-workspace")).toBeNull();
    expect(saveSettings).not.toHaveBeenCalled();
    expect(TestResizeObserver.latest?.disconnect).toHaveBeenCalledOnce();
  });

  it("clamps changed numeric settings and persists the working copy on close", () => {
    act(() => workspace!.open(JOB));
    editInput("Scale", "999");

    expect(printRenderMocks.renderPrintPages).toHaveBeenCalledTimes(2);
    act(() => workspace!.close());

    expect(saveSettings).toHaveBeenCalledOnce();
    expect(saveSettings.mock.calls[0]?.[0]).toMatchObject({ printScalePercent: 200 });
  });

  it("steps number fields with the stepper and stops at the range ends", () => {
    act(() => workspace!.open(JOB));
    const copies = document.querySelector<HTMLInputElement>('input[aria-label="Copies"]')!;
    const [up, down] = Array.from(
      copies.parentElement!.querySelectorAll<HTMLButtonElement>("button"),
    );
    // At the minimum the down stepper is off, and neither stepper is a tab stop.
    expect(down!.disabled).toBe(true);
    expect(up!.tabIndex).toBe(-1);

    act(() => up!.click());
    expect(copies.value).toBe("2");
    expect(down!.disabled).toBe(false);
    act(() => workspace!.close());

    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ printCopies: 2 }));
  });

  it("keeps native PDF options and default-printer persistence semantics", async () => {
    enableElectron();
    nativeMocks.listPrinters.mockResolvedValueOnce([
      { name: "Office", isDefault: true },
    ]);
    nativeMocks.saveDialog.mockResolvedValueOnce("C:/docs/notes.pdf");

    act(() => workspace!.open(JOB));
    await flush();

    const printer = document.querySelector<HTMLSelectElement>('select[aria-label="Printer"]');
    expect(printer?.value).toBe("Office");
    // Auto-detecting the default alone must not make the working copy dirty.
    expect(saveSettings).not.toHaveBeenCalled();

    editInput("Copies", "3");
    changeSelect("Pages", "custom");
    const range = document.querySelector<HTMLInputElement>(".print-ws-range")!;
    act(() => {
      range.value = "1-2";
      range.dispatchEvent(new Event("input", { bubbles: true }));
      range.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    const savePdf = Array.from(document.querySelectorAll<HTMLButtonElement>(".dialog-btn")).find(
      (button) => button.textContent?.trim() === "Save as PDF",
    );
    act(() => savePdf!.click());
    await flush();
    await flush();

    expect(nativeMocks.saveDialog).toHaveBeenCalledWith({
      defaultPath: "notes.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    expect(nativeMocks.printWebviewToPdf).toHaveBeenCalledWith(
      "C:/docs/notes.pdf",
      expect.objectContaining({
        printerName: "Office",
        copies: 3,
        orientation: "portrait",
        pageRanges: "1-2",
      }),
    );
    expect(workspace!.isOpen()).toBe(false);
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ printerName: "Office", printCopies: 3 }),
    );
    expect(document.documentElement.classList.contains("printing")).toBe(false);
    expect(document.querySelector("body > .print-root")).toBeNull();
  });

  it("holds Print and Save as PDF until the custom range names existing pages", async () => {
    act(() => workspace!.open(JOB));
    await flush();
    changeSelect("Pages", "custom");
    const range = document.querySelector<HTMLInputElement>(".print-ws-range")!;
    const commit = (value: string): void =>
      act(() => {
        range.value = value;
        range.dispatchEvent(new Event("input", { bubbles: true }));
        range.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      });

    // The mocked layout has two pages.
    commit("1-3");
    expect(document.querySelector(".print-ws-range-error")?.textContent).toBe("This document has 2 pages.");
    expect(range.getAttribute("aria-invalid")).toBe("true");
    expect(button("Print").disabled).toBe(true);
    expect(button("Save as PDF").disabled).toBe(true);

    commit("1-2");
    expect(document.querySelector(".print-ws-range-error")).toBeNull();
    expect(range.hasAttribute("aria-invalid")).toBe(false);
    expect(button("Print").disabled).toBe(false);
    expect(button("Save as PDF").disabled).toBe(false);
  });

  it("cancels the browser afterprint waiter when the workspace closes", async () => {
    vi.useFakeTimers();
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const clearTimeout = vi.spyOn(globalThis, "clearTimeout");

    act(() => workspace!.open(JOB));
    act(() => button("Print").click());

    expect(print).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    act(() => workspace!.close());
    await flush();

    expect(removeEventListener).toHaveBeenCalledWith("afterprint", expect.any(Function));
    expect(clearTimeout).toHaveBeenCalled();
  });

  it("releases a pending native completion listener when closed", async () => {
    vi.useFakeTimers();
    enableElectron();
    const unlisten = vi.fn();
    const clearTimeout = vi.spyOn(globalThis, "clearTimeout");
    nativeMocks.onPrintCompleted.mockImplementationOnce(() => Promise.resolve(unlisten));

    act(() => workspace!.open(JOB));
    act(() => button("Print").click());
    await flush();

    act(() => workspace!.close());
    await flush();

    expect(unlisten).toHaveBeenCalledOnce();
    expect(clearTimeout).toHaveBeenCalled();
  });
});
