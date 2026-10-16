// The print workspace (spec §5.21): a full-window print mode laid out like Mervin
// PDF's print dialog, with the options in group boxes on the left, a scrolling
// multi-page preview on the right and the actions in a footer row. It replaces
// both the old direct `window.print()` call and the WebView's own print dialog.
//
// The preview shows the very elements that get printed (printRender.ts) at a
// scaled-down size, so "what you see is the sheet". Changing any option
// re-paginates immediately.

import { saveDialog } from "../ipc/dialogs";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { fieldClassName } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { disposeReactRoot } from "@/app/disposeReactRoot";
import { isElectron } from "../ipc/env";
import { listPrinters, printWebview, printWebviewToPdf } from "../ipc/commands";
import { onPrintCompleted } from "../ipc/events";
import type { NativePrintOptions, PrinterInfo } from "../ipc/contracts";
import type { Settings } from "../state/types";
import { pageCount, renderPrintPages } from "./printRender";
import { pageRangeError } from "./pageRange";
import {
  MARGIN_PRESETS,
  PAPER_SIZES,
  clampScale,
  pageGeometry,
  type MarginPreset,
  type Orientation,
  type PageSetup,
  type PaperSize,
  type PrintVersion,
} from "./paper";

/** What is being printed. `documentNode` is a detached, already-sanitized clone,
 *  or null when md-easy could not render the document, so only the Markdown
 *  version can print. */
export interface PrintJob {
  markdown: string;
  documentNode: Element | null;
  /** File name shown in the header bar and the running header, e.g. "notes.md". */
  docTitle: string;
}

export interface PrintWorkspaceCallbacks {
  getSettings: () => Settings;
  /** Persist the print options the user changed, so the next print starts here. */
  saveSettings: (next: Settings) => void;
}

interface CoveredSibling {
  element: HTMLElement;
  inert: boolean;
  ariaHidden: string | null;
}

/** How long to wait for the backend to report a finished print before giving up. */
const PRINT_TIMEOUT_MS = 300_000;

/** Gap between the preview pane's edge and the sheets, as in Mervin (`p-5`). */
const PREVIEW_INSET_PX = 20;

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export class PrintWorkspace {
  private host: HTMLElement | null = null;
  private reactRoot: Root | null = null;
  private job: PrintJob | null = null;
  /** Working copy of the print settings; written back on close. */
  private settings: Settings | null = null;
  private printRoot: HTMLElement | null = null;
  private printers: PrinterInfo[] = [];
  /** Pages: All, or Custom with the range in `pageRange` (empty while cleared). */
  private pageMode: PageMode = "all";
  private pageRange = "";
  /** Sheets in the current layout; 0 until the first layout. */
  private pages = 0;
  private busy = false;
  /** Set once the user changes an option, so closing an untouched workspace
   *  doesn't rewrite settings.toml (and the auto-detected default printer isn't
   *  persisted as if it had been chosen). */
  private dirty = false;

  private scaler: HTMLElement | null = null;
  private canvas: HTMLElement | null = null;
  private summaryText = "";
  private statusText = "";
  private snapshot: PrintWorkspaceSnapshot | null = null;
  private readonly listeners = new Set<() => void>();
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private activePrintCancel: (() => void) | null = null;
  private previouslyFocused: HTMLElement | null = null;
  private coveredSiblings: CoveredSibling[] = [];

  constructor(private readonly cb: PrintWorkspaceCallbacks) {}

  isOpen(): boolean {
    return this.host !== null;
  }

  open(job: PrintJob): void {
    if (this.host) return;
    this.previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.job = job;
    this.settings = { ...this.cb.getSettings() };
    this.pageMode = "all";
    this.pageRange = "";
    this.dirty = false;
    this.summaryText = "";
    this.statusText = "";
    this.publish();
    this.mount();
    this.render();
    void this.loadPrinters(this.host);
    document.addEventListener("keydown", this.onKeydown, true);
    document.addEventListener("focusin", this.onFocusIn, true);
  }

  close(): void {
    if (!this.host) return;
    document.removeEventListener("keydown", this.onKeydown, true);
    document.removeEventListener("focusin", this.onFocusIn, true);
    const cancelPrint = this.activePrintCancel;
    this.activePrintCancel = null;
    cancelPrint?.();
    document.documentElement.classList.remove("printing");
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = null;
    const host = this.host;
    const reactRoot = this.reactRoot;
    const detachedPrintRoot =
      this.printRoot && !host.contains(this.printRoot) ? this.printRoot : null;
    const changedSettings = this.settings && this.dirty ? this.settings : null;
    this.host = null;
    this.reactRoot = null;
    if (reactRoot) disposeReactRoot(reactRoot, host);
    else host.remove();
    detachedPrintRoot?.remove();
    this.restoreCoveredSiblings();
    this.scaler = null;
    this.canvas = null;
    this.printRoot = null;
    this.job = null;
    if (changedSettings) this.cb.saveSettings(changedSettings);
    this.settings = null;
    this.snapshot = null;
    this.dirty = false;
    this.busy = false;
    this.listeners.clear();
    const restoreFocus = this.previouslyFocused;
    this.previouslyFocused = null;
    if (restoreFocus?.isConnected && !restoreFocus.inert) {
      restoreFocus.focus({ preventScroll: true });
    }
  }

  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && !this.busy) {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.key !== "Tab") return;

    const focusable = this.focusableElements();
    if (focusable.length === 0) {
      e.preventDefault();
      this.host?.querySelector<HTMLElement>(".print-workspace")?.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (!this.host?.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  private onFocusIn = (event: FocusEvent): void => {
    if (event.target instanceof Node && this.host && !this.host.contains(event.target)) {
      this.focusWorkspace();
    }
  };

  // ── React view ──────────────────────────────────────────────────────────

  private mount(): void {
    const host = document.createElement("div");
    host.className = "print-workspace-root";
    document.body.appendChild(host);
    this.coverSiblings(host);
    const reactRoot = createRoot(host);
    this.host = host;
    this.reactRoot = reactRoot;
    flushSync(() => {
      reactRoot.render(
        <PrintWorkspaceView
          subscribe={this.subscribe}
          getSnapshot={this.getSnapshot}
          setCanvas={this.setCanvas}
          setScaler={this.setScaler}
          onClose={() => this.close()}
          onSaveAsPdf={() => void this.saveAsPdf()}
          onPrint={() => void this.print()}
          onUpdate={(patch, repaginate) => this.update(patch, repaginate)}
          onPageModeChange={this.setPageMode}
          onPageRangeChange={this.setPageRange}
        />,
      );
    });
    if (!this.canvas) throw new Error("Print preview canvas did not mount");
    // Keep the sheet fitted to the pane as the window resizes.
    this.resizeObserver = new ResizeObserver(() => this.fitPreview());
    this.resizeObserver.observe(this.canvas);
    this.focusWorkspace();
  }

  private coverSiblings(host: HTMLElement): void {
    this.coveredSiblings = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== host)
      .map((element) => ({
        element,
        inert: element.inert,
        ariaHidden: element.getAttribute("aria-hidden"),
      }));
    for (const { element } of this.coveredSiblings) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
  }

  private restoreCoveredSiblings(): void {
    for (const { element, inert, ariaHidden } of this.coveredSiblings) {
      element.inert = inert;
      if (ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", ariaHidden);
    }
    this.coveredSiblings = [];
  }

  /** The workspace's tab sequence in DOM order. Like the browser, it holds only
   *  the checked radio of a group, so the trap wraps from the right element. */
  private focusableElements(): HTMLElement[] {
    const host = this.host;
    if (!host) return [];
    const radios = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    return Array.from(host.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => {
      if (element.tabIndex < 0 || element.hidden) return false;
      if (element.getAttribute("aria-hidden") === "true") return false;
      if (!(element instanceof HTMLInputElement) || element.type !== "radio") return true;
      return element.checked || !radios.some((r) => r.name === element.name && r.checked);
    });
  }

  /** Focus Cancel, the safe default (Enter closes, as Back used to), falling back
   *  to the first control and then the workspace itself. */
  private focusWorkspace(): void {
    const target =
      this.host?.querySelector<HTMLElement>(".print-ws-cancel") ??
      this.focusableElements()[0] ??
      this.host?.querySelector<HTMLElement>(".print-workspace");
    target?.focus({ preventScroll: true });
  }

  private readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private readonly getSnapshot = (): PrintWorkspaceSnapshot => {
    if (!this.snapshot) throw new Error("Print workspace is not open");
    return this.snapshot;
  };

  private publish(): void {
    if (!this.settings) return;
    this.snapshot = {
      settings: this.settings,
      printers: this.printers,
      pageMode: this.pageMode,
      pageRange: this.pageRange,
      rangeError: this.rangeError(),
      summary: this.summaryText,
      status: this.statusText,
      electron: isElectron(),
      documentRendered: this.job?.documentNode != null,
    };
    for (const listener of this.listeners) listener();
  }

  private readonly setCanvas = (node: HTMLElement | null): void => {
    this.canvas = node;
  };

  private readonly setScaler = (node: HTMLElement | null): void => {
    this.scaler = node;
  };

  /** All / a custom "1-3,5" range. The range never re-paginates — it only narrows
   *  which of the rendered sheets the printer is asked for. */
  private readonly setPageMode = (mode: PageMode): void => {
    this.pageMode = mode;
    this.pageRange = mode === "custom" ? this.pageRange || "1" : "";
    this.publish();
  };

  private readonly setPageRange = (range: string): void => {
    this.pageRange = range.trim();
    this.publish();
  };

  // ── Rendering ───────────────────────────────────────────────────────────

  /** Apply a settings change; `repaginate` is false for options that don't
   *  affect the sheets (printer, copies). */
  private update(patch: Partial<Settings>, repaginate = true): void {
    this.settings = { ...this.settings!, ...patch };
    this.dirty = true;
    if (repaginate) this.render();
    else this.updateSummary();
  }

  private setup(): PageSetup {
    const s = this.settings!;
    return {
      paperSize: s.printPaperSize,
      orientation: s.printOrientation,
      margins: s.printMargins,
      scale: clampScale(s.printScalePercent / 100),
      header: s.printHeaderTitle || s.printHeaderDate,
      footer: s.printFooterPageNumbers,
    };
  }

  private render(): void {
    const s = this.settings!;
    const job = this.job!;
    const geometry = pageGeometry(this.setup());
    const root = renderPrintPages({
      version: job.documentNode ? s.printVersion : "markdown",
      documentNode: job.documentNode,
      markdown: job.markdown,
      geometry,
      runningHead: {
        title: s.printHeaderTitle,
        date: s.printHeaderDate,
        pageNumbers: s.printFooterPageNumbers,
      },
      docTitle: job.docTitle,
      dateLabel: new Date().toLocaleDateString(),
    });
    this.printRoot = root;
    this.scaler?.replaceChildren(root);
    this.fitPreview();
    this.updateSummary();
  }

  /** Scale the sheets so one whole sheet fits the preview pane inside its inset,
   *  as Mervin fits its page; the rest of the stack scrolls below it. A transform
   *  is used rather than `zoom` so the pages keep the exact layout they will
   *  print with. Layout sizes ignore transforms, so nothing is reset to measure. */
  private fitPreview(): void {
    const root = this.printRoot;
    const scaler = this.scaler;
    const canvas = this.canvas;
    if (!root || !scaler || !canvas) return;
    const sheet = root.querySelector<HTMLElement>(".print-page");
    const naturalWidth = sheet?.offsetWidth || root.offsetWidth;
    const sheetHeight = sheet?.offsetHeight || root.offsetHeight;
    const naturalHeight = root.offsetHeight;
    const availableWidth = canvas.clientWidth - PREVIEW_INSET_PX * 2;
    const availableHeight = canvas.clientHeight - PREVIEW_INSET_PX * 2;
    if (!naturalWidth || !sheetHeight || availableWidth <= 0 || availableHeight <= 0) return;
    const fit = Math.min(availableWidth / naturalWidth, availableHeight / sheetHeight);
    const scale = Math.min(1, Math.max(0.15, fit));
    root.style.transformOrigin = "top left";
    root.style.transform = `scale(${scale})`;
    scaler.style.width = `${naturalWidth * scale}px`;
    scaler.style.height = `${naturalHeight * scale}px`;
    // The sheet edge in app.css divides by this to stay one screen pixel wide.
    scaler.style.setProperty("--print-preview-scale", String(scale));
  }

  /** The page count shown at the end of the paper line under the preview. A new
   *  count also rechecks a custom page range against it. */
  private updateSummary(): void {
    const pages = this.printRoot ? pageCount(this.printRoot) : 0;
    this.pages = pages;
    this.summaryText = `${pages} ${pages === 1 ? "page" : "pages"}`;
    this.publish();
  }

  /** Why the custom page range cannot print, or null for All or a valid range.
   *  A cleared Custom range stays Custom and invalid, so it never prints everything. */
  private rangeError(): string | null {
    return this.pageMode === "custom" ? pageRangeError(this.pageRange, this.pages) : null;
  }

  // ── Printing ────────────────────────────────────────────────────────────

  private nativeOptions(): NativePrintOptions {
    const s = this.settings!;
    const geometry = pageGeometry(this.setup());
    return {
      printerName: s.printerName,
      copies: Math.max(1, Math.round(s.printCopies)),
      orientation: s.printOrientation,
      pageWidthIn: geometry.widthIn,
      pageHeightIn: geometry.heightIn,
      pageRanges: this.pageMode === "custom" ? this.pageRange : "",
    };
  }

  private async print(): Promise<void> {
    if (this.rangeError()) return;
    await this.withPrintDom(async () => {
      if (!isElectron()) {
        // Browser dev builds have no backend: fall back to the browser dialog.
        await this.runBrowserPrint();
        return;
      }
      try {
        await this.runNative(() => printWebview(this.nativeOptions()), "Printing…");
      } catch (err) {
        // The backend print command failed to start. Printing through the browser
        // dialog still produces the right pages — it just shows one more dialog.
        console.error("md-easy: native print unavailable, using the browser dialog", err);
        if (this.host) await this.runBrowserPrint();
      }
    });
  }

  private async saveAsPdf(): Promise<void> {
    if (this.rangeError()) return;
    if (!isElectron()) {
      this.flash("Save as PDF needs the installed app.");
      return;
    }
    const suggested = this.job!.docTitle.replace(/\.[^.]+$/, "") + ".pdf";
    const path = await saveDialog({
      defaultPath: suggested,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    }).catch(() => null);
    if (!path) return;
    await this.withPrintDom(() =>
      this.runNative(() => printWebviewToPdf(path, this.nativeOptions()), "Writing PDF…"),
    );
  }

  /**
   * Put the rendered sheets where the print stylesheet can find them — a direct
   * child of `<body>`, since `@media print` hides the whole `#app` container —
   * run `job`, then move them back into the preview.
   */
  private async withPrintDom(job: () => Promise<void>): Promise<void> {
    const root = this.printRoot;
    if (!root || this.busy) return;
    const workspaceHost = this.host;
    const workspaceScaler = this.scaler;
    this.busy = true;
    document.body.appendChild(root);
    const previousTransform = root.style.transform;
    root.style.transform = "";
    document.documentElement.classList.add("printing");
    try {
      await job();
    } catch (err) {
      console.error("md-easy: print failed", err);
      this.flash("Printing failed.");
    } finally {
      document.documentElement.classList.remove("printing");
      root.style.transform = previousTransform;
      if (this.host === workspaceHost && this.scaler === workspaceScaler && workspaceScaler) {
        workspaceScaler.appendChild(root);
      } else root.remove();
      if (this.host === workspaceHost) {
        this.busy = false;
        this.setStatus("");
        this.fitPreview();
      }
    }
  }

  /** Start a backend print job and wait for its `print-completed` event. The
   *  listener has to be in place before the job starts. Electron events aren't
   *  buffered — so it is torn down explicitly if the job never starts. */
  private async runNative(start: () => Promise<void>, label: string): Promise<void> {
    this.setStatus(label);
    const waiter = waitForPrintCompleted();
    this.activePrintCancel = waiter.cancel;
    try {
      try {
        await start();
      } catch (err) {
        waiter.cancel();
        throw err;
      }
      const result = await waiter.promise;
      if (!this.host) return;
      if (result.ok) this.close();
      else this.flash(result.message || "Printing was cancelled.");
    } finally {
      if (this.activePrintCancel === waiter.cancel) this.activePrintCancel = null;
    }
  }

  private async runBrowserPrint(): Promise<void> {
    const waiter = createBrowserPrintWaiter();
    this.activePrintCancel = waiter.cancel;
    try {
      waiter.start();
      await waiter.promise;
    } finally {
      if (this.activePrintCancel === waiter.cancel) this.activePrintCancel = null;
    }
  }

  private flash(message: string): void {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.setStatus(message);
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      if (this.statusText === message) this.setStatus("");
    }, 4000);
  }

  private setStatus(message: string): void {
    this.statusText = message;
    this.publish();
  }

  private async loadPrinters(openedHost: HTMLElement | null): Promise<void> {
    if (!isElectron()) return;
    const printers = await listPrinters().catch(() => []);
    if (!openedHost || this.host !== openedHost || !this.settings) return;
    this.printers = printers;
    // Land on the system default the first time, so the summary isn't vague.
    if (!this.settings!.printerName) {
      const fallback = this.printers.find((p) => p.isDefault);
      if (fallback) this.settings = { ...this.settings!, printerName: fallback.name };
    }
    this.updateSummary();
  }
}

interface PrintWaiter<T> {
  promise: Promise<T>;
  /** Drop the listener when the job never started. */
  cancel: () => void;
}

interface BrowserPrintWaiter extends PrintWaiter<void> {
  start: () => void;
}

/** Resolve when the backend reports the job finished, or on timeout. */
function waitForPrintCompleted(): PrintWaiter<{ ok: boolean; message?: string }> {
  let finish!: (result: { ok: boolean; message?: string }) => void;
  let unlisten: Promise<() => void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let listenerReleased = false;
  const releaseListener = (): void => {
    if (!unlisten || listenerReleased) return;
    listenerReleased = true;
    void unlisten.then((fn) => fn()).catch(() => {});
  };
  const promise = new Promise<{ ok: boolean; message?: string }>((resolve) => {
    finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      releaseListener();
      resolve(result);
    };
    timer = setTimeout(
      () => finish({ ok: false, message: "The printer did not respond." }),
      PRINT_TIMEOUT_MS,
    );
    unlisten = onPrintCompleted((result) => finish(result));
    if (settled) releaseListener();
  });
  return { promise, cancel: () => finish({ ok: false, message: "" }) };
}

/** Browser fallback: `afterprint` fires whether the user prints or cancels. */
function createBrowserPrintWaiter(): BrowserPrintWaiter {
  let resolvePromise!: () => void;
  let rejectPromise!: (reason?: unknown) => void;
  let settled = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cleanup = (): void => {
    window.removeEventListener("afterprint", finish);
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const finish = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise();
  };
  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectPromise(error);
  };

  window.addEventListener("afterprint", finish);
  timer = setTimeout(finish, 120_000);
  return {
    promise,
    cancel: finish,
    start: () => {
      try {
        window.print();
      } catch (error) {
        fail(error);
      }
    },
  };
}

// ── React workspace view ──────────────────────────────────────────────────

type PageMode = "all" | "custom";

interface PrintWorkspaceSnapshot {
  settings: Settings;
  printers: readonly PrinterInfo[];
  pageMode: PageMode;
  pageRange: string;
  /** Why the custom page range cannot print; Print and Save as PDF wait for a fix. */
  rangeError: string | null;
  summary: string;
  status: string;
  electron: boolean;
  /** False when the document could not be rendered; the Markdown version prints. */
  documentRendered: boolean;
}

interface PrintWorkspaceViewProps {
  subscribe(listener: () => void): () => void;
  getSnapshot(): PrintWorkspaceSnapshot;
  setCanvas(node: HTMLElement | null): void;
  setScaler(node: HTMLElement | null): void;
  onClose(): void;
  onSaveAsPdf(): void;
  onPrint(): void;
  onUpdate(patch: Partial<Settings>, repaginate?: boolean): void;
  onPageModeChange(mode: PageMode): void;
  onPageRangeChange(range: string): void;
}

const ORIENTATION_LABELS: Record<Orientation, string> = {
  portrait: "Portrait",
  landscape: "Landscape",
};

/** The paper line under the preview, as Mervin writes it: "A4 · Portrait · 210 × 297 mm". */
function describePaper(settings: Settings): string {
  const paper = PAPER_SIZES[settings.printPaperSize] ?? PAPER_SIZES.a4;
  const landscape = settings.printOrientation === "landscape";
  const width = landscape ? paper.heightMm : paper.widthMm;
  const height = landscape ? paper.widthMm : paper.heightMm;
  const name = paper.label.replace(/\s*\(.*\)$/, "");
  const mm = (value: number): string =>
    Math.abs(value - Math.round(value)) < 0.05 ? String(Math.round(value)) : value.toFixed(1);
  return `${name} · ${ORIENTATION_LABELS[settings.printOrientation]} · ${mm(width)} × ${mm(height)} mm`;
}

function PrintWorkspaceView({
  subscribe,
  getSnapshot,
  setCanvas,
  setScaler,
  onClose,
  onSaveAsPdf,
  onPrint,
  onUpdate,
  onPageModeChange,
  onPageRangeChange,
}: PrintWorkspaceViewProps) {
  const view = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const s = view.settings;
  const ids = useId();
  const printerOptions: Array<readonly [string, string]> = [["", "System default"]];
  for (const printer of view.printers) {
    printerOptions.push([
      printer.name,
      printer.isDefault ? `${printer.name} (default)` : printer.name,
    ]);
  }

  return (
    <div
      className="print-workspace fixed inset-0 z-[1200] flex flex-col bg-window text-ink outline-none"
      role="dialog"
      aria-label="Print"
      aria-modal="true"
      tabIndex={-1}
    >
      <div className="flex min-h-0 flex-1 px-[11px] pb-2.5 pt-[11px]">
        {/* Settings column: fixed width, scrolls on its own. */}
        <div className="print-ws-settings flex w-[390px] shrink-0 flex-col gap-1.5 overflow-y-auto leading-[18px] [scrollbar-gutter:stable]">
          <h2 className="print-ws-title m-0 mb-1 pt-1 text-[15px] font-semibold leading-5 text-ink-primary">
            Print
          </h2>

          <PrintGroup legend="Version">
            <RadioChoice<PrintVersion>
              name="print-version"
              options={[
                ["document", "Document"],
                ["markdown", "Markdown"],
              ]}
              value={view.documentRendered ? s.printVersion : "markdown"}
              disabled={view.documentRendered ? [] : ["document"]}
              onChange={(printVersion) => onUpdate({ printVersion })}
            />
            <p className="print-ws-hint m-0 mt-1.5 text-ink-soft">
              {!view.documentRendered
                ? "md-easy can't show this document in the Document view, so it prints the Markdown source."
                : s.printVersion === "document"
                  ? "The formatted document, as the editor renders it."
                  : "The raw Markdown source, in a monospace face."}
            </p>
          </PrintGroup>

          <PrintGroup legend="Printer">
            <FormGrid>
              {view.electron ? (
                <FormRow label="Printer:" htmlFor={`${ids}printer`}>
                  <Select
                    id={`${ids}printer`}
                    aria-label="Printer"
                    className="w-full min-w-0"
                    value={s.printerName}
                    onChange={(event) => onUpdate({ printerName: event.currentTarget.value }, false)}
                  >
                    <Options options={printerOptions} />
                  </Select>
                </FormRow>
              ) : (
                <FormRow label="Printer:">
                  <span className="print-ws-note text-ink-soft">System dialog</span>
                </FormRow>
              )}
              <FormRow label="Copies:" htmlFor={`${ids}copies`}>
                <NumberField
                  id={`${ids}copies`}
                  name="Copies"
                  value={s.printCopies}
                  min={1}
                  max={99}
                  onChange={(printCopies) => onUpdate({ printCopies }, false)}
                />
              </FormRow>
              <FormRow label="Pages:" htmlFor={`${ids}pages`}>
                <div className="flex min-w-0 gap-1.5">
                  <Select
                    id={`${ids}pages`}
                    aria-label="Pages"
                    className={cn("min-w-0", view.pageMode === "custom" ? "w-[104px]" : "w-full")}
                    value={view.pageMode}
                    onChange={(event) =>
                      onPageModeChange(event.currentTarget.value === "custom" ? "custom" : "all")
                    }
                  >
                    <option value="all">All</option>
                    <option value="custom">Custom</option>
                  </Select>
                  {view.pageMode === "custom" && (
                    <PageRangeField
                      value={view.pageRange}
                      error={view.rangeError ? `${ids}range-error` : undefined}
                      onChange={onPageRangeChange}
                    />
                  )}
                </div>
              </FormRow>
              {view.rangeError && (
                <p id={`${ids}range-error`} role="alert" className="print-ws-range-error col-start-2 m-0 text-ink-danger">
                  {view.rangeError}
                </p>
              )}
            </FormGrid>
          </PrintGroup>

          <PrintGroup legend="Page">
            <FormGrid>
              <FormRow label="Paper size:" htmlFor={`${ids}paper`}>
                <Select
                  id={`${ids}paper`}
                  aria-label="Paper size"
                  className="w-full min-w-0"
                  value={s.printPaperSize}
                  onChange={(event) =>
                    onUpdate({ printPaperSize: event.currentTarget.value as PaperSize })
                  }
                >
                  <Options
                    options={(Object.keys(PAPER_SIZES) as PaperSize[]).map((paperSize) => [
                      paperSize,
                      PAPER_SIZES[paperSize].label,
                    ])}
                  />
                </Select>
              </FormRow>
              <FormRow label="Orientation:">
                <RadioChoice<Orientation>
                  name="print-orientation"
                  label="Orientation"
                  options={[
                    ["portrait", ORIENTATION_LABELS.portrait],
                    ["landscape", ORIENTATION_LABELS.landscape],
                  ]}
                  value={s.printOrientation}
                  onChange={(printOrientation) => onUpdate({ printOrientation })}
                />
              </FormRow>
              <FormRow label="Margins:" htmlFor={`${ids}margins`}>
                <Select
                  id={`${ids}margins`}
                  aria-label="Margins"
                  className="w-full min-w-0"
                  value={s.printMargins}
                  onChange={(event) =>
                    onUpdate({ printMargins: event.currentTarget.value as MarginPreset })
                  }
                >
                  <Options
                    options={(Object.keys(MARGIN_PRESETS) as MarginPreset[]).map((margins) => [
                      margins,
                      MARGIN_PRESETS[margins].label,
                    ])}
                  />
                </Select>
              </FormRow>
              <FormRow label="Scale:" htmlFor={`${ids}scale`}>
                <NumberField
                  id={`${ids}scale`}
                  name="Scale"
                  suffix="%"
                  value={s.printScalePercent}
                  min={50}
                  max={200}
                  onChange={(printScalePercent) => onUpdate({ printScalePercent })}
                />
              </FormRow>
            </FormGrid>
          </PrintGroup>

          <PrintGroup legend="Header and footer">
            <div className="flex flex-col gap-1">
              <CheckRow
                label="Document title in header"
                checked={s.printHeaderTitle}
                onChange={(printHeaderTitle) => onUpdate({ printHeaderTitle })}
              />
              <CheckRow
                label="Date in header"
                checked={s.printHeaderDate}
                onChange={(printHeaderDate) => onUpdate({ printHeaderDate })}
              />
              <CheckRow
                label="Page numbers in footer"
                checked={s.printFooterPageNumbers}
                onChange={(printFooterPageNumbers) => onUpdate({ printFooterPageNumbers })}
              />
            </div>
          </PrintGroup>
        </div>

        <div aria-hidden="true" className="mx-[7px] w-px shrink-0 bg-line" />

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h3 className="m-0 px-2 pt-[7px] pb-1 text-[12px] font-bold leading-[18px] text-ink">Preview</h3>
          {/* The sheets keep the body's inherited type, so nothing here sets a
              font or line height. Sized and scaled by PrintWorkspace.fitPreview. */}
          <div
            ref={setCanvas}
            className="print-ws-canvas flex min-h-0 flex-1 overflow-auto bg-well p-5"
          >
            {/* Auto margins centre a sheet that fits and fall back to the top
                when the stack overflows, so its start never scrolls out of reach.
                The clip keeps a freshly rendered, not yet scaled stack from
                adding scroll bars while fitPreview measures the pane; its margin
                leaves room for the 1px sheet edge. */}
            <div
              ref={setScaler}
              className="print-ws-scaler m-auto flex-none overflow-clip [overflow-clip-margin:2px]"
            />
          </div>
          <p className="print-ws-paper m-0 leading-[18px] text-ink">
            {describePaper(s)}
            {view.summary && <span className="print-ws-summary"> · {view.summary}</span>}
          </p>
        </div>
      </div>

      <div className="print-ws-footer flex items-center gap-1.5 border-t border-separator px-[11px] py-2.5 leading-[18px]">
        <Button
          type="button"
          variant="outline"
          className="dialog-btn"
          disabled={Boolean(view.rangeError)}
          onClick={onSaveAsPdf}
        >
          Save as PDF
        </Button>
        <span className="print-ws-status ml-2 min-w-0 truncate text-ink-soft" aria-live="polite">
          {view.status}
        </span>
        <Button
          type="button"
          variant="outline"
          className="dialog-btn print-ws-cancel ml-auto"
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          type="button"
          className="dialog-btn primary"
          disabled={Boolean(view.rangeError)}
          onClick={onPrint}
        >
          Print
        </Button>
      </div>
    </div>
  );
}

/** A Mervin group box: a rounded frame whose sentence-case legend cuts the top
 *  border. Content sits 22px inside the frame on every side but the bottom (20px). */
function PrintGroup({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="m-0 min-w-0 shrink-0 rounded-lg border border-line p-0">
      <legend className="ml-[9px] px-1 text-ink-soft">{legend}</legend>
      <div className="px-[21px] pb-[19px] pt-3">{children}</div>
    </fieldset>
  );
}

/** Two-column form: "Label:" on the left, the field filling the rest. */
function FormGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-1.5">
      {children}
    </div>
  );
}

/** The widest label in the workspace. Every label cell also holds it invisibly,
 *  so the label columns of separate groups line up whatever the UI font, as in
 *  Mervin's forms. */
const LABEL_SIZER = "Orientation:";

function FormRow({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <>
      <div className="grid">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="col-start-1 row-start-1">
            {label}
          </label>
        ) : (
          <span className="col-start-1 row-start-1">{label}</span>
        )}
        <span aria-hidden="true" className="invisible col-start-1 row-start-1">
          {LABEL_SIZER}
        </span>
      </div>
      {children}
    </>
  );
}

function Options<T extends string>({ options }: { options: ReadonlyArray<readonly [T, string]> }) {
  return options.map(([option, label]) => (
    <option key={option} value={option}>
      {label}
    </option>
  ));
}

/** A row of radio buttons. Pass `label` to make it a named radio group; leave it
 *  out when the group box's legend already names the choice. */
function RadioChoice<T extends string>({
  name,
  label,
  options,
  value,
  disabled = [],
  onChange,
}: {
  name: string;
  label?: string;
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
  /** Options shown but not available. */
  disabled?: readonly T[];
  onChange(value: T): void;
}) {
  return (
    <div
      role={label ? "radiogroup" : undefined}
      aria-label={label}
      className="flex flex-wrap items-center gap-x-2 gap-y-1"
    >
      {options.map(([option, text]) => (
        <label
          key={option}
          className="flex cursor-pointer items-center gap-1.5 has-[:disabled]:cursor-default has-[:disabled]:text-ink-disabled"
        >
          <input
            type="radio"
            className="md-radio"
            name={name}
            value={option}
            checked={option === value}
            disabled={disabled.includes(option)}
            onChange={() => onChange(option)}
          />
          {text}
        </label>
      ))}
    </div>
  );
}

function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <label className="flex w-fit cursor-pointer items-center gap-1.5">
      <Checkbox checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      {label}
    </label>
  );
}

/**
 * A number field drawn as Mervin's spin box: the field well with an 18px
 * stepper column. Typing commits on blur or Enter and clamps to the range; the
 * steppers commit at once. They stay out of the tab order (the arrow keys step
 * the focused field) and keep focus on the field when clicked. `suffix` is
 * drawn right after the digits, as in Mervin's "100 %".
 */
function NumberField({
  id,
  name,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  id: string;
  name: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange(value: number): void;
}) {
  const [draft, setDraft] = useState(String(value));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(String(value)), [value]);

  const commit = (raw: string): void => {
    const parsed = Number(raw);
    const next = Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : value;
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  const step = (delta: number): void => {
    const current = Number(draft);
    commit(String(Math.round(Number.isFinite(current) ? current : value) + delta));
  };

  const current = Number(draft);
  const stepper = (delta: number, disabled: boolean): ReactNode => {
    const Icon = delta > 0 ? ChevronUp : ChevronDown;
    return (
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        className={cn(
          "flex flex-1 cursor-pointer items-center justify-center text-ink-body hover:bg-hover",
          "active:bg-pressed disabled:cursor-default disabled:bg-transparent disabled:text-ink-disabled",
          delta > 0 && "border-b border-line",
        )}
        onMouseDown={(event) => {
          event.preventDefault();
          input.current?.focus();
        }}
        onClick={() => step(delta)}
      >
        <Icon size={12} absoluteStrokeWidth strokeWidth={1.25} />
      </button>
    );
  };

  return (
    <div
      className={cn(
        fieldClassName,
        "relative flex w-full min-w-0 overflow-hidden px-0 focus-within:border-accent",
      )}
    >
      <input
        ref={input}
        id={id}
        aria-label={name}
        type="number"
        value={draft}
        min={min}
        max={max}
        className={cn(
          "min-w-0 flex-1 bg-transparent px-2 tabular-nums text-ink-primary outline-none",
          "selection:bg-accent selection:text-accent-fg",
          "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
        )}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={(event) => commit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {suffix && draft && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 -translate-y-1/2 tabular-nums text-ink-primary"
          style={{ left: `calc(8px + ${draft.length}ch + 0.3em)` }}
        >
          {suffix}
        </span>
      )}
      <div className="flex w-[18px] shrink-0 flex-col border-l border-line">
        {stepper(1, Number.isFinite(current) && current >= max)}
        {stepper(-1, Number.isFinite(current) && current <= min)}
      </div>
    </div>
  );
}

/** The custom page range ("1-3, 5"), shown next to Pages once Custom is chosen.
 *  `error` is the id of the message explaining why the range cannot print. */
function PageRangeField({
  value,
  error,
  onChange,
}: {
  value: string;
  error?: string;
  onChange(value: string): void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      type="text"
      aria-label="Page range"
      aria-invalid={error ? true : undefined}
      aria-describedby={error}
      className={cn(
        fieldClassName,
        "print-ws-range w-auto min-w-0 flex-1",
        error && "border-ink-danger focus:border-ink-danger",
      )}
      value={draft}
      placeholder="1-3, 5"
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={(event) => onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}
