// Layout pieces for the Settings pages, after Mervin's SettingsDialog: a page
// column of bordered boxes, form rows with a label column shared by every box
// on the page (CSS subgrid), check rows, and hints under their control.

import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** The two-column grid every page uses; boxes and rows are subgrids of it, so
 *  the widest label on a page sets the field column for all of its boxes. */
const pageGridClassName = "grid grid-cols-[max-content_minmax(0,1fr)] content-start gap-x-1.5 gap-y-3";

/** A grid item that spans the page grid and passes its columns through. */
const subgridClassName = "col-span-full grid grid-cols-subgrid";

export interface SettingsPageProps {
  id: string;
  tabId: string;
  active: boolean;
  /** Pages without boxes (Keyboard shortcuts, About) lay out their own column. */
  plain?: boolean;
  children: ReactNode;
}

/**
 * One page of the dialog. It scrolls on its own with Mervin's 20/14 margins.
 * Inactive pages stay mounted behind the `hidden` attribute, because Save reads
 * every field of the form.
 */
export function SettingsPage({ id, tabId, active, plain, children }: SettingsPageProps) {
  return (
    <div
      role="tabpanel"
      id={id}
      aria-labelledby={tabId}
      hidden={!active}
      className="settings-page min-h-0 flex-1 overflow-y-auto px-5 py-3.5"
    >
      <div className={plain ? "flex flex-col" : pageGridClassName}>{children}</div>
    </div>
  );
}

/**
 * A bordered group on a page. A title cuts the top border; leave it out when
 * the nav row already names the group.
 */
export function SettingsBox({ title, children }: { title?: string; children: ReactNode }) {
  const titleId = useId();
  return (
    <div
      role="group"
      aria-labelledby={title ? titleId : undefined}
      className={cn(
        subgridClassName,
        "relative content-start gap-y-1.5 rounded-[8px] border border-line px-[21px] pb-[19px] pt-[21px]",
        title && "mt-2.5",
      )}
    >
      {title && (
        <h3
          id={titleId}
          className="absolute -top-[11px] left-[9px] m-0 bg-window px-1 text-[12px] font-normal leading-4 text-ink-soft"
        >
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}

export interface FormRowProps {
  /** The label text; the row adds the colon. */
  label: string;
  children: ReactNode;
  /** Rows holding buttons cannot be a `<label>`; they render as a `<div>`. */
  asLabel?: boolean;
  className?: string;
}

/**
 * A `.dialog-row`: the label in the page's label column and the control at its
 * natural width in the field column.
 */
export function FormRow({ label, children, asLabel = true, className }: FormRowProps) {
  const Row = asLabel ? "label" : "div";
  return (
    <Row className={cn("dialog-row", subgridClassName, "items-center", className)}>
      <span className="text-ink">{label}:</span>
      <span className="flex min-w-0 items-center gap-2 justify-self-start">{children}</span>
    </Row>
  );
}

export interface CheckRowProps {
  label: string;
  /** In the field column under the row above (default), or from the box's
   *  left edge for a check box that stands alone. */
  placement?: "field" | "box";
  children: ReactNode;
}

/** A `.dialog-row` holding a check box (passed as children) and its text. */
export function CheckRow({ label, placement = "field", children }: CheckRowProps) {
  return (
    <label
      className={cn(
        "dialog-row flex min-h-5 items-center gap-1.5 justify-self-start text-ink",
        placement === "field" ? "col-start-2" : "col-span-full",
      )}
    >
      {children}
      <span>{label}</span>
    </label>
  );
}

/** Secondary text under a control, in the field column unless it explains the
 *  whole box. */
export function Hint({ children, placement = "field" }: { children: ReactNode; placement?: "field" | "box" }) {
  return (
    <p
      className={cn(
        "m-0 text-ink-soft",
        placement === "field" ? "col-start-2" : "col-span-full",
      )}
    >
      {children}
    </p>
  );
}
