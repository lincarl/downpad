// Page geometry for the custom print path (spec §5.21). Everything downstream —
// the paginator, the preview sheets, and the native print settings — works from
// one `PageGeometry`, so the on-screen preview and the printed sheet can never
// disagree about how much room a page has.
//
// CSS pixels are the layout unit (96 px = 1 in, the CSS reference DPI that
// Chromium lays print pages out in); inches are carried alongside for Electron's
// native printer and PDF settings.

export type PaperSize = "a4" | "letter" | "legal" | "a5";
export type Orientation = "portrait" | "landscape";
export type MarginPreset = "normal" | "narrow" | "wide" | "none";
/** Which rendering of the document goes on the page (spec §5.21). */
export type PrintVersion = "document" | "markdown";

const MM_PER_INCH = 25.4;
const CSS_DPI = 96;

const mmToPx = (mm: number): number => (mm / MM_PER_INCH) * CSS_DPI;
const mmToIn = (mm: number): number => mm / MM_PER_INCH;

/** Portrait dimensions in millimetres; landscape swaps them. */
export const PAPER_SIZES: Record<PaperSize, { label: string; widthMm: number; heightMm: number }> = {
  a4: { label: "A4 (210 × 297 mm)", widthMm: 210, heightMm: 297 },
  letter: { label: "Letter (8.5 × 11 in)", widthMm: 215.9, heightMm: 279.4 },
  legal: { label: "Legal (8.5 × 14 in)", widthMm: 215.9, heightMm: 355.6 },
  a5: { label: "A5 (148 × 210 mm)", widthMm: 148, heightMm: 210 },
};

export const MARGIN_PRESETS: Record<MarginPreset, { label: string; mm: number }> = {
  normal: { label: "Normal · 20 mm", mm: 20 },
  narrow: { label: "Narrow · 10 mm", mm: 10 },
  wide: { label: "Wide · 30 mm", mm: 30 },
  none: { label: "None", mm: 0 },
};

/** Bands reserved inside the content box for the running header / footer. */
const HEADER_BAND_MM = 10;
const FOOTER_BAND_MM = 8;

/** The user-chosen page setup that produces a `PageGeometry`. */
export interface PageSetup {
  paperSize: PaperSize;
  orientation: Orientation;
  margins: MarginPreset;
  /** 0.5–2.0; shrinks or enlarges the document relative to the page. */
  scale: number;
  /** A running header band is reserved when either header field is shown. */
  header: boolean;
  footer: boolean;
}

export interface PageGeometry {
  /** Sheet size in CSS px (what a `.print-page` element is sized to). */
  widthPx: number;
  heightPx: number;
  /** Sheet size in inches, for the native print settings. */
  widthIn: number;
  heightIn: number;
  marginPx: number;
  /** Where the document flow starts/how tall it may be, inside the margins and
   *  below/above the running bands. */
  contentTopPx: number;
  contentHeightPx: number;
  contentWidthPx: number;
  headerBandPx: number;
  footerBandPx: number;
  /**
   * The document is laid out at `layoutWidth/HeightPx` and then transform-scaled
   * down onto the page, so `scale` changes how much text fits per page without
   * disturbing measurement (a transform doesn't affect layout, unlike `zoom`).
   */
  layoutWidthPx: number;
  layoutHeightPx: number;
  scale: number;
}

/** Clamp a user-entered scale to a range that still produces a usable page. */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(Math.max(scale, 0.5), 2);
}

export function pageGeometry(setup: PageSetup): PageGeometry {
  const paper = PAPER_SIZES[setup.paperSize] ?? PAPER_SIZES.a4;
  const landscape = setup.orientation === "landscape";
  const widthMm = landscape ? paper.heightMm : paper.widthMm;
  const heightMm = landscape ? paper.widthMm : paper.heightMm;
  const marginMm = (MARGIN_PRESETS[setup.margins] ?? MARGIN_PRESETS.normal).mm;
  const headerMm = setup.header ? HEADER_BAND_MM : 0;
  const footerMm = setup.footer ? FOOTER_BAND_MM : 0;
  const scale = clampScale(setup.scale);

  const contentWidthPx = mmToPx(widthMm - marginMm * 2);
  const contentHeightPx = mmToPx(heightMm - marginMm * 2 - headerMm - footerMm);
  return {
    widthPx: mmToPx(widthMm),
    heightPx: mmToPx(heightMm),
    widthIn: mmToIn(widthMm),
    heightIn: mmToIn(heightMm),
    marginPx: mmToPx(marginMm),
    contentTopPx: mmToPx(marginMm + headerMm),
    contentWidthPx,
    contentHeightPx,
    headerBandPx: mmToPx(headerMm),
    footerBandPx: mmToPx(footerMm),
    // Scaling down means laying out into a proportionally larger box, so the
    // scaled result lands exactly on the content box.
    layoutWidthPx: contentWidthPx / scale,
    layoutHeightPx: contentHeightPx / scale,
    scale,
  };
}

/** Human-readable summary shown in the print workspace header ("A4 portrait"). */
export function describeSetup(setup: PageSetup): string {
  const paper = PAPER_SIZES[setup.paperSize] ?? PAPER_SIZES.a4;
  const name = paper.label.replace(/\s*\(.*\)$/, "");
  return `${name} ${setup.orientation}`;
}
