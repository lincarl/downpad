import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { createContext, forwardRef, useContext } from "react";
import { cn } from "@/lib/utils";

const ToggleGroupContext = createContext<{ itemClassName?: string }>({});

export const ToggleGroup = forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root> & { itemClassName?: string }
>(function ToggleGroup({ className, itemClassName, children, ...props }, ref) {
  return (
    <ToggleGroupPrimitive.Root ref={ref} className={cn("flex items-center", className)} {...props}>
      <ToggleGroupContext.Provider value={{ itemClassName }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
});

export const ToggleGroupItem = forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(function ToggleGroupItem({ className, ...props }, ref) {
  const context = useContext(ToggleGroupContext);
  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center outline-none disabled:pointer-events-none",
        context.itemClassName,
        className,
      )}
      {...props}
    />
  );
});
