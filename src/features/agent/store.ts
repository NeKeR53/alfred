/**
 * Conversations d’agents : liste, relevé de chaque tour et session vivante dans le harnais. Les sessions restent
 * ouvertes d’un message à l’autre ; changer de harnais, de modèle ou d’autonomie en rouvre une au message suivant.
 * Une session au repos depuis 10 min est fermée pour libérer son CLI ; une session qui ne peut pas être reprise est
 * remplacée par une session neuve qui reçoit l’historique dans ses consignes, comme dans OneApp.
 */
import { create } from "zustand";
import { invoke, onNativeEvent } from "../../lib/native";
import type { Commit } from "../../lib/types";
import { notify } from "../../shell/notifications";
import { useShell } from "../../shell/store";
import { bindMainWindowClose } from "../../shell/windowClose";
import { useVoice } from "../voice/store";
import {
  type ApprovalRequest,
  type Autonomy,
  createSession,
  type HarnessEvent,
  type HarnessSession,
  PROVIDER_LABEL,
  type Provider,
} from "./harness";
import {
  type AgentQuestion,
  boundedActivityContent,
  type Conversation,
  type ConversationHeader,
  type ConversationRuntime,
  cleanConversationTitle,
  compactForStorage,
  conversationTitle,
  lastAssistantText,
  MAX_QUEUED_MESSAGES,
  outgoingText,
  plainText,
  preparedMessage,
  QUESTION_INSTRUCTIONS,
  replayedHistory,
  type Turn,
  type TurnItem,
  turnCommitMessage,
  type UserMessage,
  validateConversation,
  validateHeaders,
} from "./model";
import { notifySystem } from "./systemNotification";
import { needsAutoTitle, type TitlingModel, watchConversationTitles } from "./titling";
import { createSilenceWatch, type WatchedTurn } from "./watchdog";

export interface AgentDefaults {
  provider: Provider;
  autonomy: Autonomy;
  /** Modèle et effort retenus pour chaque harnais. */
  models: Partial<Record<Provider, { model?: string; effort?: string }>>;
}

const DEFAULTS: AgentDefaults = { provider: "claude", autonomy: "ask", models: {} };
const idleRuntime: ConversationRuntime = { status: "idle", approvals: [], questions: [], queued: [] };

export interface NewConversation {
  provider?: Provider;
  model?: string;
  effort?: string;
  cwd?: string;
  autonomy?: Autonomy;
  title?: string;
  origin?: Conversation["origin"];
}

export interface SendOptions {
  /**
   * Pendant une réponse : `now` envoie tout de suite (glissé dans la réponse en cours si l’agent le permet, sinon
   * après l’avoir interrompue) ; sans `now`, le message rejoint la file.
   */
  now?: boolean;
  /** Identifiant du message : un message déjà dans le fil ou dans la file sous cet identifiant est ignoré. */
  messageId?: string;
}

/** Point de départ de « Repartir d’ici » : le message de l’utilisateur du tour, ou la réponse qui le termine. */
export type ForkPoint = "user" | "reply";

interface AgentState {
  headers: ConversationHeader[];
  loaded: Record<string, Conversation>;
  runtime: Record<string, ConversationRuntime>;
  activeId: string | null;
  defaults: AgentDefaults;
  /**
   * Modèle qui nomme les conversations d’après leur premier message (réglage `agents.titling`, Réglages › Agent) ;
   * absent, le modèle par défaut.
   */
  titling?: TitlingModel | null;
  ready: boolean;
  /** Chargement impossible : rien n’est enregistré tant qu’un nouvel essai (`retryLoad`) n’a pas réussi. */
  loadError?: string;
  /** Enregistrement impossible ; effacé au premier enregistrement réussi. */
  saveError?: string;
  /**
   * Demandes de recoller le relevé en bas, par conversation : le compteur augmente à chaque envoi de l’utilisateur,
   * le relevé le suit même si l’utilisateur était remonté, comme dans OneApp.
   */
  follow: Record<string, number>;
  load: () => Promise<void>;
  /** Nouvel essai après un chargement impossible. */
  retryLoad: () => Promise<void>;
  /** Nouvel essai des enregistrements en échec ; l’échec reste dans `saveError`. */
  retrySave: () => Promise<void>;
  /** Enregistre tout de suite ce qui attend de l’être ; rejette si un enregistrement échoue (fermeture de la fenêtre). */
  flush: () => Promise<void>;
  setDefaults: (defaults: AgentDefaults) => Promise<void>;
  open: (id: string | null) => Promise<void>;
  /** Affiche une conversation sur la page Agent depuis l’extérieur : notification, lien, palette de commandes. */
  show: (id: string) => Promise<void>;
  /** Charge une conversation sans en faire la conversation ouverte de la page Agent. */
  ensureLoaded: (id: string) => Promise<void>;
  create: (options?: NewConversation) => Conversation;
  update: (id: string, patch: Partial<ConversationHeader>) => void;
  /** Nouveau titre ; vide, l’ancien est gardé. */
  rename: (id: string, title: string) => Promise<void>;
  /** Masque la conversation de la liste sans rien effacer ; une réponse en cours est arrêtée. */
  archive: (id: string) => Promise<void>;
  unarchive: (id: string) => Promise<void>;
  markUnread: (id: string) => Promise<void>;
  /**
   * Envoie un message, comme dans OneApp. Un message vide est refusé (« Saisissez un message. ») ; seulement des pièces
   * jointes, il part avec « Analyse les fichiers joints. ». Pendant une réponse, il rejoint la file (50 messages au
   * plus) ou part tout de suite avec `now`.
   */
  send: (id: string, message: UserMessage, options?: SendOptions) => Promise<void>;
  /** Relance le dernier message après une erreur ou une interruption, comme « Relancer l’exécution » dans OneApp. */
  retry: (id: string) => Promise<void>;
  /**
   * Renvoie tel quel le message de l’utilisateur du tour `turnId`, pièces jointes et références comprises, à la suite
   * du fil (« Relancer le message ») ; pendant une réponse, il rejoint la file.
   */
  resend: (id: string, turnId: string) => Promise<void>;
  /**
   * « Repartir d’ici » : nouvelle conversation « {titre} · reprise » qui reprend le fil jusqu’au tour `turnId`, sans
   * lui depuis son message (`from: "user"`), avec lui depuis sa réponse (`from: "reply"`, par défaut). Elle est ouverte ; sa
   * première session reçoit cet historique. Rend son identifiant et, depuis un message, ce message à remettre dans la
   * saisie.
   */
  fork: (id: string, turnId: string, from?: ForkPoint) => Promise<{ id: string; draft?: UserMessage }>;
  /** Applique l’ordre choisi (glisser-déposer) à la file ; une liste qui ne reprend pas toute la file est ignorée. */
  reorderQueued: (id: string, queuedIds: readonly string[]) => void;
  /** Avance (-1) ou recule (+1) un message d’un rang dans la file (flèches sur la poignée). */
  moveQueued: (id: string, queuedId: string, offset: -1 | 1) => void;
  /** Envoie tout de suite un message de la file, comme « Envoyer maintenant » dans OneApp. */
  sendQueuedNow: (id: string, queuedId: string) => Promise<void>;
  /** Retire un message de la file et le rend, pour le remettre dans la saisie. */
  unqueue: (id: string, queuedId: string) => UserMessage | undefined;
  cancel: (id: string) => Promise<void>;
  answerApproval: (id: string, approvalId: string, optionId: string) => Promise<void>;
  answerQuestion: (id: string, requestId: string, result: unknown, error?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  undoTurn: (id: string, turnId: string) => Promise<void>;
}

type Live = { session: HarnessSession; signature: string };
const sessions = new Map<string, Live>();
/**
 * Génération de la session vivante de chaque conversation. Fermer une session pour en ouvrir une autre (modèle ou
 * autonomie changés) ne doit pas terminer le tour en cours : ses derniers événements sont ignorés.
 */
const generations = new Map<string, number>();
const nextGeneration = (id: string) => {
  const generation = (generations.get(id) ?? 0) + 1;
  generations.set(id, generation);
  return generation;
};
/** Attentes de fin de tour, pour les pages qui lancent un agent et en attendent la réponse. */
const turnWaiters = new Map<string, Array<(turn: Turn) => void>>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Conversations dont le dernier enregistrement a échoué : retentées par `retrySave` et à la fermeture. */
const failedSaves = new Set<string>();
/** Tours en train de se terminer : deux signaux de fin rapprochés ne doivent donner qu’un commit. */
const finishing = new Set<string>();
/** Conversations dont l’utilisateur a demandé l’interruption : le prochain tour terminé est « annulé ». */
const cancelRequested = new Set<string>();
/** Dernier signe du CLI pour le tour en cours de chaque conversation, pour la surveillance du silence. */
const lastEventAt = new Map<string, number>();
/**
 * Sessions ouvertes en reprenant une session du harnais, tant que la reprise n’est pas confirmée par un premier
 * événement. Une reprise refusée (session introuvable dans le CLI) est rattrapée par une session neuve ; les erreurs
 * reçues d’ici là sont retenues.
 */
const resuming = new Map<string, { errors: string[] }>();
/** Notifications déjà montrées, une par tour et par sorte, comme dans OneApp. */
const announced = new Set<string>();

/** Durée de repos après laquelle la session CLI d’une conversation est fermée pour libérer son processus. */
export const IDLE_SESSION_MS = 10 * 60_000;
/** Annonces regroupées pendant une réponse : au plus une mise à jour toutes les 120 ms (8 rendus par seconde). */
const STREAM_INTERVAL_MS = 120;
const SELECTED_KEY = "alfred.agents.selected";
const LOAD_ERROR =
  "Impossible de charger les conversations enregistrées. Vos données sont conservées ; réessayez le chargement.";
const INTERRUPTED_AT_CLOSE =
  "Cette tâche a été interrompue à la fermeture d’Alfred. Reprenez-la explicitement pour continuer.";

const newId = (): string => crypto.randomUUID();
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function signature(conversation: Conversation) {
  return [conversation.provider, conversation.model, conversation.effort, conversation.autonomy, conversation.cwd].join(
    "|",
  );
}

/** Consignes données au harnais, hors du fil : où est l’espace et où lire les règles de construction. */
function instructions(spaceDir: string) {
  return [
    "Tu es Alfred, le majordome de l’utilisateur : tu mets en place pour lui pages, panneaux et fonctions dans son espace.",
    "Parle-lui comme un majordome posé et serviable : à la première personne, en le vouvoyant, sans jargon technique, sans parler de toi comme d’une application ou d’un agent. Propose de mettre en place ce dont il a besoin plutôt que d’expliquer l’outil. Tes réponses sont lues à voix haute : des phrases courtes et naturelles à l’oral.",
    `Son espace est le dossier ${spaceDir} : pages, panneaux, fonctions et clients y sont rangés par module.`,
    // Le séparateur du dossier est repris : un chemin Windows reste en barres inverses.
    `Avant de créer ou de modifier quoi que ce soit dans l’espace, lis ${spaceDir}${spaceDir.includes("\\") ? "\\" : "/"}AGENTS.md et suis-le.`,
    "Les outils « alfred » servent à placer une page, vérifier qu’elle compile, lire ses erreurs et interroger la base.",
    "Réponds en français.",
  ].join("\n");
}

/** En-tête d’une conversation ; le statut du dernier tour y reste, pour la liste et la pastille du menu. */
function withoutTurns(conversation: Conversation): ConversationHeader {
  const { turns: _turns, ...header } = conversation;
  return header;
}

function rememberSelected(id: string | null) {
  try {
    if (id) sessionStorage.setItem(SELECTED_KEY, id);
    else sessionStorage.removeItem(SELECTED_KEY);
  } catch {
    // Stockage indisponible : la conversation ouverte n’est simplement pas retenue.
  }
}

function rememberedSelected(): string | null {
  try {
    return sessionStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

let backgroundStarted = false;

/** Rouages internes du magasin, pour les questions des outils d’Alfred et les tests. */
interface Engine {
  flushStream: () => void;
  releaseIdleSessions: (idleMs: number, now?: number) => Promise<number>;
  checkSilence: () => void;
  announce: (
    kind: "attention" | "done" | "error",
    id: string,
    notification: { title: string; description?: string; source?: string },
  ) => void;
  reset: () => void;
}
let engine: Engine;

export const useAgents = create<AgentState>((set, get) => {
  /*
   * Annonces regroupées, reprises de OneApp : un changement isolé est annoncé tout de suite ; pendant un flux
   * (fragments de réponse, activités), les suivants attendent au plus 120 ms. Sans cela, chaque fragment recopie le
   * relevé et redessine la page, et la saisie de l’utilisateur ralentit dès qu’un agent travaille.
   */
  const pendingStream = new Map<string, Conversation>();
  let streamTimer: ReturnType<typeof setTimeout> | undefined;

  /** État le plus récent d’une conversation, annonces retenues comprises. */
  const current = (id: string): Conversation | undefined => pendingStream.get(id) ?? get().loaded[id];

  const commit = (conversations: Conversation[]) => {
    if (!conversations.length) return;
    const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
    set((state) => ({
      loaded: { ...state.loaded, ...Object.fromEntries(byId) },
      headers: state.headers.map((header) => {
        const next = byId.get(header.id);
        return next ? withoutTurns(next) : header;
      }),
    }));
  };

  const flushStream = () => {
    if (!pendingStream.size) return;
    const pending = [...pendingStream.values()];
    pendingStream.clear();
    commit(pending);
  };

  const settleStream = () => {
    streamTimer = undefined;
    if (!pendingStream.size) return;
    flushStream();
    streamTimer = setTimeout(settleStream, STREAM_INTERVAL_MS);
  };

  const patchConversation = (
    id: string,
    change: (conversation: Conversation) => Conversation,
    options: { stream?: boolean } = {},
  ) => {
    const base = current(id);
    if (!base) return;
    const changed = change(base);
    const next = { ...changed, lastStatus: changed.turns.at(-1)?.status };
    if (options.stream && streamTimer) pendingStream.set(id, next);
    else {
      pendingStream.delete(id);
      flushStream();
      commit([next]);
      if (options.stream) streamTimer = setTimeout(settleStream, STREAM_INTERVAL_MS);
    }
    scheduleSave(id);
  };

  const patchTurn = (id: string, change: (turn: Turn) => Turn, options: { stream?: boolean } = {}) =>
    patchConversation(
      id,
      (conversation) => {
        const turns = [...conversation.turns];
        const last = turns.at(-1);
        if (!last) return conversation;
        turns[turns.length - 1] = change(last);
        return { ...conversation, turns };
      },
      options,
    );

  const patchRuntime = (id: string, change: (runtime: ConversationRuntime) => ConversationRuntime) =>
    set((state) => ({ runtime: { ...state.runtime, [id]: change(state.runtime[id] ?? idleRuntime) } }));

  /** Enregistre une conversation ; rien tant que le chargement a échoué, pour ne pas écrire par-dessus l’historique. */
  const save = async (id: string): Promise<boolean> => {
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    if (get().loadError) return false;
    flushStream();
    const conversation = get().loaded[id];
    if (!conversation) {
      failedSaves.delete(id);
      return true;
    }
    try {
      await invoke("conversations.save", { conversation: compactForStorage(conversation) });
      failedSaves.delete(id);
      if (!failedSaves.size && get().saveError) set({ saveError: undefined });
      return true;
    } catch (error) {
      failedSaves.add(id);
      // La cause native est gardée : sans elle, l’échec ne peut pas être diagnostiqué.
      set({ saveError: `Les conversations n’ont pas pu être enregistrées : ${message(error)}` });
      return false;
    }
  };

  function scheduleSave(id: string) {
    if (saveTimers.has(id)) return;
    saveTimers.set(
      id,
      setTimeout(() => void save(id), 1500),
    );
  }

  const upsertItem = (items: TurnItem[], item: TurnItem): TurnItem[] => {
    const index = items.findIndex((candidate) => candidate.id === item.id && candidate.kind === item.kind);
    if (index < 0) return [...items, item];
    const next = [...items];
    next[index] = item;
    return next;
  };

  const isViewed = (id: string) => get().activeId === id && useShell.getState().view.kind === "agent";

  /** Notification d’Alfred, une seule par tour et par sorte ; son bouton ouvre la conversation. */
  const announce = (
    kind: "attention" | "done" | "error",
    id: string,
    notification: { title: string; description?: string; source?: string },
  ) => {
    const conversation = current(id);
    const key = `${kind}:${id}:${conversation?.turns.at(-1)?.id ?? ""}`;
    if (!conversation || conversation.archived || announced.has(key)) return;
    announced.add(key);
    notify({
      ...notification,
      tone: kind === "attention" ? "warning" : kind === "done" ? "success" : "error",
      // Une réponse attendue reste affichée : elle bloque l’agent tant que l’utilisateur ne l’a pas vue.
      persistent: kind === "attention",
      action: { label: kind === "attention" ? "Répondre" : "Ouvrir", run: () => void get().show(id) },
    });
  };

  /** Notification du système, une seule par tour et par sorte. */
  const announceSystem = (kind: string, id: string, title: string, body?: string) => {
    const conversation = current(id);
    const key = `system-${kind}:${id}:${conversation?.turns.at(-1)?.id ?? ""}`;
    if (!conversation || conversation.archived || announced.has(key)) return;
    announced.add(key);
    void notifySystem(title, body);
  };

  const finishTurn = async (id: string, status: Turn["status"]) => {
    flushStream();
    const conversation = current(id);
    const turn = conversation?.turns.at(-1);
    if (!conversation || !turn || turn.status !== "running" || finishing.has(turn.id)) return;
    finishing.add(turn.id);
    resuming.delete(id);
    lastEventAt.delete(id);
    if (cancelRequested.delete(id) && status === "done") status = "cancelled";
    patchRuntime(id, (runtime) => ({ ...runtime, status: "idle", approvals: [], questions: [] }));
    // Ce que l’agent a écrit dans l’espace devient un commit : c’est ce qui rend le tour annulable.
    let commitId: string | undefined;
    let changedFiles: string[] | undefined;
    let changedLines: Turn["changedLines"];
    try {
      const result = await invoke<{ commit: string | null }>("space.commit", {
        message: turnCommitMessage(conversation.title, turn.user.text),
      });
      if (result.commit) {
        commitId = result.commit;
        const [latest] = await invoke<Commit[]>("space.history", { limit: 1 });
        if (latest?.id === commitId) {
          changedFiles = latest.files;
          changedLines = Object.fromEntries(
            latest.files.flatMap((file, index) => {
              const lines = latest.lines?.[index];
              return lines ? [[file, lines]] : [];
            }),
          );
        }
      }
    } catch {
      // Un espace sans dépôt utilisable n’empêche pas la conversation de se terminer.
    }
    const viewed = isViewed(id);
    patchConversation(id, (latest) => {
      const turns = [...latest.turns];
      const last = turns.at(-1);
      if (!last) return latest;
      const finished = {
        ...last,
        status,
        endedAt: Date.now(),
        ...(commitId ? { commit: commitId, changedFiles, changedLines } : {}),
      };
      turns[turns.length - 1] = finished;
      return {
        ...latest,
        turns,
        updatedAt: Date.now(),
        unread: !viewed,
        preview: plainText(lastAssistantText(finished)).slice(0, 200) || latest.preview,
      };
    });
    await save(id);
    const finished = get().loaded[id]?.turns.at(-1);
    if (finished) {
      for (const resolve of turnWaiters.get(id) ?? []) resolve(finished);
      turnWaiters.delete(id);
    }
    // Le message suivant de la file part aussitôt : seule la fin du dernier tour est annoncée.
    const [next, ...rest] = get().runtime[id]?.queued ?? [];
    if (next && (get().runtime[id]?.status ?? "idle") === "idle") {
      patchRuntime(id, (runtime) => ({ ...runtime, queued: rest }));
      void startTurn(id, next.message, next.id).catch(() => undefined);
      return;
    }
    // La réponse à une demande dictée est lue, si la voix le prévoit ; un tour suivant dicté la coupera.
    if (finished?.user.spoken && status === "done") {
      const reply = plainText(lastAssistantText(finished));
      const voice = useVoice.getState().status;
      if (reply && voice?.enabled !== false && voice?.readReplies !== false) void useVoice.getState().read(reply);
    }
    const title = get().loaded[id]?.title ?? conversation.title;
    if (finished && status !== "cancelled") {
      announceSystem(
        status === "error" ? "error" : "done",
        id,
        status === "error" ? `${title} : je me suis arrêté sur une erreur` : `${title} : c’est fait`,
        plainText(lastAssistantText(finished)) || undefined,
      );
    }
    if (!viewed && finished) {
      // Un tour arrêté que l’utilisateur n’a pas vu compte comme un échec, comme dans OneApp.
      const failed = status === "error" || status === "cancelled";
      announce(failed ? "error" : "done", id, {
        title:
          status === "error"
            ? `${title} : je me suis arrêté sur une erreur`
            : status === "cancelled"
              ? `${title} : je me suis arrêté`
              : title,
        description: finished.error ?? plainText(lastAssistantText(finished)).slice(0, 160),
        source: PROVIDER_LABEL[conversation.provider],
      });
    }
  };

  /** Ferme la session d’une conversation : ses derniers événements sont ignorés, le prochain message en rouvre une. */
  const dropSession = async (id: string) => {
    const live = sessions.get(id);
    sessions.delete(id);
    resuming.delete(id);
    nextGeneration(id);
    await live?.session.close().catch(() => undefined);
  };

  /** Arrêt d’un tour par la surveillance du silence : le CLI muet est fermé, le tour finit en erreur. */
  const failSilent = (id: string, reason: string) => {
    void dropSession(id);
    patchTurn(id, (turn) => ({ ...turn, error: reason }));
    void finishTurn(id, "error");
  };

  const silenceWatch = createSilenceWatch({
    running: () =>
      Object.values(get().loaded).flatMap((conversation): WatchedTurn[] => {
        const latest = current(conversation.id) ?? conversation;
        const turn = latest.turns.at(-1);
        if (turn?.status !== "running") return [];
        const runtime = get().runtime[latest.id];
        return [
          {
            id: latest.id,
            turn,
            lastEventAt: lastEventAt.get(latest.id) ?? turn.startedAt,
            waitingForUser: Boolean(runtime?.approvals.length || runtime?.questions.length),
          },
        ];
      }),
    fail: failSilent,
  });

  /** Une reprise refusée par le CLI : la session est remplacée par une neuve qui rejoue l’historique. */
  const restartFresh = async (id: string) => {
    await dropSession(id);
    patchConversation(id, (conversation) => ({ ...conversation, sessionId: undefined }));
    const conversation = current(id);
    const turn = conversation?.turns.at(-1);
    if (!conversation || turn?.status !== "running") return;
    try {
      const session = await ensureSession(conversation, turn.id);
      await session.send(outgoingText(turn.user), turn.user.attachments, turn.id);
    } catch (error) {
      patchTurn(id, (latest) => ({ ...latest, error: message(error) }));
      await finishTurn(id, "error");
    }
  };

  const onEvent = (id: string, generation: number) => (event: HarnessEvent) => {
    if (generations.get(id) !== generation) return;
    lastEventAt.set(id, Date.now());
    const pendingResume = resuming.get(id);
    if (pendingResume) {
      if (event.type === "error") {
        pendingResume.errors.push(event.message);
        return;
      }
      if (event.type === "status" && (event.status === "closed" || event.status === "idle")) {
        const turn = current(id)?.turns.at(-1);
        if (
          turn?.status === "running" &&
          !turn.items.length &&
          (event.status === "closed" || pendingResume.errors.length)
        ) {
          void restartFresh(id);
          return;
        }
      }
      if (event.type !== "status" || event.status === "idle" || event.status === "closed") {
        // Reprise confirmée (ou tour fini) : les erreurs retenues reviennent au tour.
        resuming.delete(id);
        const [error] = pendingResume.errors.slice(-1);
        if (error) patchTurn(id, (turn) => ({ ...turn, error }));
      }
    }
    switch (event.type) {
      case "session":
        patchConversation(id, (conversation) => ({ ...conversation, sessionId: event.sessionId }));
        return;
      case "status":
        if (event.status === "responding" || event.status === "connecting")
          patchRuntime(id, (runtime) => ({
            ...runtime,
            status: event.status === "connecting" ? "connecting" : "responding",
          }));
        else if (event.status === "idle") {
          const turn = current(id)?.turns.at(-1);
          void finishTurn(id, turn?.error ? "error" : "done");
        } else if (event.status === "closed") {
          sessions.delete(id);
          void finishTurn(id, "error");
          patchRuntime(id, (runtime) => ({ ...runtime, status: "idle" }));
        }
        return;
      case "message":
        patchTurn(
          id,
          (turn) => {
            const existing = turn.items.find((item) => item.kind === "message" && item.id === event.itemId);
            const content =
              event.replace || !existing ? event.content : (existing as { content: string }).content + event.content;
            return { ...turn, items: upsertItem(turn.items, { kind: "message", id: event.itemId, content }) };
          },
          { stream: true },
        );
        return;
      case "activity":
        patchTurn(
          id,
          (turn) => {
            const previous = turn.items.find((item) => item.kind === "activity" && item.id === event.itemId);
            const kept = previous?.kind === "activity" ? previous : undefined;
            const content = event.content ?? kept?.content;
            return {
              ...turn,
              items: upsertItem(turn.items, {
                kind: "activity",
                id: event.itemId,
                activityKind: event.kind,
                title: event.title,
                detail: event.detail ?? kept?.detail,
                actions: event.actions ?? kept?.actions,
                content: content === undefined ? undefined : boundedActivityContent(content, event.kind),
                images: event.images ?? kept?.images,
                files: event.files ?? kept?.files,
                status: event.status,
              }),
            };
          },
          { stream: true },
        );
        return;
      case "activityDelta":
        patchTurn(
          id,
          (turn) => {
            const previous = turn.items.find((item) => item.kind === "activity" && item.id === event.itemId);
            const base: Extract<TurnItem, { kind: "activity" }> =
              previous?.kind === "activity"
                ? previous
                : { kind: "activity", id: event.itemId, activityKind: "analysis", title: "Analyse", status: "running" };
            const content = boundedActivityContent((base.content ?? "") + event.content, base.activityKind);
            return { ...turn, items: upsertItem(turn.items, { ...base, content }) };
          },
          { stream: true },
        );
        return;
      case "approval": {
        patchRuntime(id, (runtime) => ({ ...runtime, approvals: [...runtime.approvals, event.request] }));
        const title = current(id)?.title ?? "Alfred";
        announceSystem("attention", id, `${title} : j’attends votre accord`, event.request.title);
        if (!isViewed(id))
          announce("attention", id, { title: `${title} : j’attends votre accord`, description: event.request.title });
        return;
      }
      case "approvalClosed":
        patchRuntime(id, (runtime) => ({
          ...runtime,
          approvals: runtime.approvals.filter((approval: ApprovalRequest) => approval.id !== event.id),
        }));
        return;
      case "error":
        patchTurn(id, (turn) => ({ ...turn, error: event.message }));
        return;
    }
  };

  const deliveries = new Map<string, Promise<void>>();

  /**
   * « Envoyer maintenant », comme dans OneApp : glissé dans la réponse en cours quand l’agent sait le faire (Codex),
   * sinon la réponse est interrompue et le message part en tête de file, aussitôt après.
   */
  const deliverNow = async (id: string, queuedId: string) => {
    const queued = get().runtime[id]?.queued.find((item) => item.id === queuedId);
    if (!queued) return;
    const running = current(id)?.turns.at(-1)?.status === "running";
    const live = sessions.get(id)?.session;
    if (!running && (get().runtime[id]?.status ?? "idle") === "idle") {
      patchRuntime(id, (runtime) => ({ ...runtime, queued: runtime.queued.filter((item) => item.id !== queuedId) }));
      await startTurn(id, queued.message, queued.id);
      return;
    }
    if (running && live?.steer && get().runtime[id]?.status === "responding") {
      const turn: Turn = { id: queued.id, user: queued.message, items: [], status: "running", startedAt: Date.now() };
      try {
        await live.steer(outgoingText(queued.message), queued.message.attachments, turn.id);
        if (!get().runtime[id]?.queued.some((item) => item.id === queuedId)) return;
        // Le tour orienté se termine ici ; la suite de la réponse appartient au nouveau message.
        patchRuntime(id, (runtime) => ({ ...runtime, queued: runtime.queued.filter((item) => item.id !== queuedId) }));
        patchConversation(id, (latest) => ({
          ...latest,
          turns: [
            ...latest.turns.map((item, index) =>
              index === latest.turns.length - 1 && item.status === "running"
                ? { ...item, status: "done" as const, endedAt: Math.max(item.startedAt, Date.now()) }
                : item,
            ),
            turn,
          ],
          updatedAt: Date.now(),
        }));
        lastEventAt.set(id, Date.now());
        return;
      } catch {
        // L’agent refuse d’orienter sa réponse : elle est interrompue, puis le message part.
      }
    }
    if (!get().runtime[id]?.queued.some((item) => item.id === queuedId)) return;
    patchRuntime(id, (runtime) => ({
      ...runtime,
      queued: [queued, ...runtime.queued.filter((item) => item.id !== queuedId)],
    }));
    await get().cancel(id);
  };

  /** Consignes de la session : celles d’Alfred, la question bloquante, et l’historique quand la session est neuve. */
  const sessionInstructions = (conversation: Conversation, currentTurnId: string | undefined, replay: boolean) => {
    const spaceDir = useShell.getState().snapshot?.path;
    return (
      [
        spaceDir ? instructions(spaceDir) : "",
        QUESTION_INSTRUCTIONS,
        replay ? replayedHistory(conversation.turns, currentTurnId) : "",
      ]
        .filter(Boolean)
        .join("\n\n") || undefined
    );
  };

  /**
   * Session vivante de la conversation. La session du harnais est reprise quand elle existe ; sinon, ou si le CLI
   * refuse de la reprendre, une session neuve reçoit l’historique dans ses consignes, comme dans OneApp.
   */
  const ensureSession = async (conversation: Conversation, currentTurnId?: string): Promise<HarnessSession> => {
    const live = sessions.get(conversation.id);
    const wanted = signature(conversation);
    if (live && live.signature === wanted) return live.session;
    const generation = nextGeneration(conversation.id);
    if (live) {
      sessions.delete(conversation.id);
      await live.session.close().catch(() => undefined);
    }
    const shell = useShell.getState();
    const open = (resumeSessionId: string | undefined) =>
      createSession({
        provider: conversation.provider,
        cwd: conversation.cwd,
        spaceDir: shell.snapshot?.path,
        conversation: conversation.id,
        toolsUrl: shell.info ? `http://127.0.0.1:${shell.info.serverPort}/mcp` : undefined,
        model: conversation.model,
        effort: conversation.effort,
        instructions: sessionInstructions(conversation, currentTurnId, !resumeSessionId),
        resumeSessionId,
        autonomy: conversation.autonomy,
        title: conversation.title,
        onEvent: onEvent(conversation.id, generation),
      });
    let session: HarnessSession;
    if (conversation.sessionId) {
      try {
        session = await open(conversation.sessionId);
        // Codex et OpenCode refusent une reprise dès l’ouverture ; Claude Code ne la refuse qu’au premier message.
        if (conversation.provider === "claude") resuming.set(conversation.id, { errors: [] });
      } catch {
        // Session du harnais introuvable ou refusée : une session neuve repart de l’historique.
        patchConversation(conversation.id, (latest) => ({ ...latest, sessionId: undefined }));
        session = await open(undefined);
      }
    } else session = await open(undefined);
    sessions.set(conversation.id, { session, signature: wanted });
    return session;
  };

  /** Commence un tour : le message rejoint le fil et part dans la session de la conversation. */
  const startTurn = async (id: string, userMessage: UserMessage, turnId = newId()) => {
    const conversation = current(id);
    if (!conversation) return;
    const first = conversation.turns.length === 0;
    const turn: Turn = { id: turnId, user: userMessage, items: [], status: "running", startedAt: Date.now() };
    patchConversation(id, (latest) => {
      const title =
        first && latest.title === "Nouvelle conversation" ? conversationTitle(userMessage.text) : latest.title;
      const siblings = get()
        .headers.filter((header) => header.id !== id && header.started)
        .map((header) => header.title);
      return {
        ...latest,
        title,
        // Un titre générique, tronqué ou en double est confié au modèle de nommage, comme dans OneApp.
        ...(first && !latest.forkedFrom && needsAutoTitle(title, siblings) ? { autoTitle: true } : {}),
        turns: [...latest.turns, turn],
        started: true,
        updatedAt: Date.now(),
      };
    });
    patchRuntime(id, (runtime) => ({ ...runtime, status: "connecting" }));
    lastEventAt.set(id, Date.now());
    silenceWatch.start();
    try {
      const session = await ensureSession(current(id) ?? conversation, turn.id);
      await session.send(outgoingText(userMessage), userMessage.attachments, turn.id);
    } catch (error) {
      patchTurn(id, (latest) => ({ ...latest, error: message(error) }));
      await finishTurn(id, "error");
    }
  };

  /** Ferme les CLI de toutes les conversations (fermeture de la fenêtre). */
  const closeAllSessions = () => Promise.all([...sessions.keys()].map((id) => dropSession(id)));

  /** Tâches de fond, lancées au premier chargement : libération des CLI au repos, nommage, fermeture de la fenêtre. */
  const startBackground = () => {
    if (backgroundStarted) return;
    backgroundStarted = true;
    // Une conversation qui a fini depuis longtemps libère son CLI ; son prochain message rouvre une session.
    setInterval(() => void releaseIdleSessions(IDLE_SESSION_MS).catch(() => undefined), 60_000);
    watchConversationTitles(
      {
        candidates: () =>
          Object.values(get().loaded)
            .filter((conversation) => conversation.autoTitle && !conversation.archived)
            .map((conversation) => ({ id: conversation.id, firstMessage: conversation.turns[0]?.user.text })),
        stillWanted: (id) => Boolean(current(id)?.autoTitle),
        setTitle: async (id, title) => {
          const next = cleanConversationTitle(title);
          if (!next) return;
          patchConversation(id, (conversation) => ({ ...conversation, title: next, autoTitle: undefined }));
          await save(id);
        },
        model: () => titlingModel(get().defaults, get().titling),
        subscribe: (listener) => useAgents.subscribe(listener),
      },
      async (prompt, model, timeoutMs) => (await import("./oneShot")).complete(prompt, model, timeoutMs),
    );
    void bindMainWindowClose({ save: () => get().flush(), stopSessions: closeAllSessions }).catch(() => undefined);
  };

  /**
   * Ferme le CLI des conversations au repos depuis `idleMs` ; leur prochain message rouvre une session. Une
   * conversation au travail, qui attend une réponse ou dont la file n’est pas vide garde la sienne.
   */
  const releaseIdleSessions = async (idleMs: number, now = Date.now()) => {
    const idle = [...sessions.keys()].filter((id) => {
      const conversation = current(id);
      const runtime = get().runtime[id] ?? idleRuntime;
      return (
        conversation &&
        runtime.status === "idle" &&
        !runtime.approvals.length &&
        !runtime.questions.length &&
        !runtime.queued.length &&
        conversation.turns.at(-1)?.status !== "running" &&
        now - conversation.updatedAt >= idleMs
      );
    });
    await Promise.all(idle.map((id) => dropSession(id)));
    return idle.length;
  };

  engine = {
    flushStream,
    releaseIdleSessions,
    checkSilence: () => silenceWatch.check(),
    announce,
    reset: () => {
      pendingStream.clear();
      clearTimeout(streamTimer);
      streamTimer = undefined;
      silenceWatch.stop();
    },
  };

  return {
    headers: [],
    loaded: {},
    runtime: {},
    activeId: null,
    defaults: DEFAULTS,
    ready: false,
    follow: {},

    async load() {
      let headers: ConversationHeader[];
      let defaults: AgentDefaults | null;
      let titling: TitlingModel | null;
      try {
        const [list, saved, savedTitling] = await Promise.all([
          invoke<unknown>("conversations.list"),
          invoke<AgentDefaults | null>("settings.get", { key: "agents.defaults" }),
          invoke<TitlingModel | null>("settings.get", { key: "agents.titling" }),
        ]);
        headers = validateHeaders(list);
        defaults = saved;
        titling = savedTitling ?? null;
      } catch {
        set({ loadError: LOAD_ERROR });
        return;
      }
      const showing = useShell.getState().view.kind === "agent" && !get().activeId;
      let selected: string | undefined;
      set((state) => {
        // Une conversation déjà chargée garde son état vivant ; un tour resté « en cours » sur le disque est arrêté.
        const known = new Set(headers.map((header) => header.id));
        const unsaved = Object.values(state.loaded)
          .filter((conversation) => !known.has(conversation.id))
          .map(withoutTurns);
        const merged = [
          ...unsaved,
          ...headers.map((header) => {
            const live = state.loaded[header.id];
            if (live) return withoutTurns(live);
            return header.lastStatus === "running" ? { ...header, lastStatus: "cancelled" as const } : header;
          }),
        ];
        // La conversation ouverte est retenue pour la session, sinon c’est la plus récente, comme dans OneApp.
        if (showing) {
          const visible = merged.filter((header) => !header.archived && header.started);
          const remembered = rememberedSelected();
          selected =
            visible.find((header) => header.id === remembered)?.id ??
            [...visible].sort((left, right) => right.createdAt - left.createdAt)[0]?.id;
        }
        return {
          headers: merged,
          defaults: { ...DEFAULTS, ...(defaults ?? {}) },
          titling,
          ready: true,
          loadError: undefined,
          ...(selected ? { activeId: selected } : {}),
        };
      });
      startBackground();
      if (selected) await get().open(selected);
    },

    retryLoad() {
      return get().load();
    },

    async retrySave() {
      await get()
        .flush()
        .catch(() => undefined);
    },

    async flush() {
      flushStream();
      const ids = new Set([...saveTimers.keys(), ...failedSaves]);
      await Promise.all([...ids].map((id) => save(id)));
      const { saveError } = get();
      if (saveError) throw new Error(saveError);
    },

    async setDefaults(defaults) {
      set({ defaults });
      await invoke("settings.set", { key: "agents.defaults", value: defaults });
    },

    async open(id) {
      set({ activeId: id });
      rememberSelected(id);
      if (!id) return;
      await get().ensureLoaded(id);
      if (current(id)?.unread) patchConversation(id, (conversation) => ({ ...conversation, unread: false }));
    },

    async show(id) {
      useShell.getState().setView({ kind: "agent" });
      await get().open(id);
    },

    async ensureLoaded(id) {
      if (current(id)) return;
      let conversation: Conversation;
      try {
        const saved = await invoke<unknown>("conversations.get", { id });
        if (saved === null || saved === undefined) return;
        conversation = validateConversation(saved);
      } catch (error) {
        set({ loadError: error instanceof Error && /invalide/.test(error.message) ? error.message : LOAD_ERROR });
        return;
      }
      if (current(id)) return;
      // Un tour resté « en cours » vient d’une fermeture d’Alfred au milieu d’une réponse.
      const turns = conversation.turns.map((turn) =>
        turn.status === "running"
          ? {
              ...turn,
              status: "cancelled" as const,
              endedAt: turn.endedAt ?? Date.now(),
              error: turn.error ?? INTERRUPTED_AT_CLOSE,
            }
          : turn,
      );
      const restored = { ...conversation, turns, lastStatus: turns.at(-1)?.status };
      set((state) => ({
        loaded: { ...state.loaded, [id]: restored },
        headers: state.headers.map((header) => (header.id === id ? withoutTurns(restored) : header)),
      }));
    },

    create(options = {}) {
      const { defaults } = get();
      const provider = options.provider ?? defaults.provider;
      const preset = defaults.models[provider] ?? {};
      const now = Date.now();
      const conversation: Conversation = {
        id: newId(),
        title: (options.title && cleanConversationTitle(options.title)) || "Nouvelle conversation",
        provider,
        model: options.model ?? preset.model,
        effort: options.effort ?? preset.effort,
        cwd: options.cwd ?? useShell.getState().snapshot?.path ?? "",
        autonomy: options.autonomy ?? defaults.autonomy,
        createdAt: now,
        updatedAt: now,
        archived: false,
        unread: false,
        started: false,
        ...(options.origin ? { origin: options.origin } : {}),
        turns: [],
      };
      set((state) => ({
        loaded: { ...state.loaded, [conversation.id]: conversation },
        headers: [withoutTurns(conversation), ...state.headers],
      }));
      return conversation;
    },

    update(id, patch) {
      patchConversation(id, (conversation) => ({ ...conversation, ...patch }));
    },

    async rename(id, title) {
      const next = cleanConversationTitle(title);
      if (!next) return;
      await get().ensureLoaded(id);
      // Un renommage manuel l’emporte sur le nommage automatique, même en cours.
      patchConversation(id, (conversation) => ({ ...conversation, title: next, autoTitle: undefined }));
      await save(id);
    },

    async archive(id) {
      await get().ensureLoaded(id);
      patchRuntime(id, (runtime) => ({ ...runtime, queued: [] }));
      const busy = (get().runtime[id]?.status ?? "idle") !== "idle" || current(id)?.turns.at(-1)?.status === "running";
      if (busy) await get().cancel(id);
      // Archivée, elle n’est plus « à consulter » ; une session au repos libère son CLI, comme dans OneApp.
      patchConversation(id, (conversation) => ({
        ...conversation,
        archived: true,
        archivedAt: Date.now(),
        unread: false,
      }));
      if (!busy) void dropSession(id);
      if (get().activeId === id) {
        set({ activeId: null });
        rememberSelected(null);
      }
      await save(id);
    },

    async unarchive(id) {
      await get().ensureLoaded(id);
      // Rendue visible sans être signalée « à consulter », comme dans OneApp.
      patchConversation(id, ({ archivedAt: _archivedAt, ...conversation }) => ({
        ...conversation,
        archived: false,
        unread: false,
      }));
      await save(id);
    },

    async markUnread(id) {
      await get().ensureLoaded(id);
      patchConversation(id, (conversation) => ({ ...conversation, unread: true }));
      await save(id);
      // La conversation ouverte se lirait aussitôt : la page Agent passe à une autre, ou à un brouillon.
      if (get().activeId === id) {
        const other = get().headers.find((header) => header.id !== id && header.started && !header.archived);
        await get().open(other?.id ?? get().create().id);
      }
    },

    async send(id, input, options) {
      const conversation = current(id);
      if (!conversation) return;
      const prepared = preparedMessage(input);
      const runtime = get().runtime[id] ?? idleRuntime;
      const messageId = options?.messageId;
      if (
        messageId &&
        (conversation.turns.some((turn) => turn.id === messageId) ||
          runtime.queued.some((item) => item.id === messageId))
      )
        return;
      const busy = runtime.status !== "idle" || conversation.turns.at(-1)?.status === "running";
      if (busy && runtime.queued.length >= MAX_QUEUED_MESSAGES)
        throw new Error(`La file contient déjà ${MAX_QUEUED_MESSAGES} messages.`);
      // Le relevé se recolle en bas pour montrer le message envoyé.
      set((state) => ({ follow: { ...state.follow, [id]: (state.follow[id] ?? 0) + 1 } }));
      if (busy) {
        const queuedId = messageId ?? newId();
        patchRuntime(id, (latest) => ({ ...latest, queued: [...latest.queued, { id: queuedId, message: prepared }] }));
        if (options?.now) await get().sendQueuedNow(id, queuedId);
        return;
      }
      await startTurn(id, prepared, messageId);
    },

    async retry(id) {
      const last = current(id)?.turns.at(-1);
      if (!last || (last.status !== "error" && last.status !== "cancelled")) return;
      await get().send(id, last.user);
    },

    async resend(id, turnId) {
      const turn = current(id)?.turns.find((candidate) => candidate.id === turnId);
      if (!turn) throw new Error("Ce message n’existe plus.");
      await get().send(id, structuredClone(turn.user));
    },

    async fork(id, turnId, from = "reply") {
      await get().ensureLoaded(id);
      const source = current(id);
      const index = source?.turns.findIndex((turn) => turn.id === turnId) ?? -1;
      if (!source || index < 0) throw new Error("Ce message n’existe plus.");
      const history = structuredClone(source.turns.slice(0, from === "user" ? index : index + 1)).map((turn) =>
        turn.status === "running" ? { ...turn, status: "cancelled" as const, endedAt: Date.now() } : turn,
      );
      const created = get().create({
        provider: source.provider,
        model: source.model,
        effort: source.effort,
        cwd: source.cwd,
        autonomy: source.autonomy,
        title: `${source.title} · reprise`,
        ...(source.origin ? { origin: source.origin } : {}),
      });
      // La session du harnais d’origine n’est pas copiée : la première session reçoit cet historique.
      patchConversation(created.id, (conversation) => ({
        ...conversation,
        turns: history,
        started: true,
        forkedFrom: { id: source.id, title: source.title },
      }));
      await save(created.id);
      await get().open(created.id);
      notify({
        title: "Nouvelle conversation",
        description: `Reprise de ${source.title} à partir de ce message.`,
        tone: "success",
      });
      return { id: created.id, ...(from === "user" ? { draft: structuredClone(source.turns[index].user) } : {}) };
    },

    reorderQueued(id, queuedIds) {
      const queue = get().runtime[id]?.queued ?? [];
      const byId = new Map(queue.map((item) => [item.id, item]));
      const ordered = queuedIds.flatMap((queuedId) => byId.get(queuedId) ?? []);
      if (ordered.length !== queue.length || new Set(ordered).size !== queue.length) return;
      patchRuntime(id, (runtime) => ({ ...runtime, queued: ordered }));
    },

    moveQueued(id, queuedId, offset) {
      const queue = [...(get().runtime[id]?.queued ?? [])];
      const index = queue.findIndex((item) => item.id === queuedId);
      if (index < 0 || index + offset < 0 || index + offset >= queue.length) return;
      [queue[index], queue[index + offset]] = [queue[index + offset], queue[index]];
      patchRuntime(id, (runtime) => ({ ...runtime, queued: queue }));
    },

    sendQueuedNow(id, queuedId) {
      // Un envoi immédiat à la fois par conversation : deux envois rapides partent dans l’ordre.
      const previous = deliveries.get(id) ?? Promise.resolve();
      const delivery = previous.catch(() => undefined).then(() => deliverNow(id, queuedId));
      deliveries.set(id, delivery);
      void delivery.finally(() => {
        if (deliveries.get(id) === delivery) deliveries.delete(id);
      });
      return delivery;
    },

    unqueue(id, queuedId) {
      const found = get().runtime[id]?.queued.find((item) => item.id === queuedId);
      if (found)
        patchRuntime(id, (runtime) => ({ ...runtime, queued: runtime.queued.filter((item) => item.id !== queuedId) }));
      return found?.message;
    },

    async cancel(id) {
      if (current(id)?.turns.at(-1)?.status === "running") cancelRequested.add(id);
      const live = sessions.get(id);
      await live?.session.cancel().catch(() => undefined);
      // Un harnais qui ne confirme pas l’interruption ne doit pas laisser le tour bloqué.
      setTimeout(() => {
        if (current(id)?.turns.at(-1)?.status === "running") void finishTurn(id, "cancelled");
      }, 4000);
    },

    async answerApproval(id, approvalId, optionId) {
      patchRuntime(id, (runtime) => ({
        ...runtime,
        approvals: runtime.approvals.filter((approval) => approval.id !== approvalId),
      }));
      await sessions.get(id)?.session.answer(approvalId, optionId);
    },

    async answerQuestion(id, requestId, result, error) {
      patchRuntime(id, (runtime) => ({
        ...runtime,
        questions: runtime.questions.filter((question) => question.requestId !== requestId),
      }));
      await invoke("ui.resolve", error ? { requestId, error } : { requestId, result });
    },

    async remove(id) {
      patchRuntime(id, (runtime) => ({ ...runtime, queued: [] }));
      await dropSession(id);
      pendingStream.delete(id);
      clearTimeout(saveTimers.get(id));
      saveTimers.delete(id);
      failedSaves.delete(id);
      await invoke("conversations.delete", { id });
      set((state) => {
        const { [id]: _removed, ...loaded } = state.loaded;
        return {
          loaded,
          headers: state.headers.filter((header) => header.id !== id),
          activeId: state.activeId === id ? null : state.activeId,
        };
      });
    },

    async undoTurn(id, turnId) {
      const turn = current(id)?.turns.find((candidate) => candidate.id === turnId);
      if (!turn?.commit) return;
      await invoke("space.undo", { commit: turn.commit });
      patchConversation(id, (conversation) => ({
        ...conversation,
        turns: conversation.turns.map((candidate) =>
          candidate.id === turnId
            ? { ...candidate, commit: undefined, changedFiles: undefined, changedLines: undefined }
            : candidate,
        ),
      }));
      notify({
        title: "Modification annulée",
        description: "L’espace est revenu à son état d’avant ce tour.",
        tone: "success",
      });
    },
  };
});

/** Modèle de nommage : celui des réglages, sinon le modèle par défaut. */
function titlingModel(defaults: AgentDefaults, titling: TitlingModel | null | undefined): TitlingModel {
  if (titling?.provider) return titling;
  return { provider: defaults.provider, ...(defaults.models[defaults.provider] ?? {}) };
}

/** Annonces retenues pendant une réponse, écrites tout de suite (tests, avant de lire le relevé). */
export function flushAgentUpdates() {
  engine.flushStream();
}

/** Ferme les CLI au repos depuis `idleMs` (10 min dans l’application) ; rend le nombre de sessions fermées. */
export function releaseIdleAgentSessions(idleMs = IDLE_SESSION_MS, now = Date.now()) {
  return engine.releaseIdleSessions(idleMs, now);
}

/** Passe de la surveillance du silence, faite d’elle-même toutes les 30 s pendant un tour. */
export function checkAgentSilence() {
  engine.checkSilence();
}

/** Pour les tests : oublie les annonces retenues et arrête la surveillance. */
export function resetAgentEngine() {
  engine.reset();
  announced.clear();
  lastEventAt.clear();
  resuming.clear();
}

/** Résout quand le tour en cours de la conversation se termine. */
export function waitForTurn(id: string): Promise<Turn> {
  return new Promise((resolve) => {
    turnWaiters.set(id, [...(turnWaiters.get(id) ?? []), resolve]);
  });
}

let questionsBound = false;

/** Relie les questions posées par les outils d’Alfred (emplacement d’une page) à leur conversation. */
export function bindAgentQuestions() {
  if (questionsBound) return;
  questionsBound = true;
  onNativeEvent("agent:question", (payload) => {
    const question = payload as {
      requestId: string;
      conversation: string;
      kind: AgentQuestion["kind"];
      payload: Record<string, unknown>;
    };
    const title = useAgents.getState().loaded[question.conversation]?.title ?? "Alfred";
    void notifySystem(
      `${title} : j’attends votre réponse`,
      question.kind === "placement" ? "Où dois-je placer la nouvelle page ?" : undefined,
    );
    useAgents.setState((state) => {
      const runtime = state.runtime[question.conversation] ?? idleRuntime;
      return {
        runtime: {
          ...state.runtime,
          [question.conversation]: {
            ...runtime,
            questions: [
              ...runtime.questions,
              { requestId: question.requestId, kind: question.kind, payload: question.payload },
            ],
          },
        },
      };
    });
    const { activeId, loaded } = useAgents.getState();
    if (activeId !== question.conversation || useShell.getState().view.kind !== "agent") {
      engine.announce("attention", question.conversation, {
        title: `${loaded[question.conversation]?.title ?? "Un agent"} a une question`,
        description: "Ouvrir la conversation pour lui répondre.",
      });
    }
  });
  // Une question tranchée ailleurs (autre fenêtre, délai dépassé) disparaît de toutes les conversations.
  onNativeEvent("ui:resolved", (payload) => {
    const { requestId } = payload as { requestId: string };
    useAgents.setState((state) => {
      const runtime = Object.fromEntries(
        Object.entries(state.runtime).map(([id, current]) => [
          id,
          current.questions.some((question) => question.requestId === requestId)
            ? { ...current, questions: current.questions.filter((question) => question.requestId !== requestId) }
            : current,
        ]),
      );
      return { runtime };
    });
  });
}
