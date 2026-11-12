/** Contrat commun aux trois harnais (Claude Code, Codex, OpenCode) : mêmes événements, même session. */

export type Provider = "claude" | "codex" | "opencode";

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export type SessionStatus = "connecting" | "ready" | "responding" | "idle" | "closed";
export type ActivityStatus = "running" | "completed" | "failed";
export type ActivityKind = "analysis" | "command" | "file" | "tool" | "search" | "agent";
export type ActivityAction = {
  type: "read" | "search" | "listFiles" | "edit";
  path?: string;
  query?: string;
  added?: number;
  removed?: number;
};

/** Demande d’accord de l’agent : une commande, une écriture ou un outil qui sort de ce qui lui est permis. */
export interface ApprovalRequest {
  id: string;
  title: string;
  /** Commande, chemins ou arguments concernés. */
  detail?: string;
  options: Array<{ id: string; label: string; kind: "allow" | "allowAlways" | "deny" }>;
}

export type HarnessEvent =
  | { type: "status"; status: SessionStatus }
  | {
      type: "message";
      itemId: string;
      content: string;
      /** Texte complet de fin de message : il remplace les fragments reçus. */
      replace?: boolean;
    }
  | {
      type: "activity";
      itemId: string;
      kind: ActivityKind;
      title: string;
      detail?: string;
      actions?: ActivityAction[];
      content?: string;
      images?: string[];
      files?: string[];
      status: ActivityStatus;
    }
  | { type: "activityDelta"; itemId: string; content: string }
  | { type: "approval"; request: ApprovalRequest }
  /** L’accord n’attend plus de réponse (tour annulé, réponse donnée ailleurs). */
  | { type: "approvalClosed"; id: string }
  /** Identifiant de la session dans le harnais, pour la reprendre plus tard. */
  | { type: "session"; sessionId: string }
  | { type: "error"; message: string };

/** Fichier joint remis au CLI avec le message. */
export type InputFile = { path: string; name: string; mimeType?: string };

export function isInputImage(file: InputFile): boolean {
  return (file.mimeType ?? "").startsWith("image/") || /\.(?:png|jpe?g|gif|webp|avif)$/i.test(file.path);
}

/**
 * Liberté d’action de l’agent : `ask` (libre dans ses dossiers, accord ailleurs), `auto` (ne demande jamais),
 * `strict` (accord à chaque écriture et chaque commande).
 */
export type Autonomy = "ask" | "auto" | "strict";

export interface HarnessSession {
  readonly sessionId?: string;
  send(message: string, files?: readonly InputFile[], clientId?: string): Promise<void>;
  /** Oriente la réponse en cours, quand le harnais le permet. */
  steer?(message: string, files?: readonly InputFile[], clientId?: string): Promise<void>;
  /** Répond à une demande d’accord. */
  answer(approvalId: string, optionId: string): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface SessionOptions {
  provider: Provider;
  /** Dossier de travail de la conversation. */
  cwd: string;
  /** Dossier de l’espace : l’agent y écrit librement même s’il travaille ailleurs. */
  spaceDir?: string;
  /** Conversation à laquelle rattacher les outils d’Alfred. */
  conversation?: string;
  /** Adresse du serveur d’outils d’Alfred. */
  toolsUrl?: string;
  model?: string;
  effort?: string;
  /** Consignes d’Alfred, hors du fil des messages. */
  instructions?: string;
  resumeSessionId?: string;
  autonomy: Autonomy;
  title?: string;
  onEvent: (event: HarnessEvent) => void;
}

export interface HarnessModel {
  id: string;
  name: string;
  efforts: string[];
}
