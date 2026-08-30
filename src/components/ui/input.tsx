import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

/** Native input behavior with the shared shadcn/Tailwind field treatment. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        "min-w-40 rounded-[5px] border border-border bg-background px-2 py-1 font-[var(--font-ui)] text-[13px] text-foreground outline-none transition-[border-color,box-shadow] focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});
