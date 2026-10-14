import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, sideOffset = 5, ...props }, ref) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-[1300] rounded-[4px] border border-line bg-popover px-1.5 py-[3px] font-[family-name:var(--font-ui)] text-[12px] leading-4 text-ink",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
});

/** A control with the shared chrome tooltip. Needs a TooltipProvider above it. */
export function TooltipLabel({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
