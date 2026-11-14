/** Modèle d’une conversation d’agent, tel qu’Alfred l’affiche et l’enregistre. */

import type { FileLines } from "../../lib/types";
import type { ActivityAction, ActivityKind, ActivityStatus, ApprovalRequest, Autonomy, Provider } from "./harness";
import { type ComposerReference, referenceInstructions } from "./lib/composerReferences";

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
  references?: ComposerReference[];
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
  return `${message.text}${contexts.join("")}${references}`.trim();
}

const MAX_ACTIVITY_CONTENT = 4000;

/** Relevé compact à enregistrer : les sorties d’outils longues sont tronquées, le détail reste dans le harnais. */
export function compactForStorage(conversation: Conversation): Conversation {
  const clip = (value: string | undefined) =>
    value && value.length > MAX_ACTIVITY_CONTENT
      ? `${value.slice(0, MAX_ACTIVITY_CONTENT)}\n… (${value.length - MAX_ACTIVITY_CONTENT} caractères de plus)`
      : value;
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
