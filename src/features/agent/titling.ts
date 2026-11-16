/**
 * Nommage automatique des conversations, repris de OneApp : un titre générique, tronqué ou déjà porté par une autre
 * conversation est remplacé par un titre court qu’un modèle tire du premier message. Le modèle de nommage est réglé à
 * part (Réglages › Agent), sinon c’est le modèle par défaut. Un échec garde le titre ; il n’y a pas de nouvel essai.
 */
import type { Provider } from "./harness/types";

const GENERIC_TITLES = new Set([
  "",
  "nouvelle conversation",
  "nouvel agent",
  "conversation",
  "agent",
  "assistant",
  "analyse",
  "mission",
]);

/** Délai laissé au modèle de nommage. */
export const TITLING_TIMEOUT_MS = 60_000;

/**
 * Un titre est à déterminer quand il n’identifie pas la conversation : vide ou générique, tronqué (première ligne
 * coupée), ou déjà porté par une autre conversation (lancements en série depuis une même page).
 */
export function needsAutoTitle(title: string, siblings: readonly string[]): boolean {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (GENERIC_TITLES.has(normalized.toLowerCase())) return true;
  if (normalized.endsWith("…")) return true;
  return siblings.some((sibling) => sibling.replace(/\s+/g, " ").trim().toLowerCase() === normalized.toLowerCase());
}

export function titlePrompt(message: string): string {
  return [
    "Donne un titre court à cette demande faite à un agent : de 3 à 7 mots, en français, sans guillemets, sans point final, sans préfixe du type « Titre : ».",
    "Le titre doit permettre de retrouver cette conversation parmi d’autres : nomme l’objet concret (page, fichier, module, courriel, fonction) plutôt que l’action générique.",
    "Réponds uniquement par le titre.",
    `Demande :\n${message.trim().slice(0, 4_000)}`,
  ].join("\n\n");
}

/** Première ligne utile de la réponse, débarrassée des guillemets, préfixes et ponctuation finale, 60 caractères au plus. */
export function cleanTitle(response: string): string {
  const line = response
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item && !/^```/.test(item));
  if (!line) return "";
  const cleaned = line
    .replace(/^(titre|title)\s*:\s*/i, "")
    .replace(/[.!…\s]+$/g, "")
    .replace(/^[«"'“”\s]+|[»"'“”\s]+$/g, "")
    .replace(/[.!…\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 60 ? `${cleaned.slice(0, 59).trimEnd()}…` : cleaned;
}

/** Modèle qui nomme les conversations. */
export interface TitlingModel {
  provider: Provider;
  model?: string;
  effort?: string;
}

/** Appel au modèle : une consigne entre, le texte de la réponse sort. */
export type Complete = (prompt: string, model: TitlingModel, timeoutMs: number) => Promise<string>;

/** Titre d’une conversation d’après son premier message. */
export async function titleConversation(message: string, model: TitlingModel, complete: Complete): Promise<string> {
  return cleanTitle(await complete(titlePrompt(message), model, TITLING_TIMEOUT_MS));
}

/** Ce que le nommage lit et écrit des conversations. */
export interface TitlingStore {
  /** Conversations à nommer : celles marquées `autoTitle`, avec leur premier message s’il est connu. */
  candidates: () => Array<{ id: string; firstMessage?: string }>;
  /** La conversation attend-elle toujours son titre ? Un renommage manuel l’a retirée. */
  stillWanted: (id: string) => boolean;
  setTitle: (id: string, title: string) => Promise<void>;
  model: () => TitlingModel;
  subscribe: (listener: () => void) => () => void;
}

/**
 * Nomme les conversations marquées `autoTitle` dès que leur premier message est connu. Chacune n’est tentée qu’une
 * fois, pour ne pas solliciter le modèle en boucle ; un renommage pendant le nommage est gardé.
 */
export function watchConversationTitles(store: TitlingStore, complete: Complete): () => void {
  const handled = new Set<string>();
  const check = () => {
    for (const { id, firstMessage } of store.candidates()) {
      if (handled.has(id) || !firstMessage?.trim()) continue;
      handled.add(id);
      void titleConversation(firstMessage, store.model(), complete)
        .then(async (title) => {
          if (title && store.stillWanted(id)) await store.setTitle(id, title);
        })
        .catch(() => undefined);
    }
  };
  check();
  return store.subscribe(check);
}
