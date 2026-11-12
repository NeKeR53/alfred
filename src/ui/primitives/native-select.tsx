import { cn } from "cn";
import { ChevronDownIcon } from "lucide-react";
import type * as React from "react";

function NativeSelect({
  className,
  density = "default",
  multiple,
  size,
  ...props
}: React.ComponentProps<"select"> & { density?: "sm" | "default" }) {
  return (
    <div
      className="group/native-select relative w-full min-w-0 has-[select:disabled]:opacity-50"
      data-slot="native-select-wrapper"
    >
      <select
        data-slot="native-select"
        data-size={density}
        multiple={multiple}
        size={size}
        className={cn(
          "h-8 w-full min-w-0 appearance-none rounded-md border border-input bg-background px-2 py-1 pr-8 text-[13px] text-foreground shadow-none transition-colors duration-100 outline-none selection:bg-primary selection:text-primary-foreground disabled:cursor-not-allowed data-[size=sm]:h-7",
          "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35",
          "aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
          className,
        )}
        {...props}
      />
      <ChevronDownIcon
        className={cn(
          "pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground select-none",
          (multiple || (size && size > 1)) && "hidden",
        )}
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </div>
  );
}

export { NativeSelect };
