import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface ThemeCardProps {
  /** The radio group's form name, read on save. */
  name: string;
  value: string;
  label: string;
  /** Read by screen readers after the label. */
  description: string;
  checked: boolean;
  onSelect: () => void;
  /** The preview drawn centred in the card's well. */
  children: ReactNode;
}

/**
 * Mervin's ThemeCard: a native radio drawn as a 168px card with a preview well,
 * the label and a round check mark. The whole card is the hit area, and the
 * hidden radio keeps native group behaviour (arrow keys move and select, Space
 * selects). Checked cards take the accent edge and wash; keyboard focus draws a
 * dashed accent ring inside the edge.
 */
export function ThemeCard({ name, value, label, description, checked, onSelect, children }: ThemeCardProps) {
  const descriptionId = useId();
  return (
    <label
      className={cn(
        "group relative block h-[168px] min-w-[150px] cursor-pointer rounded-[6px] border bg-bar",
        checked ? "border-accent" : "border-line-push",
      )}
    >
      {/* Centred, so a click aimed at the hidden radio lands inside the card's rounded edge. */}
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        aria-describedby={descriptionId}
        className="peer sr-only left-1/2 top-1/2"
      />
      {/* State wash over the card body: pressed, else checked, else hover. */}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 rounded-[5px] group-active:bg-pressed",
          checked ? "bg-accent-wash" : "group-hover:bg-hover",
        )}
      />
      <span
        aria-hidden="true"
        className="absolute inset-x-[5px] top-[5px] flex h-[125px] items-center justify-center overflow-hidden rounded-[3px] border border-line bg-well"
      >
        {children}
      </span>
      <span className="absolute bottom-2 left-2.5 right-8 flex h-[25px] items-center truncate text-ink-primary">
        {label}
      </span>
      <RadioMark checked={checked} />
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute -inset-px hidden size-[calc(100%+2px)] overflow-visible peer-focus-visible:block"
      >
        <rect
          x={2.5}
          y={2.5}
          rx={4}
          className="h-[calc(100%-5px)] w-[calc(100%-5px)] fill-none stroke-accent"
          strokeDasharray="4 2"
        />
      </svg>
      <span id={descriptionId} hidden>
        {description}
      </span>
    </label>
  );
}

/** The 13px round mark at the card's bottom right: an outline, or an accent
 *  disc with a tick when checked. */
function RadioMark({ checked }: { checked: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      className="absolute bottom-[13px] right-2.5 size-3.5"
    >
      <circle
        cx={7}
        cy={7}
        r={6.5}
        className={checked ? "fill-accent stroke-accent" : "fill-none stroke-ink-soft"}
      />
      {checked && (
        <path
          d="M3.8 7 6.2 9.4 10.5 4.5"
          className="fill-none stroke-accent-fg"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/** A row of three theme cards with 10px gaps, spanning its box. Cards wrap
 *  onto a second row when the dialog is too narrow for three. */
export function ThemeCardGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className="col-span-full grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5">
      {children}
    </div>
  );
}
