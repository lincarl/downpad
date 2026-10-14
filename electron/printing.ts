import type { BrowserWindow, PageRanges, PrintToPDFOptions, WebContentsPrintOptions } from "electron";
import type { NativePrintOptions, PrintCompleted } from "../src/ipc/contracts";
import { absolutePath, writeAtomic } from "./io";

export function pageRanges(value: string): PageRanges[] {
  if (!value.trim()) return [];
  return value.split(",").map((part) => {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    if (!match) throw new Error("Use page ranges such as 1-3,5.");
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to > 1_000_000) {
      throw new Error("The page range is invalid.");
    }
    return { from: from - 1, to: to - 1 };
  });
}

export function validatePrintOptions(value: unknown): NativePrintOptions {
  if (!value || typeof value !== "object") throw new Error("Print options are required.");
  const options = value as Record<string, unknown>;
  if (typeof options.printerName !== "string" || typeof options.pageRanges !== "string" ||
    (options.orientation !== "portrait" && options.orientation !== "landscape") ||
    typeof options.copies !== "number" || !Number.isInteger(options.copies) || options.copies < 1 || options.copies > 999 ||
    typeof options.pageWidthIn !== "number" || !Number.isFinite(options.pageWidthIn) || options.pageWidthIn < 1 || options.pageWidthIn > 100 ||
    typeof options.pageHeightIn !== "number" || !Number.isFinite(options.pageHeightIn) || options.pageHeightIn < 1 || options.pageHeightIn > 100) {
    throw new Error("The print options are invalid.");
  }
  pageRanges(options.pageRanges);
  return {
    printerName: options.printerName, copies: options.copies, orientation: options.orientation,
    pageWidthIn: options.pageWidthIn, pageHeightIn: options.pageHeightIn, pageRanges: options.pageRanges,
  };
}

export function printerOptions(options: NativePrintOptions): WebContentsPrintOptions {
  return {
    silent: true,
    printBackground: true,
    deviceName: options.printerName,
    copies: options.copies,
    landscape: options.orientation === "landscape",
    margins: { marginType: "none" },
    scaleFactor: 100,
    header: "",
    footer: "",
    pageRanges: pageRanges(options.pageRanges),
    // Electron's printer API uses micrometres and rotates the portrait sheet.
    pageSize: {
      width: Math.round(Math.min(options.pageWidthIn, options.pageHeightIn) * 25_400),
      height: Math.round(Math.max(options.pageWidthIn, options.pageHeightIn) * 25_400),
    },
  };
}

export function pdfOptions(options: NativePrintOptions): PrintToPDFOptions {
  return {
    printBackground: true,
    displayHeaderFooter: false,
    landscape: options.orientation === "landscape",
    scale: 1,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    pageRanges: options.pageRanges,
    preferCSSPageSize: false,
    // PDF sizes use inches, unlike the printer API.
    pageSize: {
      width: Math.min(options.pageWidthIn, options.pageHeightIn),
      height: Math.max(options.pageWidthIn, options.pageHeightIn),
    },
  };
}

/** Keep the print DOM in place until Chromium finishes fonts and image loading. */
async function waitForAssets(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(`(async () => {
    const root = document.querySelector('body > .print-root');
    if (!root) throw new Error('Open the print workspace before printing.');
    const loaded = Promise.all(Array.from(root.querySelectorAll('img'), image => {
      if (image.complete) return Promise.resolve();
      return new Promise(resolve => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      });
    }));
    let timer;
    try {
      await Promise.race([
        Promise.all([document.fonts.ready, loaded]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Print images did not finish loading.')), 30000); })
      ]);
    } finally { clearTimeout(timer); }
  })()`);
}

export class PrintService {
  private busy = false;

  constructor(private readonly window: BrowserWindow, private readonly completed: (result: PrintCompleted) => void) {}

  start(options: NativePrintOptions, pdfPath?: string): void {
    if (this.busy) throw new Error("A print job is already running.");
    if (pdfPath) absolutePath(pdfPath);
    this.busy = true;
    void this.run(options, pdfPath).then(
      () => this.completed({ ok: true }),
      (error: unknown) => this.completed({ ok: false, message: error instanceof Error ? error.message : String(error) }),
    ).finally(() => { this.busy = false; });
  }

  private async run(options: NativePrintOptions, pdfPath?: string): Promise<void> {
    await waitForAssets(this.window);
    if (pdfPath) {
      const bytes = await this.window.webContents.printToPDF(pdfOptions(options));
      await writeAtomic(pdfPath, bytes);
      return;
    }
    if (process.platform === "darwin" && pageRanges(options.pageRanges).length > 1) {
      throw new Error("macOS supports one continuous page range per print job.");
    }
    await new Promise<void>((resolve, reject) => {
      this.window.webContents.print(printerOptions(options), (ok, reason) => {
        if (ok) resolve(); else reject(new Error(reason || "The printer rejected the job."));
      });
    });
  }
}
