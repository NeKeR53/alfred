/**
 * Brouillon déposé dans la saisie d’une conversation avant son affichage (pièces jointes et contexte d’une capture
 * « Corriger un élément ») : la saisie le reprend une seule fois, à l’ouverture de la conversation.
 */
import type { Attachment, PastedContext } from "./model";

export interface ComposerDraft {
  text?: string;
  attachments?: Attachment[];
  contexts?: PastedContext[];
}

const drafts = new Map<string, ComposerDraft>();

export function setComposerDraft(conversation: string, draft: ComposerDraft) {
  drafts.set(conversation, draft);
}

export function takeComposerDraft(conversation: string): ComposerDraft | undefined {
  const draft = drafts.get(conversation);
  // Effacé après coup : le double montage du mode strict de React relit le même brouillon.
  if (draft) queueMicrotask(() => drafts.delete(conversation));
  return draft;
}
