/** Modèle d’une conversation d’agent, tel qu’Alfred l’affiche et l’enregistre. */

import type { FileLines } from "../../lib/types";
import type {
  ActivityAction,
  ActivityKind,
  ActivityStatus,
  AgentTask,
  ApprovalRequest,
  Autonomy,
  PlanStep,
  Provider,
} from "./harness";
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
  /**
   * Contexte pour l’agent seul : envoyé avec le message, mais jamais affiché (ni dans la saisie, ni dans le relevé).
   * Par exemple la description de ce qu’encadre « Corriger un élément » : l’utilisateur ne voit que la capture.
   */
  hidden?: boolean;
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
  | {
      kind: "message";
      id: string;
      content: string;
      /** Dernier fragment reçu : la surveillance du silence compare les activités aux réponses, comme OneApp. */
      occurredAt?: number;
    }
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
      /** Dernière mise à jour reçue du CLI. */
      occurredAt?: number;
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
  /**
   * Tour relancé (« Relancer l’exécution ») : il reprend le message du tour `retryOf`. Dans OneApp, une relance
   * rattache un nouveau tour au même message, qui n’apparaît qu’une fois dans le fil.
   */
  retryOf?: string;
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
  /** Conversation coordinatrice : elle confie des tâches à d’autres agents (outils de délégation). */
  coordinator?: boolean;
  /** Coordinatrice dont cette conversation est la tâche déléguée, et la clé de cette tâche. */
  parent?: string;
  taskKey?: string;
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
  /**
   * Question bloquante qui termine la dernière réponse (bloc `alfred-question`), tant que l’utilisateur n’a pas
   * répondu : la conversation « attend votre réponse », comme dans OneApp.
   */
  pendingQuestion?: string;
  /** Dernier plan de l’agent, montré dans le panneau « Détails de la conversation » et enregistré avec elle. */
  plan?: PlanStep[];
  /** File d’attente enregistrée, comme dans OneApp : elle est rendue à la session vivante au chargement. */
  queued?: QueuedMessage[];
  turns: Turn[];
}

/** En-tête d’une conversation, sans ses tours : ce que la liste charge. */
export type ConversationHeader = Omit<Conversation, "turns" | "queued">;

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
  /** Tâches de l’agent de la session (commandes de fond, sous-agents), en cours et finies. Non enregistrées. */
  tasks?: Record<string, AgentTask>;
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

/** Texte d’un message fait seulement de collages, comme dans OneApp. */
export const PASTES_ONLY_TEXT = "Traite les données jointes selon la demande en cours.";

/**
 * Texte réellement envoyé au harnais : le message, puis chaque bloc de contexte délimité, puis les consignes des
 * références, comme le contexte de OneApp (sans balise autour).
 */
export function outgoingText(message: UserMessage): string {
  const contexts = message.contexts.map(
    (context) => `\n\n<contexte titre="${context.title.replace(/"/g, "'")}">\n${context.text}\n</contexte>`,
  );
  const references = message.references?.length ? `\n\n${referenceInstructions(message.references)}` : "";
  // Un message fait seulement de références ou de collages part avec une consigne, comme dans OneApp.
  const text =
    message.text.trim() ||
    (message.contexts.length ? PASTES_ONLY_TEXT : message.references?.length ? REFERENCES_ONLY_TEXT : "");
  return `${text}${contexts.join("")}${references}`.trim();
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

/** Titre tiré d’un message, comme `agentTitle` de OneApp : sa première ligne non vide, 60 caractères au plus. */
export function conversationTitle(text: string): string {
  const line = text.split("\n").find((item) => item.trim()) ?? "";
  const cleaned = line.replace(/\s+/g, " ").trim();
  return cleaned.length > 60 ? `${cleaned.slice(0, 59).trimEnd()}…` : cleaned || "Nouvelle conversation";
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

const QUESTION_BLOCK = /\n?```alfred-question[ \t]*\n([\s\S]*?)\n```[ \t]*$/;

/**
 * Question bloquante qui termine une réponse, comme `agentQuestion` de OneApp : un bloc final valide, avec une
 * question non vide. Sert à annoncer « attend votre réponse » plutôt que « a terminé ».
 */
export function finalQuestion(reply: string): string | undefined {
  const match = QUESTION_BLOCK.exec(reply.trimEnd());
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[1] ?? "") as { question?: unknown };
    return typeof value.question === "string" && value.question.trim()
      ? value.question.trim().slice(0, 1000)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Historique rejoué dans les consignes d’une session neuve (reprise impossible, conversation repartie d’un message) :
 * les messages de l’utilisateur et les réponses, sans les activités ni le message du tour courant, comme dans OneApp.
 */
export function replayedHistory(turns: readonly Turn[], currentTurnId?: string): string {
  const entries = turns
    .filter((turn) => turn.id !== currentTurnId)
    .flatMap((turn) => {
      // Une relance reprend le message de son tour : il n’apparaît qu’une fois, comme dans OneApp.
      const user = turn.retryOf
        ? []
        : [
            {
              kind: "user",
              content: [
                turn.user.references?.length ? referenceInstructions(turn.user.references) : "",
                `${replayedText(turn.user)}${attachmentPrompt(turn.user.attachments)}`,
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ];
      const replies = turn.items.flatMap((item) =>
        item.kind === "message" && item.content.trim() ? [{ kind: "assistant", content: item.content }] : [],
      );
      return [...user, ...replies];
    });
  if (!entries.length) return "";
  return `Historique de reprise fourni comme données de contexte. Suivez la demande du tour courant.\nHistorique de cette conversation : ${JSON.stringify(entries)}`;
}

/** Texte d’un message rejoué : le message et ses collages, sans les références, citées à part. */
function replayedText(message: UserMessage): string {
  return outgoingText({ ...message, references: undefined });
}

/** Chemins des pièces jointes, dans les termes de `attachmentPrompt` de OneApp. */
export function attachmentPrompt(attachments: readonly Attachment[]): string {
  return attachments.length
    ? `\n\nFichiers joints (chemins locaux à ouvrir avec les outils du CLI ; ouvrez les images avec un outil de vision) :\n${attachments.map(({ name, path }) => `- ${JSON.stringify(name)} : ${JSON.stringify(path)}`).join("\n")}`
    : "";
}

/* Validation de ce qui est relu sur le disque : une conversation mal formée n’est pas ouverte, comme dans OneApp. */

const PROVIDERS = new Set(["claude", "codex", "opencode"]);
const AUTONOMIES = new Set(["ask", "auto", "strict", "workspace"]);
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
    optional(value.pendingQuestion, isString) &&
    optional(value.queued, validQueue) &&
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

function validQueue(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_QUEUED_MESSAGES &&
    value.every((item) => isObject(item) && isText(item.id) && validUserMessage(item.message))
  );
}

function validItem(value: unknown): boolean {
  if (!isObject(value) || !isString(value.id) || !optional(value.occurredAt, isTime)) return false;
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
    optional(value.changedLines, isObject) &&
    optional(value.retryOf, isString)
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

const PLAN_STATUSES = new Set(["pending", "inProgress", "completed"]);

function validPlan(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((step) => isObject(step) && isString(step.text) && PLAN_STATUSES.has(String(step.status)))
  );
}

/** Conversation complète relue sur le disque. Un plan illisible est oublié : il ne ferme pas la conversation. */
export function validateConversation(value: unknown): Conversation {
  if (!validHeader(value) || !Array.isArray((value as Record<string, unknown>).turns))
    throw new Error("Cette conversation enregistrée est invalide : elle n’a pas été ouverte.");
  const turns = (value as { turns: unknown[] }).turns;
  if (!turns.every(validTurn) || new Set(turns.map((turn) => (turn as Turn).id)).size !== turns.length)
    throw new Error("Cette conversation enregistrée est invalide : elle n’a pas été ouverte.");
  const conversation = value as Conversation;
  if (conversation.plan !== undefined && !validPlan(conversation.plan)) {
    const { plan: _plan, ...rest } = conversation;
    return rest;
  }
  return conversation;
}
