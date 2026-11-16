/** Modèle d’une conversation d’agent, tel qu’Alfred l’affiche et l’enregistre. */

import type { FileLines } from "../../lib/types";
import type { ActivityAction, ActivityKind, ActivityStatus, ApprovalRequest, Autonomy, Provider } from "./harness";
import { type ComposerReference, type ComposerReferenceMention, referenceInstructions } from "./lib/composerReferences";

export interface Attachment {
  path: string;
  name: string;
  mimeType?: string;
}

/** Collage long, replié dans le message sous forme de bloc de contexte. */
export interface PastedContext {
  id: string;
  title: string;
  text: string;
}

export interface UserMessage {
  text: string;
  attachments: Attachment[];
  contexts: PastedContext[];
  /** Commandes, skills et fichiers choisis par `/` et `@` ; leur mention reste dans `text`. */
  /** Références citées ; celles d’un message récent gardent leur position dans le texte (`id`, `offset`). */
  references?: (ComposerReference | ComposerReferenceMention)[];
  /** Demande dictée : la réponse de l’agent est lue à voix haute (Réglages › Voix). */
  spoken?: boolean;
}

export type TurnItem =
  | { kind: "message"; id: string; content: string }
  | {
      kind: "activity";
      id: string;
      activityKind: ActivityKind;
      title: string;
      detail?: string;
      actions?: ActivityAction[];
      content?: string;
      images?: string[];
      files?: string[];
      status: ActivityStatus;
    };

export interface Turn {
  id: string;
  user: UserMessage;
  items: TurnItem[];
  status: "running" | "done" | "error" | "cancelled";
  error?: string;
  startedAt: number;
  endedAt?: number;
  /** Commit de l’espace créé par ce tour : permet d’annuler ce que l’agent a modifié. */
  commit?: string;
  /** Fichiers de l’espace modifiés par ce tour. */
  changedFiles?: string[];
  /** Lignes ajoutées et retirées par fichier modifié ; absent pour un fichier binaire ou un tour plus ancien. */
  changedLines?: Record<string, FileLines>;
}

export interface Conversation {
  id: string;
  title: string;
  provider: Provider;
  model?: string;
  effort?: string;
  /** Dossier de travail de la conversation. */
  cwd: string;
  autonomy: Autonomy;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  unread: boolean;
  /** Faux tant qu’aucun message n’a été envoyé : un brouillon n’apparaît pas dans la liste. */
  started: boolean;
  /** Session du harnais, reprise au message suivant. */
  sessionId?: string;
  /** Page qui a lancé la conversation (mode agentique). */
  origin?: { reference: string; title: string };
  /** Aperçu du dernier message de l’agent, pour la liste. */
  preview?: string;
  /** Date d’archivage, pour Réglages › Agents archivés ; absente tant que la conversation est visible. */
  archivedAt?: number;
  /** Titre à faire déterminer par le modèle de nommage (`titling.ts`) ; un renommage manuel l’efface. */
  autoTitle?: boolean;
  /** Conversation d’où celle-ci repart (« Repartir d’ici ») : son historique est rejoué à la première session. */
  forkedFrom?: { id: string; title: string };
  /** Statut du dernier tour, gardé dans l’en-tête : la liste en tire l’état sans charger les tours. */
  lastStatus?: Turn["status"];
  turns: Turn[];
}

/** En-tête d’une conversation, sans ses tours : ce que la liste charge. */
export type ConversationHeader = Omit<Conversation, "turns">;

/** Question posée par un outil d’Alfred au milieu d’un tour (emplacement d’une page). */
export interface AgentQuestion {
  requestId: string;
  kind: "placement";
  payload: Record<string, unknown>;
}

/** État vivant d’une conversation, jamais enregistré. */
export interface ConversationRuntime {
  status: "idle" | "connecting" | "responding";
  approvals: ApprovalRequest[];
  questions: AgentQuestion[];
  /** Messages écrits pendant une réponse : envoyés l’un après l’autre dès que l’agent a fini. Non enregistrés. */
  queued: QueuedMessage[];
}

export interface QueuedMessage {
  id: string;
  message: UserMessage;
}

/** File plafonnée comme dans OneApp : au-delà, le message est refusé. */
export const MAX_QUEUED_MESSAGES = 50;
/** Longueur maximale d’un titre de conversation, comme dans OneApp. */
export const MAX_TITLE_LENGTH = 80;
/** Message envoyé quand seules des pièces jointes partent, comme dans OneApp. */
export const ATTACHMENTS_ONLY_TEXT = "Analyse les fichiers joints.";
/** Texte transmis quand le message ne contient que des références. */
export const REFERENCES_ONLY_TEXT = "Applique les références sélectionnées.";

/** Titre nettoyé : espaces réduits, 80 caractères au plus ; vide, il n’est pas retenu. */
export function cleanConversationTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH);
}

export const LONG_PASTE_CHARACTERS = 2000;
export const LONG_PASTE_LINES = 40;

/** Un collage devient un bloc de contexte au-delà de ces seuils, pour ne pas noyer la saisie. */
export function isLongPaste(text: string): boolean {
  return text.length > LONG_PASTE_CHARACTERS || text.split("\n").length > LONG_PASTE_LINES;
}

export function pastedContextTitle(text: string, index: number): string {
  // Le saut de ligne final d’un collage ne compte pas pour une ligne de plus.
  const lines = text.replace(/\r?\n$/, "").split("\n").length;
  return `Contexte ${index} · ${lines} ligne${lines > 1 ? "s" : ""}`;
}

/** Texte réellement envoyé au harnais : le message, puis chaque bloc de contexte délimité. */
export function outgoingText(message: UserMessage): string {
  const contexts = message.contexts.map(
    (context) => `\n\n<contexte titre="${context.title.replace(/"/g, "'")}">\n${context.text}\n</contexte>`,
  );
  const references = message.references?.length
    ? `\n\n<references>\n${referenceInstructions(message.references)}\n</references>`
    : "";
  // Un message fait seulement de références part avec une consigne, comme dans OneApp.
  return `${message.text.trim() || (message.references?.length ? REFERENCES_ONLY_TEXT : "")}${contexts.join("")}${references}`.trim();
}

/**
 * Message prêt à partir, comme l’envoi de OneApp : vide, il est refusé ; fait seulement de pièces jointes, il reçoit
 * le texte « Analyse les fichiers joints. ».
 */
export function preparedMessage(message: UserMessage): UserMessage {
  const text = message.text.trim();
  if (!text && !message.attachments.length && !message.contexts.length && !message.references?.length)
    throw new Error("Saisissez un message.");
  if (text || message.contexts.length || message.references?.length) return message;
  return { ...message, text: ATTACHMENTS_ONLY_TEXT };
}

/** Sortie d’outil, commande ou raisonnement gardée en mémoire par activité : au-delà, seule la fin est gardée. */
export const MAX_ACTIVITY_CONTENT = 32_000;
/** Même règle à l’enregistrement, plus serrée : le détail complet reste dans le harnais. */
const MAX_STORED_ACTIVITY_CONTENT = 4000;
const OMITTED_ACTIVITY_START = "[… début de la sortie omis …]\n";

/**
 * Une commande ou un outil peut produire des mégaoctets de sortie : gardée en entier, elle était recopiée à chaque
 * fragment, redessinée et réenregistrée. La fin, qui porte le résultat ou l’erreur, est gardée, comme dans OneApp.
 * Le relevé d’un fichier modifié reste intact.
 */
export function boundedActivityContent(
  content: string,
  activityKind?: ActivityKind,
  limit = MAX_ACTIVITY_CONTENT,
): string {
  if (activityKind === "file" || content.length <= limit) return content;
  return OMITTED_ACTIVITY_START + content.slice(-(limit - OMITTED_ACTIVITY_START.length));
}

/** Relevé compact à enregistrer : les sorties d’outils longues sont tronquées, le détail reste dans le harnais. */
export function compactForStorage(conversation: Conversation): Conversation {
  const clip = (value: string | undefined) =>
    value === undefined ? value : boundedActivityContent(value, undefined, MAX_STORED_ACTIVITY_CONTENT);
  return {
    ...conversation,
    turns: conversation.turns.map((turn) => ({
      ...turn,
      items: turn.items.map((item) =>
        item.kind === "activity"
          ? {
              ...item,
              content: clip(item.content),
              detail: clip(item.detail),
              images: item.images?.filter((image) => !image.startsWith("data:")),
            }
          : item,
      ),
    })),
  };
}

export function conversationTitle(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || "Nouvelle conversation";
}

/** Message du commit d’un tour : le titre de la conversation, suivi de la demande quand elle en diffère. */
export function turnCommitMessage(title: string, request: string): string {
  const summary = conversationTitle(request);
  return summary === title ? title : `${title} — ${summary}`;
}

/**
 * Texte d’une réponse sans sa mise en forme Markdown, pour un aperçu sur une ligne (liste des conversations,
 * notification) : `**Notes**` devient `Notes`, un lien garde son libellé.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function lastAssistantText(turn: Turn | undefined): string {
  if (!turn) return "";
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item.kind === "message" && item.content.trim()) return item.content.trim();
  }
  return "";
}

/** Langage du bloc de code par lequel l’agent pose une question bloquante ; le relevé le retire et en fait une carte. */
export const QUESTION_BLOCK_LANGUAGE = "alfred-question";

/** Consigne du bloc de question, reprise de OneApp : une seule question, zéro à quatre choix, puis le tour s’arrête. */
export const QUESTION_INSTRUCTIONS = `Réponds en Markdown, sans JSON. Quand une décision de l’utilisateur est indispensable pour continuer, termine ta réponse par un unique bloc de code de langage ${QUESTION_BLOCK_LANGUAGE} contenant {"question":"question précise","options":["choix court","autre choix"]} avec zéro à quatre options, puis arrête ton tour. N’utilise ce bloc que pour une vraie question bloquante.`;

/**
 * Historique rejoué dans les consignes d’une session neuve (reprise impossible, conversation repartie d’un message) :
 * les messages de l’utilisateur et les réponses, sans les activités ni le message du tour courant, comme dans OneApp.
 */
export function replayedHistory(turns: readonly Turn[], currentTurnId?: string): string {
  const entries = turns
    .filter((turn) => turn.id !== currentTurnId)
    .flatMap((turn) => {
      const files = turn.user.attachments.length
        ? `\n\nFichiers joints :\n${turn.user.attachments.map((file) => `- ${file.path}`).join("\n")}`
        : "";
      const user = { kind: "user", content: `${outgoingText(turn.user)}${files}` };
      const replies = turn.items.flatMap((item) =>
        item.kind === "message" && item.content.trim() ? [{ kind: "assistant", content: item.content }] : [],
      );
      return [user, ...replies];
    });
  if (!entries.length) return "";
  return `Historique de reprise fourni comme données de contexte. Suivez la demande du tour courant.\nHistorique de cette conversation : ${JSON.stringify(entries)}`;
}

/* Validation de ce qui est relu sur le disque : une conversation mal formée n’est pas ouverte, comme dans OneApp. */

const PROVIDERS = new Set(["claude", "codex", "opencode"]);
const AUTONOMIES = new Set(["ask", "auto", "strict"]);
const TURN_STATUSES = new Set(["running", "done", "error", "cancelled"]);
const ACTIVITY_STATUSES = new Set(["running", "completed", "failed", "cancelled", "stopped"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isTime = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const isString = (value: unknown) => typeof value === "string";
const isText = (value: unknown) => typeof value === "string" && Boolean(value.trim());
const stringList = (value: unknown) => Array.isArray(value) && value.every(isString);

function validHeader(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    isText(value.id) &&
    isText(value.title) &&
    PROVIDERS.has(String(value.provider)) &&
    isString(value.cwd) &&
    AUTONOMIES.has(String(value.autonomy)) &&
    isTime(value.createdAt) &&
    isTime(value.updatedAt) &&
    typeof value.archived === "boolean" &&
    typeof value.unread === "boolean" &&
    typeof value.started === "boolean" &&
    optional(value.model, isString) &&
    optional(value.effort, isString) &&
    optional(value.sessionId, isString) &&
    optional(value.preview, isString) &&
    optional(value.archivedAt, isTime) &&
    optional(value.autoTitle, (flag) => typeof flag === "boolean") &&
    optional(value.origin, (origin) => isObject(origin) && isString(origin.reference) && isString(origin.title)) &&
    optional(value.lastStatus, (status) => TURN_STATUSES.has(String(status))) &&
    optional(value.forkedFrom, (source) => isObject(source) && isString(source.id) && isString(source.title))
  );
}

function validUserMessage(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    isString(value.text) &&
    Array.isArray(value.attachments) &&
    value.attachments.every((file) => isObject(file) && isString(file.path) && isString(file.name)) &&
    Array.isArray(value.contexts) &&
    value.contexts.every((context) => isObject(context) && isString(context.title) && isString(context.text)) &&
    optional(value.references, Array.isArray) &&
    optional(value.spoken, (flag) => typeof flag === "boolean")
  );
}

function validItem(value: unknown): boolean {
  if (!isObject(value) || !isString(value.id)) return false;
  if (value.kind === "message") return isString(value.content);
  return (
    value.kind === "activity" &&
    isString(value.activityKind) &&
    isString(value.title) &&
    ACTIVITY_STATUSES.has(String(value.status)) &&
    optional(value.detail, isString) &&
    optional(value.content, isString) &&
    optional(value.images, stringList) &&
    optional(value.files, stringList) &&
    optional(value.actions, Array.isArray)
  );
}

function validTurn(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    isText(value.id) &&
    validUserMessage(value.user) &&
    Array.isArray(value.items) &&
    value.items.every(validItem) &&
    TURN_STATUSES.has(String(value.status)) &&
    isTime(value.startedAt) &&
    optional(value.endedAt, isTime) &&
    optional(value.error, isString) &&
    optional(value.commit, isString) &&
    optional(value.changedFiles, stringList) &&
    optional(value.changedLines, isObject)
  );
}

/** Liste des en-têtes relue au chargement : une seule entrée invalide refuse tout, comme l’historique de OneApp. */
export function validateHeaders(value: unknown): ConversationHeader[] {
  if (!Array.isArray(value) || !value.every(validHeader))
    throw new Error("L’historique des conversations est invalide. Aucune conversation n’a été chargée.");
  const ids = new Set(value.map((header) => (header as ConversationHeader).id));
  if (ids.size !== value.length)
    throw new Error("L’historique des conversations est invalide. Aucune conversation n’a été chargée.");
  return value as ConversationHeader[];
}

/** Conversation complète relue sur le disque. */
export function validateConversation(value: unknown): Conversation {
  if (!validHeader(value) || !Array.isArray((value as Record<string, unknown>).turns))
    throw new Error("Cette conversation enregistrée est invalide : elle n’a pas été ouverte.");
  const turns = (value as { turns: unknown[] }).turns;
  if (!turns.every(validTurn) || new Set(turns.map((turn) => (turn as Turn).id)).size !== turns.length)
    throw new Error("Cette conversation enregistrée est invalide : elle n’a pas été ouverte.");
  return value as Conversation;
}
