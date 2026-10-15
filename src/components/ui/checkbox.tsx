import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {}

/** A native checkbox drawn as Mervin's rounded box, filled with the accent when checked.
 * The `md-check` rules in app.css draw the box and its tick. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, ...props },
  ref,
) {
  return <input ref={ref} type="checkbox" className={cn("md-check", className)} {...props} />;
});
