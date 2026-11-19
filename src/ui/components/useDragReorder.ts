/**
 * Réordonnancement au glisser-déposer, repris de OneApp (`src/hooks/useDragReorder.ts`). Différences : la cible
 * peut être trouvée par une fonction (onglets dessinés par `Tabs`), le clic qui suit un glissement est ignoré, et
 * `onReorder` reçoit l’élément déplacé pour écrire un message précis.
 */
import { type PointerEvent as ReactPointerEvent, useEffect, useId, useRef, useState } from "react";

export type DropPlacement = "before" | "after";
type DragAxis = "vertical" | "horizontal";

const ACTIVATION_DISTANCE = 4;

interface Options {
  axis?: DragAxis;
  /** Élément survolé → identifiant et élément de la cible ; par défaut, les attributs `data-sortable-*`. */
  findTarget?: (element: Element) => { id: string; element: HTMLElement } | undefined;
}

function reorder<T extends { id: string }>(items: T[], draggedId: string, targetId: string, placement: DropPlacement) {
  const dragged = items.find((item) => item.id === draggedId);
  if (!dragged || draggedId === targetId) return items;
  const remaining = items.filter((item) => item.id !== draggedId);
  const targetIndex = remaining.findIndex((item) => item.id === targetId);
  if (targetIndex < 0) return items;
  const insertionIndex = targetIndex + (placement === "after" ? 1 : 0);
  return [...remaining.slice(0, insertionIndex), dragged, ...remaining.slice(insertionIndex)];
}

const sameIds = (left: readonly { id: string }[], right: readonly { id: string }[]) =>
  left.length === right.length && left.every((item, index) => item.id === right[index]?.id);

/** Le relâchement d’un glissement produit un clic sur l’élément : il ne doit pas l’ouvrir. */
function swallowNextClick() {
  const stop = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
}

export function useDragReorder<T extends { id: string }>(
  items: T[],
  onReorder: (ids: string[], moved: string) => Promise<unknown> | undefined,
  { axis = "vertical", findTarget }: Options = {},
) {
  const scopeId = useId();
  const [orderedItems, setOrderedItems] = useState(items);
  const [draggedId, setDraggedId] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{ id: string; placement: DropPlacement }>();
  const initialItems = useRef(items);
  const currentItems = useRef(items);
  const activeId = useRef<string | undefined>(undefined);
  const previewElement = useRef<HTMLElement | undefined>(undefined);
  const pendingCleanup = useRef<(() => void) | undefined>(undefined);
  const cleanupListeners = useRef<(() => void) | undefined>(undefined);

  // Seuls l’ordre et la liste des identifiants sont gardés en état : un parent qui recrée ses éléments à chaque
  // rendu ne provoque aucune mise à jour supplémentaire.
  useEffect(() => {
    if (draggedId) return;
    const changed = !sameIds(currentItems.current, items);
    currentItems.current = items;
    if (changed) setOrderedItems(items);
  }, [draggedId, items]);

  useEffect(
    () => () => {
      pendingCleanup.current?.();
      cleanupListeners.current?.();
      previewElement.current?.remove();
    },
    [],
  );

  const save = (before: T[], next: T[], moved: string) => {
    const ids = next.map(({ id }) => id);
    if (!ids.some((id, index) => before[index]?.id !== id)) return;
    currentItems.current = next;
    setOrderedItems(next);
    // L’affichage suit le snapshot, que la modification met à jour puis rétablit en cas de refus.
    void onReorder(ids, moved);
  };

  const moveItem = (id: string, offset: -1 | 1) => {
    const before = currentItems.current;
    const sourceIndex = before.findIndex((item) => item.id === id);
    const targetIndex = sourceIndex + offset;
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= before.length) return false;
    const next = [...before];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    save(before, next, id);
    return true;
  };

  const locate =
    findTarget ??
    ((element: Element) => {
      const target = element.closest<HTMLElement>(`[data-sortable-scope="${scopeId}"]`);
      const id = target?.dataset.sortableId;
      return target && id ? { id, element: target } : undefined;
    });

  const startDrag = (event: ReactPointerEvent<HTMLElement>, id: string, source: HTMLElement) => {
    if (event.button !== 0) return;
    pendingCleanup.current?.();
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY };

    const beginDrag = (initialX: number, initialY: number) => {
      const bounds = source.getBoundingClientRect();
      const offsetX = initialX - bounds.left;
      const offsetY = initialY - bounds.top;
      const preview = source.cloneNode(true) as HTMLElement;
      for (const element of preview.querySelectorAll("[id]")) element.removeAttribute("id");
      preview.removeAttribute("id");
      preview.removeAttribute("data-sortable-id");
      preview.removeAttribute("data-sortable-scope");
      preview.classList.remove("is-dragging", "is-drop-before", "is-drop-after");
      preview.classList.add("drag-preview");
      preview.setAttribute("aria-hidden", "true");
      Object.assign(preview.style, {
        width: `${bounds.width}px`,
        height: `${bounds.height}px`,
        left: `${initialX - offsetX}px`,
        top: `${initialY - offsetY}px`,
      });
      // Ajouté à côté de la source, et non dans <body> : l’aperçu garde les règles contextuelles de sa liste
      // (`.sidebar .product-nav`, onglets), sans quoi l’icône et le libellé perdent leur mise en page.
      (source.parentElement ?? document.body).append(preview);
      previewElement.current = preview;
      initialItems.current = currentItems.current;
      activeId.current = id;
      setDraggedId(id);

      const move = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        pointerEvent.preventDefault();
        if (!activeId.current || !previewElement.current) return;
        previewElement.current.style.left = `${pointerEvent.clientX - offsetX}px`;
        previewElement.current.style.top = `${pointerEvent.clientY - offsetY}px`;
        const under = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY);
        const target = under ? locate(under) : undefined;
        if (!target || target.id === activeId.current) return;
        if (!currentItems.current.some((item) => item.id === target.id)) return;
        const rect = target.element.getBoundingClientRect();
        const position = axis === "horizontal" ? pointerEvent.clientX : pointerEvent.clientY;
        const startEdge = axis === "horizontal" ? rect.left : rect.top;
        const size = axis === "horizontal" ? rect.width : rect.height;
        const placement = position < startEdge + size / 2 ? "before" : "after";
        setDropTarget({ id: target.id, placement });
        const next = reorder(currentItems.current, activeId.current, target.id, placement);
        currentItems.current = next;
        setOrderedItems(next);
      };

      const finish = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        const before = initialItems.current;
        const next = currentItems.current;
        activeId.current = undefined;
        previewElement.current?.remove();
        previewElement.current = undefined;
        cleanupListeners.current?.();
        cleanupListeners.current = undefined;
        setDraggedId(undefined);
        setDropTarget(undefined);
        if (pointerEvent.type === "pointerup") swallowNextClick();
        save(before, next, id);
      };

      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      cleanupListeners.current = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
      };
    };

    const stopPending = () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerup", cancel);
      window.removeEventListener("pointercancel", cancel);
      if (pendingCleanup.current === stopPending) pendingCleanup.current = undefined;
    };
    const track = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      const dx = pointerEvent.clientX - start.x;
      const dy = pointerEvent.clientY - start.y;
      if (dx * dx + dy * dy < ACTIVATION_DISTANCE ** 2) return;
      stopPending();
      beginDrag(pointerEvent.clientX, pointerEvent.clientY);
    };
    const cancel = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId === pointerId) stopPending();
    };
    window.addEventListener("pointermove", track);
    window.addEventListener("pointerup", cancel);
    window.addEventListener("pointercancel", cancel);
    pendingCleanup.current = stopPending;
  };

  // Ordre du glissement, contenu toujours le plus récent fourni par le parent.
  const latest = new Map(items.map((item) => [item.id, item]));
  const visibleItems = orderedItems.flatMap((item) => {
    const current = latest.get(item.id);
    return current ? [current] : [];
  });
  // Un élément apparu pendant un glissement (écriture de l’agent) s’affiche quand même, en dernier.
  for (const item of items) if (!orderedItems.some((ordered) => ordered.id === item.id)) visibleItems.push(item);
  return { scopeId, orderedItems: visibleItems, draggedId, dropTarget, startDrag, moveItem };
}
