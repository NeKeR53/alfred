import { useEffect } from "react";

/** Closes an open context menu on Escape, an outside click, a resize or any scroll. */
export function useContextMenuDismiss(open: boolean, menuSelector: string, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape") return;
      if (event.target instanceof Element && event.target.closest(menuSelector)) return;
      close();
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [close, menuSelector, open]);
}
