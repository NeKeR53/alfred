import { cn } from "cn";
import { Check } from "lucide-react";
import type { ComponentProps } from "react";

/** Native input keeps checked, indeterminate, refs and change events unchanged. */
function Checkbox({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  return (
    <span data-slot="checkbox" className={cn("group relative inline-flex size-4 shrink-0", className)}>
      <input
        {...props}
        type="checkbox"
        className="peer absolute inset-0 z-10 m-0 size-4 cursor-default opacity-0 disabled:cursor-not-allowed"
      />
      <span
        data-slot="checkbox-indicator"
        aria-hidden="true"
        className="pointer-events-none flex size-4 items-center justify-center rounded-[4px] border border-input bg-background text-primary-foreground peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring/40 peer-disabled:opacity-50"
      >
        <Check className="size-3 opacity-0 group-has-[input:checked]:opacity-100" />
      </span>
    </span>
  );
}

export { Checkbox };
