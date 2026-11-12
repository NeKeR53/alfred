import { ChevronDown } from "lucide-react";
import { type DetailsHTMLAttributes, forwardRef, type ReactNode, useState } from "react";

export type DisclosureAppearance = "default" | "subtle";

export const Disclosure = forwardRef<
  HTMLDetailsElement,
  DetailsHTMLAttributes<HTMLDetailsElement> & {
    label: ReactNode;
    children: ReactNode;
    summaryClassName?: string;
    appearance?: DisclosureAppearance;
    /** Contenu rendu seulement à la première ouverture : une longue liste repliée ne coûte rien. */
    lazy?: boolean;
  }
>(function Disclosure(
  { label, children, className, summaryClassName, appearance = "default", lazy = false, ...props },
  ref,
) {
  const [opened, setOpened] = useState(Boolean(props.open));
  return (
    <details
      {...props}
      ref={ref}
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
        props.onToggle?.(event);
      }}
      className={["disclosure", appearance === "subtle" ? "disclosure--subtle" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
    >
      <summary className={summaryClassName}>
        {label}
        <ChevronDown className="disclosure__chevron" size={14} aria-hidden="true" />
      </summary>
      {!lazy || opened || props.open ? children : null}
    </details>
  );
});
