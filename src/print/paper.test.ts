import { describe, it, expect } from "vitest";
import { clampScale, describeSetup, pageGeometry, type PageSetup } from "./paper";

const A4_PORTRAIT: PageSetup = {
  paperSize: "a4",
  orientation: "portrait",
  margins: "normal",
  scale: 1,
  header: true,
  footer: true,
};

/** mm → CSS px at the 96 dpi reference the layout uses. */
const px = (mm: number): number => (mm / 25.4) * 96;

describe("pageGeometry", () => {
  it("sizes an A4 portrait sheet and its content box", () => {
    const g = pageGeometry(A4_PORTRAIT);
    expect(g.widthPx).toBeCloseTo(px(210), 3);
    expect(g.heightPx).toBeCloseTo(px(297), 3);
    expect(g.widthIn).toBeCloseTo(210 / 25.4, 5);
    // Content is the sheet minus both margins, and minus the running bands.
    expect(g.contentWidthPx).toBeCloseTo(px(210 - 40), 3);
    expect(g.contentHeightPx).toBeCloseTo(px(297 - 40 - 10 - 8), 3);
    expect(g.contentTopPx).toBeCloseTo(px(20 + 10), 3);
  });

  it("gives the content the header/footer space back when the bands are off", () => {
    const g = pageGeometry({ ...A4_PORTRAIT, header: false, footer: false });
    expect(g.contentHeightPx).toBeCloseTo(px(297 - 40), 3);
    expect(g.contentTopPx).toBeCloseTo(px(20), 3);
    expect(g.headerBandPx).toBe(0);
    expect(g.footerBandPx).toBe(0);
  });

  it("swaps the sheet dimensions in landscape", () => {
    const g = pageGeometry({ ...A4_PORTRAIT, orientation: "landscape" });
    expect(g.widthPx).toBeCloseTo(px(297), 3);
    expect(g.heightPx).toBeCloseTo(px(210), 3);
  });

  it("honors the margin preset", () => {
    const narrow = pageGeometry({ ...A4_PORTRAIT, margins: "narrow" });
    const none = pageGeometry({ ...A4_PORTRAIT, margins: "none" });
    expect(narrow.contentWidthPx).toBeCloseTo(px(210 - 20), 3);
    expect(none.contentWidthPx).toBeCloseTo(px(210), 3);
    expect(none.marginPx).toBe(0);
  });

  it("lays out into a proportionally larger box when scaling down", () => {
    const half = pageGeometry({ ...A4_PORTRAIT, scale: 0.5 });
    // Half-size text means twice as much fits, so the flow is measured at 2×
    // and then transform-scaled back onto the same content box.
    expect(half.layoutWidthPx).toBeCloseTo(half.contentWidthPx * 2, 3);
    expect(half.layoutHeightPx).toBeCloseTo(half.contentHeightPx * 2, 3);
    expect(half.scale).toBe(0.5);
    // At 100% the layout box IS the content box (no transform at all).
    const full = pageGeometry(A4_PORTRAIT);
    expect(full.layoutWidthPx).toBeCloseTo(full.contentWidthPx, 6);
  });

  it("clamps a scale that would make the page unusable", () => {
    expect(pageGeometry({ ...A4_PORTRAIT, scale: 0.01 }).scale).toBe(0.5);
    expect(pageGeometry({ ...A4_PORTRAIT, scale: 40 }).scale).toBe(2);
  });
});

describe("clampScale", () => {
  it("passes usable values through", () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(0.75)).toBe(0.75);
  });

  it("rejects values outside the printable range", () => {
    expect(clampScale(0)).toBe(0.5);
    expect(clampScale(-3)).toBe(0.5);
    expect(clampScale(9)).toBe(2);
    expect(clampScale(Number.NaN)).toBe(1);
  });
});

describe("describeSetup", () => {
  it("summarizes the sheet without the dimension suffix", () => {
    expect(describeSetup(A4_PORTRAIT)).toBe("A4 portrait");
    expect(describeSetup({ ...A4_PORTRAIT, paperSize: "letter", orientation: "landscape" })).toBe(
      "Letter landscape",
    );
  });
});
