import { forwardRef, useId, type ReactNode, type SVGProps } from "react";
import type { LucideProps } from "lucide-react";
import { cn } from "@/lib/utils";
import { appGlyph } from "./appGlyph";

/** Lucide's 24-unit geometry for the glyphs the composites below reuse. */
const FILE_PATHS = (
  <>
    <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
    <path d="M14 2v5a1 1 0 0 0 1 1h5" />
  </>
);
const FOLDER_OPEN_PATHS = (
  <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
);
const COPY_PATHS = (
  <>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </>
);

/** Badge geometry: a 60% copy glyph in the bottom-right corner. */
const BADGE_SCALE = 0.6;
const BADGE_OFFSET = 24 * (1 - BADGE_SCALE);

/**
 * Mervin's badged glyph: a base icon with a small "copy" badge in its corner and
 * a transparent gap knocked out around the badge, so the two never touch. It
 * takes the same props as a Lucide icon.
 */
function badgedIcon(displayName: string, base: ReactNode) {
  const Icon = forwardRef<SVGSVGElement, Omit<LucideProps, "ref">>(function BadgedIcon(
    { size = 24, strokeWidth = 2, absoluteStrokeWidth, className, color = "currentColor", ...props },
    ref,
  ) {
    const mask = useId();
    const width = absoluteStrokeWidth ? (Number(strokeWidth) * 24) / Number(size) : Number(strokeWidth);
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn("lucide", className)}
        {...(props as SVGProps<SVGSVGElement>)}
      >
        <mask id={mask}>
          <rect width="24" height="24" fill="#fff" stroke="none" />
          <rect x={BADGE_OFFSET - 2.5} y={BADGE_OFFSET - 2.5} width="24" height="24" rx="3" fill="#000" stroke="none" />
        </mask>
        <g mask={`url(#${mask})`}>{base}</g>
        <g
          transform={`translate(${BADGE_OFFSET} ${BADGE_OFFSET}) scale(${BADGE_SCALE})`}
          strokeWidth={width / BADGE_SCALE}
        >
          {COPY_PATHS}
        </g>
      </svg>
    );
  });
  Icon.displayName = displayName;
  return Icon;
}

/** "Copy file path": a file with a copy badge. */
export const FileCopyIcon = badgedIcon("FileCopyIcon", FILE_PATHS);

/** "Copy folder path": an open folder with a copy badge. */
export const FolderCopyIcon = badgedIcon("FolderCopyIcon", FOLDER_OPEN_PATHS);

/** The app icon, the blue tile with the white M and yellow chevron, for About. */
export function AppIcon({ size = 48, className }: { size?: number; className?: string }) {
  const gradient = useId();
  const { size: tile, corner, letter, arrow, colors } = appGlyph;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={`0 0 ${tile} ${tile}`}
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <defs>
        <linearGradient id={gradient} x2="1" y2="1">
          <stop stopColor={colors.tileLight} />
          <stop offset="1" stopColor={colors.tileDark} />
        </linearGradient>
      </defs>
      <rect width={tile} height={tile} rx={corner} fill={`url(#${gradient})`} />
      <path d={letter} fill={colors.letter} />
      <path d={arrow} fill={colors.arrow} />
    </svg>
  );
}

/**
 * md-easy's document artwork: a page with a folded corner and the app icon's M
 * and chevron, in the icon's blue gradient. Used for Recent rows.
 */
export function DocumentArtwork({ size = 34, className }: { size?: number; className?: string }) {
  const gradient = useId();
  const { size: tile, letter, arrow, colors } = appGlyph;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="4.25 9 238 238"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <defs>
        <linearGradient id={gradient} x2="1" y2="1">
          <stop stopColor={colors.tileLight} />
          <stop offset="1" stopColor={colors.tileDark} />
        </linearGradient>
      </defs>
      <path d="M55 9H157L215 67V226Q215 247 194 247H55Q34 247 34 226V30Q34 9 55 9Z" fill={`url(#${gradient})`} />
      <path d="M157 9V48Q157 67 176 67H215Z" fill="#91d9f5" />
      {/* The glyph of a 170-unit tile, centered on the page below the fold. */}
      <g transform={`translate(39.5 78) scale(${170 / tile})`}>
        <path d={letter} fill={colors.letter} />
        <path d={arrow} fill={colors.arrow} />
      </g>
    </svg>
  );
}
