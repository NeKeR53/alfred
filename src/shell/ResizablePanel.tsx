import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { invoke } from "../lib/native";

const MIN = 280;
const MAX = 900;

/** Panneau de droite d’une page : posé à côté du contenu, redimensionnable à la souris et au clavier. */
export function ResizablePanel({
  children,
  storageKey,
  label,
}: {
  children: ReactNode;
  storageKey: string;
  label: string;
}) {
  const [width, setWidth] = useState(380);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    void invoke<number | null>("settings.get", { key: storageKey }).then((stored) => {
      if (typeof stored === "number") setWidth(Math.min(MAX, Math.max(MIN, stored)));
    });
  }, [storageKey]);

  const commit = (next: number) => {
    const clamped = Math.min(MAX, Math.max(MIN, Math.round(next)));
    setWidth(clamped);
    return clamped;
  };
  const save = (value: number) => void invoke("settings.set", { key: storageKey, value });

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current) commit(drag.current.startWidth + drag.current.startX - event.clientX);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    save(commit(drag.current.startWidth + drag.current.startX - event.clientX));
    drag.current = null;
  };

  return (
    <aside className="shell-panel" style={{ width }} aria-label={label}>
      {/* biome-ignore lint/a11y/useSemanticElements: séparateur interactif, sans équivalent HTML natif. */}
      <div
        className="shell-panel__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Largeur du panneau"
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") save(commit(width + 24));
          else if (event.key === "ArrowRight") save(commit(width - 24));
        }}
      />
      {/* Pendant le glissement, le cadre ne doit pas capter le pointeur. */}
      <div className="shell-panel__content">{children}</div>
    </aside>
  );
}
