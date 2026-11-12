import { cn } from "cn";
import type { ComponentProps } from "react";

/** Native radio preserves group arrow-key behavior and form submission. */
function Radio({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  return (
    <span data-slot="radio" className={cn("group relative inline-flex size-4 shrink-0", className)}>
      <input
        {...props}
        type="radio"
        className="peer absolute inset-0 z-10 m-0 size-4 cursor-default opacity-0 disabled:cursor-not-allowed"
      />
      <span
        data-slot="radio-indicator"
        aria-hidden="true"
        className="pointer-events-none flex size-4 items-center justify-center rounded-full border border-input bg-background peer-checked:border-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring/40 peer-disabled:opacity-50"
      >
        <span className="size-2 rounded-full bg-primary opacity-0 group-has-[input:checked]:opacity-100" />
      </span>
    </span>
  );
}

export { Radio };
