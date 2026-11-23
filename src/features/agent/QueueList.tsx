/**
 * Messages en attente, en tête du cadre de la saisie, repris de `AgentQueue` de OneApp : une ligne chacun, avec ses
 * pastilles de références. Ils partent à la fin de l’étape en cours, ou tout de suite avec « Envoyer maintenant » ;
 * leur ordre se change par glisser-déposer ou Flèches haut et bas sur la poignée, quand le store sait réordonner.
 */
import { Clock3, GripVertical, Pencil, X } from "lucide-react";
import { type ReactNode, type PointerEvent as ReactPointerEvent, useEffect, useId, useRef, useState } from "react";
import { IconButton } from "socle-ui";
import { AgentSendButton } from "./AgentSendButton";
import { type ComposerReference, type ComposerReferenceMention, referenceDisplayName } from "./lib/composerReferences";
import { ATTACHMENTS_ONLY_TEXT, type QueuedMessage } from "./model";

/** Un glissement ne commence qu’après 4 px : un simple clic sur la poignée ne déplace rien. */
const DRAG_ACTIVATION_DISTANCE = 4;

function isMention(reference: ComposerReference): reference is ComposerReferenceMention {
  const { id, offset } = reference as Partial<ComposerReferenceMention>;
  return typeof id === "string" && Number.isInteger(offset);
}

/** Texte d’un message, ses pastilles de références posées à leur position. */
export function ReferencePills({ text, references }: { text: string; references: readonly ComposerReference[] }) {
  const placed = references.filter(isMention);
  if (!placed.length) return <>{text}</>;
  const ordered = placed
    .map((reference, index) => ({ reference, index }))
    .sort((left, right) => left.reference.offset - right.reference.offset || left.index - right.index);
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const { reference } of ordered) {
    const offset = Math.max(cursor, Math.min(text.length, reference.offset));
    if (offset > cursor) content.push(text.slice(cursor, offset));
    content.push(
      <span key={reference.id} className="reference-pill">
        {referenceDisplayName(reference)}
      </span>,
    );
    cursor = offset;
  }
  if (cursor < text.length) content.push(text.slice(cursor));
  return <>{content}</>;
}

/**
 * Aperçu d’un message en file, comme dans OneApp : son texte, « Texte collé » pour un collage seul, sinon le texte
 * envoyé avec des pièces jointes seules.
 */
export function queuedPreview(message: QueuedMessage["message"]): string {
  if (message.text.trim()) return message.text;
  if (message.contexts.length) return "Texte collé";
  return message.attachments.length ? ATTACHMENTS_ONLY_TEXT : message.text;
}

/** Comme dans OneApp, un message avec pièces jointes ou texte collé ne se reprend pas dans la saisie. */
export function queuedEditable(message: QueuedMessage["message"]): boolean {
  return !message.attachments.length && !message.contexts.length;
}

type Placement = "before" | "after";

function reorder<T extends { id: string }>(items: T[], draggedId: string, targetId: string, placement: Placement) {
  const dragged = items.find((item) => item.id === draggedId);
  if (!dragged || draggedId === targetId) return items;
  const remaining = items.filter((item) => item.id !== draggedId);
  const targetIndex = remaining.findIndex((item) => item.id === targetId);
  if (targetIndex < 0) return items;
  const insertion = targetIndex + (placement === "after" ? 1 : 0);
  return [...remaining.slice(0, insertion), dragged, ...remaining.slice(insertion)];
}

const sameIds = (left: readonly { id: string }[], right: readonly { id: string }[]) =>
  left.length === right.length && left.every((item, index) => item.id === right[index]?.id);

/**
 * Réordonnancement repris de `useDragReorder` de OneApp : l’ordre affiché suit le pointeur, un aperçu cloné le
 * suit, et l’ordre final est enregistré au relâchement ; un échec remet l’ordre d’avant.
 */
function useQueueReorder(items: QueuedMessage[], onReorder: ((ids: string[]) => Promise<void> | void) | undefined) {
  const scopeId = useId();
  const [ordered, setOrdered] = useState(items);
  const [draggedId, setDraggedId] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{ id: string; placement: Placement }>();
  const [saving, setSaving] = useState(false);
  const current = useRef(items);
  const cleanup = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    if (draggedId || saving) return;
    const changed = !sameIds(current.current, items);
    current.current = items;
    if (changed) setOrdered(items);
  }, [draggedId, items, saving]);

  useEffect(() => () => cleanup.current?.(), []);

  const save = (before: QueuedMessage[], next: QueuedMessage[]) => {
    if (sameIds(before, next) || saving || !onReorder) return;
    current.current = next;
    setOrdered(next);
    setSaving(true);
    void Promise.resolve()
      .then(() => onReorder(next.map(({ id }) => id)))
      .catch(() => {
        current.current = before;
        setOrdered(before);
      })
      .finally(() => setSaving(false));
  };

  const moveItem = (id: string, offset: -1 | 1) => {
    if (saving) return;
    const before = current.current;
    const source = before.findIndex((item) => item.id === id);
    const target = source + offset;
    if (source < 0 || target < 0 || target >= before.length) return;
    const next = [...before];
    const [moved] = next.splice(source, 1);
    next.splice(target, 0, moved);
    save(before, next);
  };

  const startDrag = (event: ReactPointerEvent<HTMLElement>, id: string, row: HTMLElement) => {
    if (saving || event.button !== 0) return;
    cleanup.current?.();
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY };
    const before = current.current;
    let preview: HTMLElement | undefined;
    let offsetX = 0;
    let offsetY = 0;
    const begin = (x: number, y: number) => {
      const bounds = row.getBoundingClientRect();
      offsetX = x - bounds.left;
      offsetY = y - bounds.top;
      preview = row.cloneNode(true) as HTMLElement;
      for (const element of preview.querySelectorAll("[id]")) element.removeAttribute("id");
      preview.removeAttribute("data-sortable-id");
      preview.removeAttribute("data-sortable-scope");
      preview.classList.remove("is-dragging", "is-drop-before", "is-drop-after");
      preview.classList.add("drag-preview");
      preview.setAttribute("aria-hidden", "true");
      Object.assign(preview.style, {
        width: `${bounds.width}px`,
        height: `${bounds.height}px`,
        left: `${bounds.left}px`,
        top: `${bounds.top}px`,
      });
      document.body.append(preview);
      setDraggedId(id);
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      if (!preview) {
        const dx = pointer.clientX - start.x;
        const dy = pointer.clientY - start.y;
        if (dx * dx + dy * dy < DRAG_ACTIVATION_DISTANCE ** 2) return;
        begin(start.x, start.y);
      }
      pointer.preventDefault();
      if (!preview) return;
      preview.style.left = `${pointer.clientX - offsetX}px`;
      preview.style.top = `${pointer.clientY - offsetY}px`;
      const target = document
        .elementFromPoint(pointer.clientX, pointer.clientY)
        ?.closest<HTMLElement>(`[data-sortable-scope="${scopeId}"]`);
      const targetId = target?.dataset.sortableId;
      if (!target || !targetId || targetId === id) return;
      const bounds = target.getBoundingClientRect();
      const placement: Placement = pointer.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
      setDropTarget({ id: targetId, placement });
      const next = reorder(current.current, id, targetId, placement);
      current.current = next;
      setOrdered(next);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      preview?.remove();
      cleanup.current = undefined;
    };
    function finish(pointer: PointerEvent) {
      if (pointer.pointerId !== pointerId) return;
      const dragged = Boolean(preview);
      stop();
      setDraggedId(undefined);
      setDropTarget(undefined);
      if (dragged) save(before, current.current);
    }
    window.addEventListener("pointermove", move, { passive: false });
    // Pas de `once` : le relâchement d’un autre pointeur consommerait l’écouteur du glissement en cours.
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    cleanup.current = stop;
  };

  const latest = new Map(items.map((item) => [item.id, item]));
  const visible = ordered.flatMap((item) => {
    const found = latest.get(item.id);
    return found ? [found] : [];
  });
  return { scopeId, ordered: visible, draggedId, dropTarget, startDrag, moveItem };
}

export function QueueList({
  queue,
  disabled,
  onSendNow,
  onEdit,
  onRemove,
  onReorder,
}: {
  queue: QueuedMessage[];
  disabled?: boolean;
  onSendNow: (item: QueuedMessage) => void;
  onEdit: (item: QueuedMessage) => void;
  onRemove: (item: QueuedMessage) => void;
  /** Absent tant que le store ne sait pas réordonner la file : la poignée reste masquée. */
  onReorder?: (ids: string[]) => Promise<void> | void;
}) {
  const { scopeId, ordered, draggedId, dropTarget, startDrag, moveItem } = useQueueReorder(queue, onReorder);
  if (!queue.length) return null;
  const sortable = Boolean(onReorder) && queue.length > 1 && !disabled;
  const plural = queue.length > 1 ? "s" : "";
  return (
    <section
      className="agent-queue"
      aria-label={`${queue.length} message${plural} en file, envoyé${plural} à la fin de l’étape en cours`}
    >
      <ol>
        {ordered.map((item, index) => (
          <li
            key={item.id}
            className={`agent-queue__item sortable-row${draggedId === item.id ? " is-dragging" : ""}${dropTarget?.id === item.id ? ` is-drop-${dropTarget.placement}` : ""}`}
            data-sortable-id={item.id}
            data-sortable-scope={scopeId}
          >
            {sortable ? (
              <button
                type="button"
                id={`queued-${item.id}`}
                className="drag-handle reorder-handle reorder-handle--micro"
                aria-label={`Déplacer le message ${index + 1}`}
                title="Flèches haut et bas pour réordonner"
                onPointerDown={(event) => {
                  const row = event.currentTarget.parentElement;
                  if (row) startDrag(event, item.id, row);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                  event.preventDefault();
                  moveItem(item.id, event.key === "ArrowUp" ? -1 : 1);
                }}
              >
                <GripVertical size={12} aria-hidden="true" />
              </button>
            ) : (
              <Clock3 className="agent-queue__mark" size={12} aria-hidden="true" />
            )}
            <span className="agent-queue__text" title="En file : part à la fin de l’étape en cours">
              <ReferencePills text={queuedPreview(item.message)} references={item.message.references ?? []} />
            </span>
            <span className="agent-queue__actions">
              <IconButton
                icon={<Pencil size={12} />}
                label={`Modifier le message ${index + 1}`}
                isDisabled={disabled || !queuedEditable(item.message)}
                onPress={() => onEdit(item)}
              />
              <IconButton
                icon={<X size={12} />}
                label={`Retirer le message ${index + 1}`}
                isDisabled={disabled}
                onPress={() => onRemove(item)}
              />
            </span>
            <AgentSendButton
              direction="upRight"
              label={`Envoyer le message ${index + 1} maintenant`}
              isDisabled={disabled}
              onPress={() => onSendNow(item)}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}
