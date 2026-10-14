import { forwardRef, type SelectHTMLAttributes } from "react";

import { cn } from "@/lib/utils";
import { fieldClassName } from "./input";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {}

/** Native select behavior with the field well and a chevron that advertises the list. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(fieldClassName, "md-select cursor-pointer appearance-none pr-7", className)}
      {...props}
    >
      {children}
    </select>
  );
});
