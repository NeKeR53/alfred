import { createContext, useContext } from "react";
import type { ConversationFileActions } from "./fileActions";

/**
 * Ressources d’une conversation, reprises de `ConversationResources` de OneApp : lecture des images de l’espace de
 * travail, actions sur les fichiers de l’agent et citation dans la réponse en cours.
 */
export type ConversationResources = {
  loadImage?: (reference: string) => Promise<string>;
  files?: ConversationFileActions;
  /** Cite un passage de l’agent dans la réponse en cours. */
  quote?: (text: string) => void;
};

export const ConversationResourcesContext = createContext<ConversationResources>({});

export function useConversationResources(): ConversationResources {
  return useContext(ConversationResourcesContext);
}
