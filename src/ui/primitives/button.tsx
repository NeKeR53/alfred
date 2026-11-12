import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";
import type * as React from "react";

const buttonVariants = cva(
  "inline-flex shrink-0 select-none cursor-default items-center justify-center gap-2 rounded-md border-0 text-[13px] font-medium whitespace-nowrap transition-[color,background-color,transform] duration-100 ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transform-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
  {
    variants: {
      interaction: {
        press: "active:scale-[0.98]",
        stable: "",
      },
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20",
        outline:
          "border border-solid border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground",
        danger: "bg-transparent text-destructive hover:bg-destructive/10",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3 py-0",
        xs: "h-7 gap-1 px-2 py-0 text-xs",
        sm: "h-7 gap-1 px-2 py-0",
        lg: "h-8 px-4 py-0",
        icon: "size-7 p-0",
        "icon-xs": "size-7 p-0",
        "icon-sm": "size-7 p-0",
        "icon-lg": "size-8 p-0",
      },
    },
    defaultVariants: {
      interaction: "press",
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  interaction = "press",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, interaction, className }))}
      {...props}
    />
  );
}

export { Button };
