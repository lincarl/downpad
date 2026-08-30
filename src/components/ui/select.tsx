import { forwardRef, type SelectHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {}

/** Native select behavior with the shared shadcn/Tailwind field treatment. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        "min-w-40 rounded-[5px] border border-border bg-background px-2 py-1 font-[var(--font-ui)] text-[13px] text-foreground outline-none focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
});
