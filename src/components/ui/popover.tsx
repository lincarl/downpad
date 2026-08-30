import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;
const PopoverPortal = PopoverPrimitive.Portal;

function PopoverContent({ className, ...props }: ComponentProps<typeof PopoverPrimitive.Content>) {
  return <PopoverPrimitive.Content className={cn(className)} {...props} />;
}

export { Popover, PopoverTrigger, PopoverAnchor, PopoverPortal, PopoverContent };
