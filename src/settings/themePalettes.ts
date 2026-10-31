// Colour values for the theme previews in Settings. A preview shows its own
// scheme whichever scheme the app uses now, so it cannot read the live CSS
// variables. These mirror the tokens in styles/app.css (`:root` for light,
// `[data-theme="dark"]` for dark, and the `--editor-surface-*` pair) and must
// change with them.

import type { Settings } from "@/state/types";

export type Scheme = "dark" | "light";

/** The chrome tokens a miniature Downpad window draws with. */
export interface UiPalette {
  window: string;
  bar: string;
  fill: string;
  status: string;
  canvas: string;
  inkSoft: string;
  inkFaint: string;
  separator: string;
  line: string;
  lineStrong: string;
  /** The scheme's default accent, used when no custom accent is chosen. */
  accent: string;
}

export const UI_PALETTES: Record<Scheme, UiPalette> = {
  dark: {
    window: "#2e3440",
    bar: "#2a303b",
    fill: "#353c4a",
    status: "#272c36",
    canvas: "#424853",
    inkSoft: "#a5afc1",
    inkFaint: "#98a2b4",
    separator: "rgb(236 239 244 / 8%)",
    line: "rgb(236 239 244 / 11%)",
    lineStrong: "rgb(236 239 244 / 25%)",
    accent: "#88c0d0",
  },
  light: {
    window: "#f5f7f9",
    bar: "#e8ecf0",
    fill: "#ffffff",
    status: "#dee3e9",
    canvas: "#3c3f44",
    inkSoft: "#59636e",
    inkFaint: "#58616b",
    separator: "rgb(31 42 55 / 12%)",
    line: "rgb(31 42 55 / 16%)",
    lineStrong: "rgb(31 42 55 / 30%)",
    accent: "#0969da",
  },
};

/** The document surface: page fill, text colour, and the edge a preview draws
 *  so the page stays visible on a well of the same lightness. */
export interface DocumentPalette {
  paper: string;
  ink: string;
  edge: string;
}

export const DOCUMENT_PALETTES: Record<Scheme, DocumentPalette> = {
  light: { paper: "#ffffff", ink: "#1a1a1a", edge: "#202020" },
  dark: { paper: "#040404", ink: "#d4d4d4", edge: "#39414c" },
};

/** The scheme a UI theme setting shows now; "system" follows the OS as
 *  applyTheme does. */
export function resolveScheme(theme: Settings["theme"]): Scheme {
  if (theme !== "system") return theme;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The document scheme shown under a given UI scheme. */
export function documentScheme(editorTheme: Settings["editorTheme"], ui: Scheme): Scheme {
  return editorTheme === "follow-ui" ? ui : editorTheme;
}
