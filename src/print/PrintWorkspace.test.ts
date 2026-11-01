// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
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
  documentNode: document.createElement("div"),
  docTitle: "notes.md",
};

function enableElectron(): void {
  Object.defineProperty(window, "downpadDesktop", { value: {}, configurable: true });
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
    delete window.downpadDesktop;
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
    delete window.downpadDesktop;
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

  it("shows the print options and re-paginates from React controls", () => {
    act(() => workspace!.open(JOB));

    const dialog = screen.getByRole("dialog", { name: "Print" });
    expect(within(dialog).getByRole("heading", { name: "Print" })).toBeTruthy();
    expect(dialog.querySelector(".print-ws-paper")?.textContent).toBe(
      "A4 · Portrait · 210 × 297 mm · 2 pages",
    );
    // The browser build prints through the system dialog, so it lists no printers.
    expect(within(within(dialog).getByRole("group", { name: "Printer" })).getByText("System dialog")).toBeTruthy();
    expect(dialog.querySelector(".print-ws-scaler > .print-root")).not.toBeNull();
    expect(printRenderMocks.renderPrintPages).toHaveBeenCalledTimes(1);

    expect(radio("Document").checked).toBe(true);
    expect(within(dialog).getByText("The formatted document, as the editor renders it.")).toBeTruthy();
    act(() => radio("Markdown").click());
    expect(radio("Markdown").checked).toBe(true);

    expect(printRenderMocks.renderPrintPages).toHaveBeenCalledTimes(2);
    expect(printRenderMocks.renderPrintPages.mock.calls[1]?.[0]).toMatchObject({
      version: "markdown",
      markdown: JOB.markdown,
      docTitle: JOB.docTitle,
    });
    expect(within(dialog).getByText("The raw Markdown source, in a monospace face.")).toBeTruthy();
    // React owns the surrounding preview while the pagination renderer owns the
    // page nodes within its dedicated slot; re-rendering must keep that boundary.
    expect(dialog.querySelector(".print-ws-scaler > .print-root")).not.toBeNull();
  });

  it("prints the Markdown version of a document Downpad could not render, keeping the saved choice", () => {
    act(() => workspace!.open({ ...JOB, documentNode: null }));

    expect(radio("Markdown").checked).toBe(true);
    expect(radio("Document").disabled).toBe(true);
    expect(printRenderMocks.renderPrintPages.mock.calls[0]?.[0]).toMatchObject({ version: "markdown" });
    expect(
      screen.getByText("Downpad can't show this document in the Document view, so it prints the Markdown source."),
    ).toBeTruthy();

    editInput("Scale", "120");
    act(() => workspace!.close());
    expect(saveSettings.mock.calls[0]?.[0]).toMatchObject({ printVersion: "document", printScalePercent: 120 });
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
    let complete!: (result: { ok: boolean }) => void;
    const unlisten = vi.fn();
    nativeMocks.onPrintCompleted.mockImplementationOnce((handler) => {
      complete = handler;
      return Promise.resolve(unlisten);
    });
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
    changeSelect("Paper size", "letter");
    act(() => radio("Landscape").click());
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

    expect(nativeMocks.saveDialog).toHaveBeenCalledWith({
      defaultPath: "notes.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    expect(nativeMocks.printWebviewToPdf).toHaveBeenCalledWith(
      "C:/docs/notes.pdf",
      expect.objectContaining({
        printerName: "Office",
        copies: 3,
        orientation: "landscape",
        pageWidthIn: 11,
        pageHeightIn: 8.5,
        pageRanges: "1-2",
      }),
    );
    // Accepting the native command is not completion. Keep the sheets available
    // to Electron until its completion event arrives.
    expect(workspace!.isOpen()).toBe(true);
    expect(document.documentElement.classList.contains("printing")).toBe(true);
    expect(document.querySelector("body > .print-root")).not.toBeNull();
    expect(unlisten).not.toHaveBeenCalled();
    act(() => complete({ ok: true }));
    await flush();

    expect(workspace!.isOpen()).toBe(false);
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ printerName: "Office", printCopies: 3 }),
    );
    expect(document.documentElement.classList.contains("printing")).toBe(false);
    expect(document.querySelector("body > .print-root")).toBeNull();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("keeps the workspace open and ready to print again when the printer fails", async () => {
    enableElectron();
    let complete!: (result: { ok: boolean; message?: string }) => void;
    const unlisten = vi.fn();
    nativeMocks.onPrintCompleted.mockImplementationOnce((handler) => {
      complete = handler;
      return Promise.resolve(unlisten);
    });
    act(() => workspace!.open(JOB));
    await flush();
    const preview = document.querySelector(".print-ws-scaler > .print-root");

    act(() => button("Print").click());
    await flush();
    expect(document.querySelector(".print-ws-status")?.textContent).toBe("Printing…");
    // Leaving mid-job would tear down the sheets while Electron still prints
    // them, so Cancel and Escape wait for the job to end.
    expect(button("Cancel").disabled).toBe(true);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(workspace!.isOpen()).toBe(true);
    act(() => complete({ ok: false, message: "The printer rejected the job." }));
    await flush();

    expect(document.querySelector(".print-ws-status")?.textContent).toBe("The printer rejected the job.");
    expect(button("Cancel").disabled).toBe(false);
    expect(workspace!.isOpen()).toBe(true);
    expect(document.querySelector(".print-ws-scaler > .print-root")).toBe(preview);
    expect(document.querySelector("body > .print-root")).toBeNull();
    expect(document.documentElement.classList.contains("printing")).toBe(false);
    expect(unlisten).toHaveBeenCalledOnce();

    act(() => button("Print").click());
    await flush();

    expect(nativeMocks.printWebview).toHaveBeenCalledTimes(2);
    expect(workspace!.isOpen()).toBe(false);
  });

  it("reports a PDF export that fails to start", async () => {
    enableElectron();
    const unlisten = vi.fn();
    nativeMocks.onPrintCompleted.mockImplementationOnce(() => Promise.resolve(unlisten));
    nativeMocks.saveDialog.mockResolvedValueOnce("/docs/notes.pdf");
    nativeMocks.printWebviewToPdf.mockRejectedValueOnce(new Error("A print job is already running."));
    vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => workspace!.open(JOB));
    await flush();
    const preview = document.querySelector(".print-ws-scaler > .print-root");

    act(() => button("Save as PDF").click());
    await flush();

    expect(nativeMocks.printWebviewToPdf).toHaveBeenCalledOnce();
    expect(workspace!.isOpen()).toBe(true);
    expect(document.querySelector(".print-ws-status")?.textContent).toBe("A print job is already running.");
    expect(button("Cancel").disabled).toBe(false);
    expect(button("Save as PDF").disabled).toBe(false);
    expect(document.querySelector(".print-ws-scaler > .print-root")).toBe(preview);
    expect(document.querySelector("body > .print-root")).toBeNull();
    expect(document.documentElement.classList.contains("printing")).toBe(false);
    expect(unlisten).toHaveBeenCalledOnce();

    nativeMocks.saveDialog.mockResolvedValueOnce("/docs/notes.pdf");
    act(() => button("Save as PDF").click());
    await flush();

    expect(nativeMocks.printWebviewToPdf).toHaveBeenCalledTimes(2);
    expect(workspace!.isOpen()).toBe(false);
  });

  it.each([
    { error: "The print service is unavailable.", message: "The print service is unavailable." },
    { error: new Error(""), message: "Printing failed." },
    { error: "  ", message: "Printing failed." },
    { error: undefined, message: "Printing failed." },
    { error: { code: "UNKNOWN" }, message: "Printing failed." },
  ])("reports a PDF startup rejection as $message", async ({ error, message }) => {
    enableElectron();
    nativeMocks.saveDialog.mockResolvedValueOnce("/docs/notes.pdf");
    nativeMocks.printWebviewToPdf.mockRejectedValueOnce(error);
    vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => workspace!.open(JOB));
    await flush();

    act(() => button("Save as PDF").click());
    await flush();

    expect(document.querySelector(".print-ws-status")?.textContent).toBe(message);
    expect(workspace!.isOpen()).toBe(true);
    expect(button("Save as PDF").disabled).toBe(false);
  });

  it("leaves the preview usable when the PDF dialog is cancelled", async () => {
    enableElectron();
    act(() => workspace!.open(JOB));
    await flush();
    const preview = document.querySelector(".print-ws-scaler > .print-root");
    expect(preview).not.toBeNull();

    act(() => button("Save as PDF").click());
    await flush();

    expect(nativeMocks.saveDialog).toHaveBeenCalledOnce();
    expect(nativeMocks.printWebviewToPdf).not.toHaveBeenCalled();
    expect(nativeMocks.onPrintCompleted).not.toHaveBeenCalled();
    expect(workspace!.isOpen()).toBe(true);
    expect(document.querySelector(".print-ws-scaler > .print-root")).toBe(preview);
    expect(document.documentElement.classList.contains("printing")).toBe(false);
    act(() => radio("Markdown").click());
    expect(printRenderMocks.renderPrintPages).toHaveBeenLastCalledWith(
      expect.objectContaining({ version: "markdown" }),
    );
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

    // A cleared range stays Custom and blocks printing instead of printing everything.
    commit("");
    expect(document.querySelector<HTMLSelectElement>('select[aria-label="Pages"]')?.value).toBe("custom");
    expect(document.querySelector(".print-ws-range-error")?.textContent).toBe(
      "Use page numbers and ranges, such as 1-3, 5.",
    );
    expect(button("Print").disabled).toBe(true);
  });

  it("cancels the browser afterprint waiter when the workspace closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    const removeEventListener = vi.spyOn(window, "removeEventListener");

    act(() => workspace!.open(JOB));
    act(() => button("Print").click());

    expect(print).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    act(() => workspace!.close());
    await flush();

    expect(removeEventListener).toHaveBeenCalledWith("afterprint", expect.any(Function));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(vi.getTimerCount()).toBe(0);
    expect(document.querySelector(".print-root")).toBeNull();
    expect(document.documentElement.classList.contains("printing")).toBe(false);
  });

  it("releases a native listener that finishes registering after the workspace closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    enableElectron();
    const unlisten = vi.fn();
    let registered!: (dispose: () => void) => void;
    nativeMocks.onPrintCompleted.mockImplementationOnce(() => new Promise((resolve) => {
      registered = resolve;
    }));

    act(() => workspace!.open(JOB));
    act(() => button("Print").click());
    await flush();

    act(() => workspace!.close());
    await flush();
    expect(unlisten).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(vi.getTimerCount()).toBe(0);

    registered(unlisten);
    await flush();

    expect(unlisten).toHaveBeenCalledOnce();
    expect(document.querySelector(".print-root")).toBeNull();
    expect(document.documentElement.classList.contains("printing")).toBe(false);
  });
});
