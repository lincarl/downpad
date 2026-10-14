import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

/** The inset field well every text and number input shares. */
export const fieldClassName = cn(
  "h-[29px] min-w-40 rounded-control border border-line bg-well px-2 font-[var(--font-ui)] text-[12px] text-ink-primary",
  "outline-none placeholder:text-ink-faint selection:bg-accent selection:text-accent-fg",
  "focus:border-accent disabled:cursor-default disabled:border-line-disabled disabled:text-ink-disabled",
);

/** Native input behavior with Mervin's field well. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type, ...props },
  ref,
) {
  return <input ref={ref} type={type} className={cn(fieldClassName, className)} {...props} />;
});
