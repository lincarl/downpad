// Inline SVG drawings for the theme cards in Settings, after Mervin's
// UiThemePicker and DocumentThemePicker. Each preview paints its own scheme
// from themePalettes.ts, not from the live CSS variables, so the Light card
// looks light while the app is dark.

import { useId } from "react";

import type { Settings } from "@/state/types";
import {
  DOCUMENT_PALETTES,
  UI_PALETTES,
  documentScheme,
  type DocumentPalette,
  type Scheme,
  type UiPalette,
} from "./themePalettes";

/** The photo on every sample page: a sky with two hills. */
const SKY = "#8cc5df";
const SUN = "#ffdc91";
const FAR_HILL = "#67978f";
const NEAR_HILL = "#39716a";

/** Text on the sample pages is drawn as bars in the page ink, softened so the
 *  bars read as text rather than rules. */
const HEADING_OPACITY = 0.85;
const LINE_OPACITY = 0.6;

/** The miniature window's size in its own units. */
const WINDOW_W = 112;
const WINDOW_H = 78;

/** Follow system and Follow UI theme show light right of a slant from 62% of
 *  the width at the top to 38% at the bottom, as Mervin's Follow system card. */
function slantPoints(width: number, height: number): string {
  return `${width * 0.62},-1 ${width + 1},-1 ${width + 1},${height + 1} ${width * 0.38},${height + 1}`;
}

/** Hill peaks and feet as fractions of the photo rectangle: Mervin's window
 *  preview has a wide, low photo and its sample page a taller one. */
type Hills = { far: readonly number[]; near: readonly number[] };
const WINDOW_HILLS: Hills = { far: [0.294, 0.676, 1.118, 0.231], near: [-0.118, 0.265, 0.647, 0.385] };
const PAGE_HILLS: Hills = { far: [0.278, 0.741, 1.204, 0.281], near: [-0.167, 0.315, 0.796, 0.344] };

/** A photo inside `x, y, w, h`: sky, an optional sun, a far and a near hill,
 *  clipped to the rectangle by the clip path `clip`. */
function Photo({ x, y, w, h, clip, hills, sun }: { x: number; y: number; w: number; h: number; clip: string; hills: Hills; sun?: boolean }) {
  const hill = ([left, peak, right, top]: readonly number[]) =>
    `${x + left * w},${y + h} ${x + peak * w},${y + top * h} ${x + right * w},${y + h}`;
  return (
    <g clipPath={`url(#${clip})`}>
      <rect x={x} y={y} width={w} height={h} fill={SKY} />
      {sun && <circle cx={x + 0.787 * w} cy={y + 0.266 * h} r={0.065 * w} fill={SUN} />}
      <polygon points={hill(hills.far)} fill={FAR_HILL} />
      <polygon points={hill(hills.near)} fill={NEAR_HILL} />
    </g>
  );
}

/** Downpad's window in one scheme, in window units: the toolbar, the tab row
 *  with Recent and an active tab, the document page on the canvas, and the
 *  status bar. The active tab label carries the accent. The page photo is
 *  drawn by the caller, once, so a split preview shows no seam across it. */
function MiniWindow({ c, page, accent, outline }: { c: UiPalette; page: DocumentPalette; accent: string; outline: string }) {
  return (
    <g>
      <g clipPath={`url(#${outline})`}>
        <rect width={WINDOW_W} height={13} fill={c.window} />
        {[5, 12, 19, 30, 37, 44, 55, 62].map((x) => (
          <rect key={x} x={x} y={4.5} width={4} height={4} rx={1} fill={c.inkSoft} />
        ))}

        <rect y={13} width={WINDOW_W} height={10} fill={c.bar} />
        <rect x={4.5} y={15.5} width={12} height={6} rx={1.5} fill="none" stroke={c.lineStrong} strokeWidth={0.6} />
        <rect x={21} y={14.5} width={27} height={8.5} fill={c.fill} />
        <rect x={25} y={18} width={15} height={1.6} fill={accent} />
        <rect x={53} y={18} width={13} height={1.6} fill={c.inkSoft} />
        <rect x={72} y={18} width={13} height={1.6} fill={c.inkSoft} />

        <rect y={23} width={WINDOW_W} height={50} fill={c.canvas} />
        <rect y={22.6} width={WINDOW_W} height={0.8} fill={c.separator} />

        <rect x={26} y={27} width={60} height={52} fill={page.paper} />
        <rect x={33} y={32} width={20} height={2.4} fill={page.ink} fillOpacity={HEADING_OPACITY} />
        <g fill={page.ink} fillOpacity={LINE_OPACITY}>
          <rect x={33} y={37.5} width={46} height={1.3} />
          <rect x={33} y={41} width={38} height={1.3} />
          <rect x={33} y={44.5} width={46} height={1.3} />
          <rect x={33} y={66} width={46} height={1.3} />
        </g>

        <rect y={73} width={WINDOW_W} height={5} fill={c.status} />
        <rect x={4} y={75} width={22} height={1.2} fill={c.inkFaint} />
        <rect x={92} y={75} width={16} height={1.2} fill={c.inkFaint} />
      </g>
      <rect x={0.4} y={0.4} width={WINDOW_W - 0.8} height={WINDOW_H - 0.8} rx={3} fill="none" stroke={c.lineStrong} strokeWidth={0.8} />
    </g>
  );
}

export interface UiThemePreviewProps {
  /** The previewed UI theme; "system" splits dark and light on a slant. */
  theme: Settings["theme"];
  /** The staged document theme, so the page shows the colours it will have. */
  documentTheme: Settings["editorTheme"];
  /** The accent each scheme shows: the custom accent, or the scheme's own. */
  accentFor: (scheme: Scheme) => string;
}

/** A miniature Downpad window in the previewed scheme, 129x90 at full size. */
export function UiThemePreview({ theme, documentTheme, accentFor }: UiThemePreviewProps) {
  const id = useId();
  const outline = `${id}outline`;
  const photo = `${id}photo`;
  const slant = `${id}slant`;
  const drawWindow = (scheme: Scheme) => (
    <MiniWindow
      c={UI_PALETTES[scheme]}
      page={DOCUMENT_PALETTES[documentScheme(documentTheme, scheme)]}
      accent={accentFor(scheme)}
      outline={outline}
    />
  );
  return (
    <svg
      viewBox={`0 0 ${WINDOW_W} ${WINDOW_H}`}
      className="block h-auto w-[min(129px,calc(100%-16px))]"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={outline}>
          <rect x={0.4} y={0.4} width={WINDOW_W - 0.8} height={WINDOW_H - 0.8} rx={3} />
        </clipPath>
        <clipPath id={photo}>
          <rect x={33} y={49} width={46} height={13} />
        </clipPath>
        <clipPath id={slant}>
          <polygon points={slantPoints(WINDOW_W, WINDOW_H)} />
        </clipPath>
      </defs>
      {drawWindow(theme === "light" ? "light" : "dark")}
      {theme === "system" && <g clipPath={`url(#${slant})`}>{drawWindow("light")}</g>}
      <Photo x={33} y={49} w={46} h={13} clip={photo} hills={WINDOW_HILLS} />
    </svg>
  );
}

/** The sample page's size in its own units. */
const PAGE_W = 72;
const PAGE_H = 101;

/** One sample page in a document scheme, in page units, without its photo. */
function SamplePage({ p }: { p: DocumentPalette }) {
  return (
    <g>
      <rect x={0.35} y={0.35} width={PAGE_W - 0.7} height={PAGE_H - 0.7} fill={p.paper} stroke={p.edge} strokeWidth={0.7} />
      <rect x={9} y={10} width={34} height={4} fill={p.ink} fillOpacity={HEADING_OPACITY} />
      <g fill={p.ink} fillOpacity={LINE_OPACITY}>
        <rect x={9} y={20} width={54} height={2} />
        <rect x={9} y={26} width={35} height={2} />
        <rect x={9} y={76} width={54} height={2} />
        <rect x={9} y={82} width={44} height={2} />
      </g>
    </g>
  );
}

/** A sample page in Downpad's document colours, 72x101. "follow-ui" splits the
 *  dark and light page on a slant. */
export function DocumentThemePreview({ theme }: { theme: Settings["editorTheme"] }) {
  const id = useId();
  const photo = `${id}photo`;
  const slant = `${id}slant`;
  return (
    <svg
      viewBox={`0 0 ${PAGE_W} ${PAGE_H}`}
      width={PAGE_W}
      height={PAGE_H}
      className="block"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={photo}>
          <rect x={9} y={35} width={54} height={32} />
        </clipPath>
        <clipPath id={slant}>
          <polygon points={slantPoints(PAGE_W, PAGE_H)} />
        </clipPath>
      </defs>
      <SamplePage p={DOCUMENT_PALETTES[theme === "light" ? "light" : "dark"]} />
      {theme === "follow-ui" && (
        <g clipPath={`url(#${slant})`}>
          <SamplePage p={DOCUMENT_PALETTES.light} />
        </g>
      )}
      <Photo x={9} y={35} w={54} h={32} clip={photo} hills={PAGE_HILLS} sun />
    </svg>
  );
}
