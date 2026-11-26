/**
 * Conversations rangées comme dans le menu de gauche : chaque délégué sous sa coordinatrice, sur un seul niveau
 * (`Sidebar.TreeItem`, D-042 et D-056 de socle-ui). Le menu et le suivi des conversations partent de cet arbre.
 *
 * - Un délégué dont la coordinatrice n’est pas affichée (archivée, supprimée) reste en haut et dit de qui il est le
 *   délégué.
 * - Les délégués suivent l’ordre où la coordinatrice les a lancés : leur place ne change pas avec leur état.
 * - La coordinatrice montre l’état de ses délégués : l’un travaille, elle est « au travail » ; l’un attend une
 *   réponse, elle l’attend aussi. Elle reste dépliée tant que c’est le cas.
 */
import type { ConversationHeader } from "./model";
import { CONVERSATION_STATE_LABEL, type ConversationState } from "./summary";

/** Fin du titre d’un délégué (`delegation.ts`) ; sous sa coordinatrice, sa place le dit déjà. */
export const DELEGATE_SUFFIX = " · délégué";

export interface ConversationNode {
  header: ConversationHeader;
  /** État de la conversation elle-même. */
  state: ConversationState;
  /** Titre affiché : celui d’un délégué perd « · délégué ». */
  label: string;
  /** Délégués de la coordinatrice, dans l’ordre où elle les a lancés. */
  delegates: ConversationNode[];
  /** Délégué dont la coordinatrice n’est pas dans la liste : « Délégué de Ventes Q3 », ou « Délégué » sans elle. */
  delegateOf?: string;
}

/** Titre d’une conversation, sans « · délégué » pour un délégué (un délégué renommé garde son titre). */
export function conversationLabel(header: Pick<ConversationHeader, "title" | "parent">): string {
  const title = header.title || "Nouvelle conversation";
  if (!header.parent || !title.endsWith(DELEGATE_SUFFIX)) return title;
  return title.slice(0, -DELEGATE_SUFFIX.length).trim() || title;
}

/** Rôle d’un délégué hors de sa coordinatrice : « Délégué de Ventes Q3 », ou « Délégué » si elle n’existe plus. */
export function delegateRole(
  header: Pick<ConversationHeader, "parent">,
  known: readonly Pick<ConversationHeader, "id" | "title">[],
): string | undefined {
  if (!header.parent) return undefined;
  const coordinator = known.find((candidate) => candidate.id === header.parent);
  return coordinator ? `Délégué de ${coordinator.title}` : "Délégué";
}

/**
 * Arbre des conversations `visible` (commencées, non archivées), dans leur ordre : les délégués passent sous leur
 * coordinatrice quand elle est visible et n’est pas elle-même déléguée (un seul niveau). `known` contient toutes
 * les conversations, archivées comprises, pour nommer la coordinatrice d’un délégué resté en haut.
 */
export function conversationTree(
  visible: readonly ConversationHeader[],
  stateOf: (header: ConversationHeader) => ConversationState,
  known: readonly ConversationHeader[] = visible,
): ConversationNode[] {
  const byId = new Map(visible.map((header) => [header.id, header]));
  const nodes = new Map<string, ConversationNode>(
    visible.map((header) => [
      header.id,
      { header, state: stateOf(header), label: conversationLabel(header), delegates: [] },
    ]),
  );
  const top: ConversationNode[] = [];
  for (const header of visible) {
    const node = nodes.get(header.id);
    if (!node) continue;
    const coordinator = header.parent ? byId.get(header.parent) : undefined;
    // Un délégué ne délègue jamais ; si cela arrivait, le petit-enfant resterait en haut plutôt qu’au troisième niveau.
    if (coordinator && !coordinator.parent && coordinator.id !== header.id)
      nodes.get(coordinator.id)?.delegates.push(node);
    else {
      node.delegateOf = delegateRole(header, known);
      top.push(node);
    }
  }
  for (const node of top) node.delegates.sort((left, right) => left.header.createdAt - right.header.createdAt);
  return top;
}

const isWorking = (state: ConversationState) => state === "working" || state === "waiting";

/**
 * État que montre la ligne : celui de la conversation, sauf qu’une coordinatrice prend celui d’un délégué qui attend
 * une réponse, puis d’un délégué au travail.
 */
export function familyState(node: ConversationNode): ConversationState {
  const delegates = node.delegates.map((delegate) => delegate.state);
  if (node.state === "attention" || delegates.includes("attention")) return "attention";
  if (node.state === "error" || isWorking(node.state)) return node.state;
  if (delegates.some(isWorking)) return "working";
  return node.state;
}

/**
 * Signes de la ligne dans le menu (`Sidebar.TreeItem`) : le point « En cours » si elle ou un délégué travaille ;
 * l’alerte si elle ou un délégué attend une réponse, ou si elle a échoué ; le point de non-lu si elle a fini sans
 * être lue.
 */
export function nodeSigns(node: ConversationNode) {
  const states = [node.state, ...node.delegates.map((delegate) => delegate.state)];
  return {
    activity: states.some(isWorking),
    warning: states.includes("attention") || node.state === "error",
    unread: node.state === "done",
  };
}

/** Coordinatrice dépliée d’office : un de ses délégués travaille ou attend une réponse. */
export function delegatesActive(node: ConversationNode): boolean {
  return node.delegates.some((delegate) => isWorking(delegate.state) || delegate.state === "attention");
}

const plural = (count: number, one: string, many: string) => `${count} ${count > 1 ? many : one}`;

/**
 * Ligne résumé d’une coordinatrice repliée : le nombre de délégués, puis ceux qui attendent une réponse, ceux au
 * travail et ceux en échec (« 3 délégués · 1 réponse attendue · 2 au travail »). Les non-lus, Socle les ajoute.
 */
export function delegatesSummary(node: ConversationNode): string | undefined {
  if (!node.delegates.length) return undefined;
  const count = (wanted: (state: ConversationState) => boolean) =>
    node.delegates.filter((delegate) => wanted(delegate.state)).length;
  const attention = count((state) => state === "attention");
  const working = count(isWorking);
  const failed = count((state) => state === "error");
  return [
    plural(node.delegates.length, "délégué", "délégués"),
    attention ? plural(attention, "réponse attendue", "réponses attendues") : "",
    working ? `${working} ${CONVERSATION_STATE_LABEL.working.toLowerCase()}` : "",
    failed ? `${failed} ${CONVERSATION_STATE_LABEL.error.toLowerCase()}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
