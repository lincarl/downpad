// The print workspace (spec §5.21): a full-window print mode rather than a modal,
// with a scrolling multi-page preview on the left and the page/printer options on
// the right. It replaces both the old direct `window.print()` call and the
// WebView's own print dialog.
//
// The preview shows the very elements that get printed (printRender.ts) at a
// scaled-down size, so "what you see is the sheet". Changing any option
// re-paginates immediately.

import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { disposeReactRoot } from "@/app/disposeReactRoot";
import { isTauri } from "../ipc/env";
import { listPrinters, printWebview, printWebviewToPdf } from "../ipc/commands";
import { onPrintCompleted } from "../ipc/events";
import type { NativePrintOptions, PrinterInfo } from "../ipc/contracts";
import type { Settings } from "../state/types";
import { pageCount, renderPrintPages } from "./printRender";
import {
  MARGIN_PRESETS,
  PAPER_SIZES,
  clampScale,
  describeSetup,
  pageGeometry,
  type MarginPreset,
  type Orientation,
  type PageSetup,
  type PaperSize,
  type PrintVersion,
} from "./paper";

/** What is being printed. `documentNode` is a detached, already-sanitized clone. */
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

export class PrintWorkspace {
  private host: HTMLElement | null = null;
  private reactRoot: Root | null = null;
  private job: PrintJob | null = null;
  /** Working copy of the print settings; written back on close. */
  private settings: Settings | null = null;
  private printRoot: HTMLElement | null = null;
  private printers: PrinterInfo[] = [];
  private pageRange = "";
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

  private focusableElements(): HTMLElement[] {
    if (!this.host) return [];
    return Array.from(
      this.host.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
  }

  private focusWorkspace(): void {
    const first = this.focusableElements()[0];
    (first ?? this.host?.querySelector<HTMLElement>(".print-workspace"))?.focus({
      preventScroll: true,
    });
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
      pageRange: this.pageRange,
      summary: this.summaryText,
      status: this.statusText,
      tauri: isTauri(),
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
  private readonly setPageMode = (mode: "all" | "custom"): void => {
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
      version: s.printVersion,
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

  /** Scale the sheets down to fit the preview pane. A transform is used rather
   *  than `zoom` so the pages keep the exact layout they will print with. */
  private fitPreview(): void {
    const root = this.printRoot;
    const scaler = this.scaler;
    const canvas = this.canvas;
    if (!root || !scaler || !canvas) return;
    root.style.transform = "";
    scaler.style.width = "";
    scaler.style.height = "";
    const available = canvas.clientWidth - 48;
    const naturalWidth = root.offsetWidth;
    const naturalHeight = root.offsetHeight;
    if (!naturalWidth || available <= 0) return;
    const scale = Math.min(1, Math.max(0.15, available / naturalWidth));
    root.style.transformOrigin = "top left";
    root.style.transform = `scale(${scale})`;
    scaler.style.width = `${naturalWidth * scale}px`;
    scaler.style.height = `${naturalHeight * scale}px`;
  }

  private updateSummary(): void {
    const pages = this.printRoot ? pageCount(this.printRoot) : 0;
    const printer = this.settings!.printerName || "system default";
    this.summaryText = `${this.job!.docTitle} · ${pages} ${
      pages === 1 ? "page" : "pages"
    } · ${describeSetup(this.setup())} · ${printer}`;
    this.publish();
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
      pageRanges: this.pageRange,
    };
  }

  private async print(): Promise<void> {
    await this.withPrintDom(async () => {
      if (!isTauri()) {
        // Browser dev builds have no backend: fall back to the browser dialog.
        await this.runBrowserPrint();
        return;
      }
      try {
        await this.runNative(() => printWebview(this.nativeOptions()), "Printing…");
      } catch (err) {
        // The backend print path is unavailable (older WebView2 runtime, or the
        // command failed to start). Printing the sheets through the browser
        // dialog still produces the right pages — it just shows one more dialog.
        console.error("md-easy: native print unavailable, using the browser dialog", err);
        if (this.host) await this.runBrowserPrint();
      }
    });
  }

  private async saveAsPdf(): Promise<void> {
    if (!isTauri()) {
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
   *  listener has to be in place before the job starts — Tauri events aren't
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
    if (!isTauri()) return;
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

interface PrintWorkspaceSnapshot {
  settings: Settings;
  printers: readonly PrinterInfo[];
  pageRange: string;
  summary: string;
  status: string;
  tauri: boolean;
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
  onPageModeChange(mode: "all" | "custom"): void;
  onPageRangeChange(range: string): void;
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
  const printerOptions: Array<readonly [string, string]> = [["", "System default"]];
  for (const printer of view.printers) {
    printerOptions.push([
      printer.name,
      printer.isDefault ? `${printer.name} (default)` : printer.name,
    ]);
  }

  return (
    <div
      className="print-workspace"
      role="dialog"
      aria-label="Print"
      aria-modal="true"
      tabIndex={-1}
    >
      <div className="print-ws-top">
        <Button type="button" variant="outline" className="dialog-btn" onClick={onClose}>
          ‹ Back
        </Button>
        <span className="print-ws-title">Print</span>
        <span className="print-ws-summary">{view.summary}</span>
        <span className="print-ws-spacer" />
        <span className="print-ws-status" aria-live="polite">
          {view.status}
        </span>
        <Button type="button" variant="outline" className="dialog-btn" onClick={onSaveAsPdf}>
          Save as PDF
        </Button>
        <Button type="button" className="dialog-btn primary" onClick={onPrint}>
          Print
        </Button>
      </div>

      <div ref={setCanvas} className="print-ws-canvas">
        <div ref={setScaler} className="print-ws-scaler" />
      </div>

      <div className="print-ws-rail">
        <PrintSection heading="Version">
          <PrintRow label="Print the">
            <SegmentedControl<PrintVersion>
              name="Version"
              options={[
                ["document", "Document"],
                ["markdown", "Markdown"],
              ]}
              value={s.printVersion}
              onChange={(printVersion) => onUpdate({ printVersion })}
            />
          </PrintRow>
          <p className="print-ws-hint">
            {s.printVersion === "document"
              ? "The formatted document, exactly as the editor renders it."
              : "The raw Markdown source, in a monospace face."}
          </p>
        </PrintSection>

        <PrintSection heading="Printer">
          <PrintRow label="Printer">
            {view.tauri ? (
              <SelectControl
                name="Printer"
                options={printerOptions}
                value={s.printerName}
                onChange={(printerName) => onUpdate({ printerName }, false)}
              />
            ) : (
              <span className="print-ws-note">System dialog</span>
            )}
          </PrintRow>
          <PrintRow label="Copies">
            <NumberControl
              name="Copies"
              value={s.printCopies}
              min={1}
              max={99}
              onChange={(printCopies) => onUpdate({ printCopies }, false)}
            />
          </PrintRow>
          <PrintRow label="Pages">
            <div className="print-ws-pages">
              <SelectControl
                name="Pages"
                options={[
                  ["all", "All"],
                  ["custom", "Custom…"],
                ]}
                value={view.pageRange ? "custom" : "all"}
                onChange={onPageModeChange}
              />
              {view.pageRange && (
                <PageRangeControl value={view.pageRange} onChange={onPageRangeChange} />
              )}
            </div>
          </PrintRow>
        </PrintSection>

        <PrintSection heading="Page">
          <PrintRow label="Paper size">
            <SelectControl<PaperSize>
              name="Paper size"
              options={(Object.keys(PAPER_SIZES) as PaperSize[]).map((paperSize) => [
                paperSize,
                PAPER_SIZES[paperSize].label,
              ])}
              value={s.printPaperSize}
              onChange={(printPaperSize) => onUpdate({ printPaperSize })}
            />
          </PrintRow>
          <PrintRow label="Orientation">
            <SelectControl<Orientation>
              name="Orientation"
              options={[
                ["portrait", "Portrait"],
                ["landscape", "Landscape"],
              ]}
              value={s.printOrientation}
              onChange={(printOrientation) => onUpdate({ printOrientation })}
            />
          </PrintRow>
          <PrintRow label="Margins">
            <SelectControl<MarginPreset>
              name="Margins"
              options={(Object.keys(MARGIN_PRESETS) as MarginPreset[]).map((margins) => [
                margins,
                MARGIN_PRESETS[margins].label,
              ])}
              value={s.printMargins}
              onChange={(printMargins) => onUpdate({ printMargins })}
            />
          </PrintRow>
          <PrintRow label="Scale (%)">
            <NumberControl
              name="Scale"
              value={s.printScalePercent}
              min={50}
              max={200}
              onChange={(printScalePercent) => onUpdate({ printScalePercent })}
            />
          </PrintRow>
        </PrintSection>

        <PrintSection heading="Header & footer">
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
        </PrintSection>
      </div>
    </div>
  );
}

function PrintSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="dialog-section">
      <h3 className="dialog-section-title">{heading}</h3>
      {children}
    </section>
  );
}

function PrintRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="dialog-row">
      <span>{label}</span>
      {children}
    </label>
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
    <PrintRow label={label}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </PrintRow>
  );
}

function SelectControl<T extends string>({
  name,
  options,
  value,
  onChange,
}: {
  name: string;
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange(value: T): void;
}) {
  return (
    <select
      aria-label={name}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value as T)}
    >
      {options.map(([option, label]) => (
        <option key={option} value={option}>
          {label}
        </option>
      ))}
    </select>
  );
}

function NumberControl({
  name,
  value,
  min,
  max,
  onChange,
}: {
  name: string;
  value: number;
  min: number;
  max: number;
  onChange(value: number): void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = (raw: string): void => {
    const parsed = Number(raw);
    const next = Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : value;
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <input
      aria-label={name}
      type="number"
      value={draft}
      min={min}
      max={max}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={(event) => commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

function PageRangeControl({
  value,
  onChange,
}: {
  value: string;
  onChange(value: string): void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      type="text"
      className="print-ws-range"
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

/** The Document | Markdown chooser: a joined two-segment pill. */
function SegmentedControl<T extends string>({
  name,
  options,
  value,
  onChange,
}: {
  name: string;
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange(value: T): void;
}) {
  return (
    <div className="print-ws-segmented" role="group" aria-label={name}>
      {options.map(([option, label]) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          className={option === value ? "active" : undefined}
          onClick={() => onChange(option)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
