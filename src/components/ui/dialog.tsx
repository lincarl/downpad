import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

function DialogOverlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return <DialogPrimitive.Overlay className={cn(className)} {...props} />;
}

function DialogContent({ className, ...props }: ComponentProps<typeof DialogPrimitive.Content>) {
  return <DialogPrimitive.Content className={cn(className)} {...props} />;
}

const DialogTitle = DialogPrimitive.Title;
const DialogDescription = DialogPrimitive.Description;

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
};
