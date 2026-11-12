import { useEffect, useState } from "react";

export function LoadingSkeleton({
  variant = "form",
  rows = 3,
  label = "Chargement…",
}: {
  variant?: "form" | "page";
  rows?: number;
  label?: string;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 200);
    return () => clearTimeout(timer);
  }, []);
  if (!visible) return null;
  return (
    <div className={`loading-skeleton loading-skeleton--${variant}`} role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Fixed decorative placeholders have no identity or state.
        <span aria-hidden="true" key={index} />
      ))}
    </div>
  );
}
