// biome-ignore-all lint/a11y/useAriaPropsForRole: The native checkbox keeps aria-checked in sync for controlled and uncontrolled switch states.
import { cn } from "cn";
import type { ComponentProps } from "react";

/** Native checkbox preserves change events and keyboard behavior with switch semantics. */
function Switch({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  return (
    <span data-slot="switch" className={cn("group relative inline-flex h-5 w-9 shrink-0", className)}>
      <input
        {...props}
        type="checkbox"
        role="switch"
        className="peer absolute inset-0 z-10 m-0 h-5 w-9 cursor-default opacity-0 disabled:cursor-not-allowed"
      />
      <span
        data-slot="switch-track"
        aria-hidden="true"
        className="pointer-events-none inline-flex h-5 w-9 items-center rounded-full border border-input bg-input transition-colors duration-100 peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring/40 peer-disabled:opacity-50"
      >
        <span className="ml-[2px] size-3.5 rounded-full bg-background transition-transform duration-100 group-has-[input:checked]:translate-x-4 motion-reduce:transition-none" />
      </span>
    </span>
  );
}

export { Switch };
