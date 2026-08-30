// Accent (highlight) color resolution (spec §6.2). The accent drives the active
// segmented-button background, the primary dialog button, selection highlights,
// etc. (CSS var `--accent`). It comes from one of three sources — the built-in
// blue, the Windows system accent, or a user-picked custom color — and we also
// derive a readable foreground (`--accent-fg`) so text stays legible on light or
// dark custom accents. These helpers are pure so they can be unit-tested; the
// store/IPC wiring lives in SettingsModel.

/** The built-in default accent — the blue md-easy shipped with. */
export const DEFAULT_ACCENT = "#0067c0";

/**
 * Normalize a color string to lowercase `#rrggbb`, accepting `#rgb`, `rgb`,
 * `#rrggbb`, and `rrggbb`. Returns null for anything that isn't a hex color, so
 * callers can fall back to the default rather than emit invalid CSS.
 */
export function normalizeHex(input: string | null | undefined): string | null {
  if (!input) return null;
  let h = input.trim().toLowerCase();
  if (h.startsWith("#")) h = h.slice(1);
  if (/^[0-9a-f]{3}$/.test(h)) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  return /^[0-9a-f]{6}$/.test(h) ? `#${h}` : null;
}

/**
 * Pick a readable foreground (near-black or white) for text/icons drawn on top
 * of `hex`, using the WCAG relative-luminance formula. Light accents get dark
 * text; dark accents get white. Falls back to white for invalid input.
 */
export function readableForeground(hex: string | null | undefined): string {
  const norm = normalizeHex(hex);
  if (!norm) return "#ffffff";
  const r = channel(parseInt(norm.slice(1, 3), 16));
  const g = channel(parseInt(norm.slice(3, 5), 16));
  const b = channel(parseInt(norm.slice(5, 7), 16));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // 0.4 sits between pure-blue (~0.07) and a light pastel; the default blue and
  // typical Windows accents land below it → white text, as today.
  return luminance > 0.4 ? "#1a1a1a" : "#ffffff";
}

/** sRGB channel (0–255) → linear light value (0–1), per WCAG. */
function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
