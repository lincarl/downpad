/**
 * Shared utility bundles for the programmatic Radix dialogs, in Mervin's
 * dialog style: window fill, hairline rim, a 15px title, and a footer with
 * the buttons at the right. Stable feature selectors stay on each element;
 * these strings own the ordinary presentation.
 */
export const dialogOverlayClassName =
  "fixed inset-0 z-[1000] flex items-center justify-center bg-black/40";

export const dialogContentClassName =
  "fixed left-1/2 top-1/2 z-[1001] flex max-h-[86vh] w-[min(520px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[10px] border border-line-popover bg-window font-[var(--font-ui)] text-[13px] text-ink shadow-[0_16px_48px_rgb(0_0_0/0.32)] outline-none";

export const dialogTitleClassName = "m-0 px-[22px] pb-2 pt-[18px] text-[15px] font-semibold text-ink-primary";
export const dialogBodyClassName = "overflow-auto px-[22px] pb-4 leading-[19px]";
export const dialogFooterClassName =
  "flex justify-end gap-1.5 border-t border-separator px-[14px] py-2.5";
export const dialogButtonClassName = "";
