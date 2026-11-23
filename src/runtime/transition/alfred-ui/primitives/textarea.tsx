import { cn } from "cn";
import type * as React from "react";

export type TextareaVariant = "default" | "composer" | "inline";

function Textarea({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"textarea"> & { variant?: TextareaVariant }) {
  return (
    <textarea
      data-slot="textarea"
      data-variant={variant}
      className={cn(
        "flex min-h-[72px] w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-[13px] text-foreground shadow-none transition-colors duration-100 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
        "data-[variant=composer]:min-h-8 data-[variant=composer]:max-h-40 data-[variant=composer]:resize-none data-[variant=composer]:overflow-y-auto data-[variant=composer]:border-0 data-[variant=composer]:bg-transparent data-[variant=composer]:px-0 data-[variant=composer]:py-0 data-[variant=composer]:leading-normal data-[variant=composer]:focus-visible:ring-0",
        "data-[variant=inline]:block data-[variant=inline]:min-h-0 data-[variant=inline]:resize-none data-[variant=inline]:overflow-hidden data-[variant=inline]:rounded-none data-[variant=inline]:border-0 data-[variant=inline]:bg-transparent data-[variant=inline]:p-0 data-[variant=inline]:focus-visible:ring-0",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
