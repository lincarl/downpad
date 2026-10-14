import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * Buttons in Mervin's style. `default` is the accent-filled primary action,
 * `outline` the neutral push button (transparent in dark, white in light),
 * `tool` the toolbar button (flat in dark, outlined in light) and `ghost` a
 * borderless button for compact rows. Disabled buttons change ink, not opacity.
 */
const buttonVariants = cva(
  cn(
    "inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap",
    "rounded-control border font-[var(--font-ui)] text-[12px] font-normal leading-4 outline-none",
    "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-accent",
    "disabled:cursor-default [&_svg]:pointer-events-none [&_svg]:shrink-0",
  ),
  {
    variants: {
      variant: {
        default: cn(
          "border-accent bg-accent text-accent-fg hover:border-accent-hover hover:bg-accent-hover",
          "disabled:border-line-disabled disabled:bg-push disabled:text-ink-disabled",
        ),
        outline: cn(
          "border-line-push bg-push text-ink hover:border-line-strong hover:bg-hover active:bg-pressed",
          "disabled:border-line-disabled disabled:bg-push disabled:text-ink-disabled",
        ),
        tool: cn(
          "border-line-tool bg-transparent text-ink-body hover:border-line-tool-strong hover:bg-hover",
          "active:bg-pressed data-[state=open]:border-line-tool-strong data-[state=open]:bg-pressed",
          "aria-pressed:border-line-tool-strong aria-pressed:bg-tool-checked",
          "disabled:border-line-tool-disabled disabled:bg-transparent disabled:text-ink-disabled",
        ),
        ghost: cn(
          "border-transparent bg-transparent text-ink-body hover:bg-hover active:bg-pressed",
          "disabled:bg-transparent disabled:text-ink-disabled",
        ),
      },
      size: {
        default: "h-[31px] px-[14px]",
        sm: "h-[25px] px-2.5",
        icon: "size-7 p-0",
        tool: "h-[33px] px-2",
        "tool-icon": "h-[33px] w-[41px] p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild, ...props },
  ref,
) {
  const Component = asChild ? Slot : "button";
  return <Component ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});

export { buttonVariants };
