/**
 * Messages en attente, en tête du cadre de la saisie : `MessageQueue` de Socle (D-373). Une ligne chacun, avec ses
 * pastilles de références. Ils partent à la fin de l’étape en cours, ou tout de suite avec « Envoyer maintenant » ;
 * leur ordre se change par glisser-déposer ou Flèches haut et bas sur la poignée, quand le store sait réordonner.
 */
import { MessageQueue } from "socle-ui";
import { mentionReferences } from "./lib/composerReferences";
import { ATTACHMENTS_ONLY_TEXT, type QueuedMessage } from "./model";

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
  const byId = new Map(queue.map((item) => [item.id, item]));
  const run = (action: (item: QueuedMessage) => void) => (id: string) => {
    const item = byId.get(id);
    if (item) action(item);
  };
  return (
    <MessageQueue
      items={queue.map(({ id, message }) => ({
        id,
        text: queuedPreview(message),
        // Les pastilles se posent dans le texte du message, pas dans l’aperçu d’un message sans texte.
        references: message.text.trim() ? mentionReferences(message.references ?? []) : [],
        isEditable: queuedEditable(message),
      }))}
      onReorder={onReorder}
      onEdit={run(onEdit)}
      onRemove={run(onRemove)}
      onSendNow={run(onSendNow)}
      isDisabled={disabled}
    />
  );
}
