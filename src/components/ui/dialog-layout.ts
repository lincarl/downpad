/**
 * Shared utility bundles for the programmatic Radix dialogs. Stable feature
 * selectors stay on each element; these strings own the ordinary presentation.
 */
export const dialogOverlayClassName =
  "fixed inset-0 z-[1000] flex items-center justify-center bg-black/35";

export const dialogContentClassName =
  "fixed left-1/2 top-1/2 z-[1001] flex max-h-[86vh] w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[10px] border border-border bg-background text-foreground shadow-[0_12px_48px_rgba(0,0,0,0.3)]";

export const dialogTitleClassName = "m-0 px-5 pb-2 pt-4 text-lg";
export const dialogBodyClassName = "overflow-auto px-5";
export const dialogFooterClassName =
  "flex justify-end gap-2 border-t border-border px-5 pb-4 pt-3";
export const dialogButtonClassName =
  "h-auto rounded-md px-4 py-1.5 font-[var(--font-ui)] text-[13px] font-normal";
