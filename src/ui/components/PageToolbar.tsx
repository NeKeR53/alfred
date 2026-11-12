import type { HTMLAttributes, ReactNode } from "react";

export function PageToolbar({
  children,
  start,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children?: ReactNode; start?: ReactNode }) {
  return (
    <div {...props} className={["page-toolbar", className ?? ""].filter(Boolean).join(" ")}>
      <div className="page-toolbar__start">{start}</div>
      <div className="page-toolbar__actions">{children}</div>
    </div>
  );
}
